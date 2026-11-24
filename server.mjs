import http from "node:http";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { PassThrough } from "node:stream";
import { createSegmentCache } from "./cache/segment-cache.mjs";

const PORT = Number(process.env.PORT || 18080);
const transfers = new Map();
const segmentCache = createSegmentCache({
  maxBytes: Number(process.env.CACHE_MAX_BYTES || 512 * 1024 * 1024),
  maxSegmentBytes: Number(process.env.CACHE_MAX_SEGMENT_BYTES || 16 * 1024 * 1024),
  defaultTtlMs: Number(process.env.CACHE_TTL_MS || 10 * 60 * 1000)
});


const pendingProxyRequests = new Map();
const proxyQueue = [];
const pollWaiters = [];
const PROXY_REQUEST_TIMEOUT_MS = Math.max(15_000, Number(process.env.PROXY_REQUEST_TIMEOUT_MS || 90_000));

const pendingDownloadRequests = new Map();
const downloadQueue = [];
const downloadPollWaiters = [];
const REVERSE_AGENT_TOKEN = process.env.REVERSE_AGENT_TOKEN || "";
const DOWNLOAD_PROXY_TIMEOUT_MS = Math.max(60_000, Number(process.env.DOWNLOAD_PROXY_TIMEOUT_MS || 600_000));

function tokenMatches(value) {
  if (!REVERSE_AGENT_TOKEN || REVERSE_AGENT_TOKEN.length < 32 || typeof value !== "string") return false;
  const expected = Buffer.from(REVERSE_AGENT_TOKEN);
  const received = Buffer.from(value);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

function jsonResponse(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store"
  });
  res.end(body);
}

function dispatchProxyJob(job, queue = proxyQueue, waiters = pollWaiters) {
  const waiter = waiters.shift();
  if (waiter) {
    clearTimeout(waiter.timer);
    waiter.resolve(job);
  } else {
    queue.push(job);
  }
}

async function handleDownloadAgentPoll(req, res) {
  let job = downloadQueue.shift() || null;
  if (!job) {
    job = await new Promise((resolve) => {
      const waiter = {
        resolve,
        timer: setTimeout(() => {
          const index = downloadPollWaiters.indexOf(waiter);
          if (index !== -1) downloadPollWaiters.splice(index, 1);
          resolve(null);
        }, 25_000)
      };
      downloadPollWaiters.push(waiter);
      res.once("close", () => {
        clearTimeout(waiter.timer);
        const index = downloadPollWaiters.indexOf(waiter);
        if (index !== -1) downloadPollWaiters.splice(index, 1);
        resolve(null);
      });
    });
  }
  if (res.destroyed || res.writableEnded) return;
  if (!job) {
    res.writeHead(204, { "cache-control": "no-store" });
    res.end();
    return;
  }
  jsonResponse(res, 200, job);
}

async function handleAgentPoll(req, res) {
  let job = proxyQueue.shift() || null;
  if (!job) {
    job = await new Promise((resolve) => {
      const waiter = {
        resolve,
        timer: setTimeout(() => {
          const index = pollWaiters.indexOf(waiter);
          if (index !== -1) pollWaiters.splice(index, 1);
          resolve(null);
        }, 25_000)
      };
      pollWaiters.push(waiter);
      res.once("close", () => {
        clearTimeout(waiter.timer);
        const index = pollWaiters.indexOf(waiter);
        if (index !== -1) pollWaiters.splice(index, 1);
        resolve(null);
      });
    });
  }
  if (res.destroyed || res.writableEnded) return;
  if (!job) {
    res.writeHead(204, { "cache-control": "no-store" });
    res.end();
    return;
  }
  jsonResponse(res, 200, job);
}

function safeResponseHeaders(input) {
  const allowed = new Set([
    "content-type", "content-range", "accept-ranges", "cache-control",
    "etag", "last-modified", "content-disposition", "content-length", "expires", "vary"
  ]);
  const output = {};
  for (const [name, value] of Object.entries(input || {})) {
    const key = String(name).toLowerCase();
    if (allowed.has(key) && typeof value === "string") output[key] = value;
  }
  return output;
}

function handleAgentResponse(req, res, requestId, pendingMap = pendingProxyRequests) {
  const pending = pendingMap.get(requestId);
  if (!pending || pending.res.destroyed || pending.res.writableEnded) {
    req.resume();
    res.writeHead(410);
    res.end("Proxy request expired");
    return;
  }
  let headers = {};
  try {
    const encoded = String(req.headers["x-upstream-headers"] || "");
    if (encoded) headers = safeResponseHeaders(JSON.parse(Buffer.from(encoded, "base64").toString("utf8")));
  } catch {
    req.resume();
    res.writeHead(400);
    res.end("Invalid upstream headers");
    return;
  }
  const status = Number(req.headers["x-upstream-status"] || 200);
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    req.resume();
    res.writeHead(400);
    res.end("Invalid upstream status");
    return;
  }
  clearTimeout(pending.timer);
  pending.res.writeHead(status, headers);
  pending.res.once("close", () => {
    if (!pending.res.writableEnded && !req.destroyed) req.destroy();
  });
  req.on("error", (error) => {
    pendingMap.delete(requestId);
    if (!pending.res.destroyed) pending.res.destroy(error);
    if (!res.headersSent) {
      res.writeHead(502);
      res.end("Response stream failed");
    }
  });
  req.on("end", () => {
    pendingMap.delete(requestId);
    if (!res.headersSent) {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      res.end("stream accepted");
    }
  });
  req.pipe(pending.res);
}

function proxyToTermux(req, res, url) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD" });
    res.end("Method not allowed");
    return;
  }
  const requestId = randomUUID();
  const headers = {};
  for (const name of ["range", "if-range", "if-none-match", "if-modified-since", "accept", "user-agent"]) {
    if (req.headers[name]) headers[name] = String(req.headers[name]);
  }
  headers["x-forwarded-host"] = String(req.headers.host || "melissa-iptv.hostless.app");
  headers["x-forwarded-proto"] = "https";
  headers["x-forwarded-prefix"] = "/iptv";
  const localPath = url.pathname.slice("/iptv".length) || "/";
  const job = { id: requestId, method: req.method, path: localPath + url.search, headers };
  const timer = setTimeout(() => {
    const pending = pendingProxyRequests.get(requestId);
    if (!pending) return;
    pendingProxyRequests.delete(requestId);
    if (!pending.res.headersSent) {
      pending.res.writeHead(504, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      pending.res.end("Termux did not answer the tunnel request in time.");
    } else if (!pending.res.destroyed) pending.res.destroy();
  }, PROXY_REQUEST_TIMEOUT_MS);
  pendingProxyRequests.set(requestId, { res, timer });
  res.once("close", () => {
    if (res.writableEnded) return;
    const pending = pendingProxyRequests.get(requestId);
    if (pending) {
      clearTimeout(pending.timer);
      pendingProxyRequests.delete(requestId);
    }
    const queuedIndex = proxyQueue.findIndex((item) => item.id === requestId);
    if (queuedIndex !== -1) proxyQueue.splice(queuedIndex, 1);
  });
  dispatchProxyJob(job);
}


function handleReverseDownload(req, res, url) {
  if (!REVERSE_AGENT_TOKEN || REVERSE_AGENT_TOKEN.length < 32) {
    jsonResponse(res, 503, { error: "REVERSE_AGENT_TOKEN não está configurado no relay" });
    return;
  }
  if (!tokenMatches(String(req.headers["x-downloader-token"] || ""))) {
    jsonResponse(res, 401, { error: "Token do downloader reverso inválido" });
    return;
  }
  if (req.method !== "GET") {
    res.writeHead(405, { allow: "GET" });
    res.end();
    return;
  }

  const rawUrl = url.searchParams.get("url");
  let mediaUrl;
  try { mediaUrl = new URL(rawUrl); } catch {}
  const allowedHosts = new Set([
    "youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com",
    "youtu.be", "www.youtu.be", "youtube-nocookie.com", "www.youtube-nocookie.com"
  ]);
  if (!mediaUrl || mediaUrl.protocol !== "https:" || !allowedHosts.has(mediaUrl.hostname.toLowerCase()) ||
      mediaUrl.username || mediaUrl.password || mediaUrl.port) {
    jsonResponse(res, 400, { error: "Apenas URLs HTTPS oficiais do YouTube são aceitas" });
    return;
  }
  const mode = url.searchParams.get("mode") || "video";
  if (mode !== "video" && mode !== "audio") {
    jsonResponse(res, 400, { error: "Modo deve ser video ou audio" });
    return;
  }

  const requestId = randomUUID();
  const job = {
    id: requestId,
    method: "GET",
    path: "/_downloader-reverse?url=" + encodeURIComponent(mediaUrl.toString()) + "&mode=" + mode,
    headers: {}
  };
  const timer = setTimeout(() => {
    const pending = pendingDownloadRequests.get(requestId);
    if (!pending) return;
    pendingDownloadRequests.delete(requestId);
    if (!pending.res.headersSent) {
      jsonResponse(pending.res, 504, { error: "O agente Termux não respondeu dentro do tempo limite" });
    } else if (!pending.res.destroyed) {
      pending.res.destroy();
    }
  }, DOWNLOAD_PROXY_TIMEOUT_MS);
  pendingDownloadRequests.set(requestId, { res, timer });
  res.once("close", () => {
    if (res.writableEnded) return;
    const pending = pendingDownloadRequests.get(requestId);
    if (pending) {
      clearTimeout(pending.timer);
      pendingDownloadRequests.delete(requestId);
    }
    const queuedIndex = downloadQueue.findIndex(item => item.id === requestId);
    if (queuedIndex !== -1) downloadQueue.splice(queuedIndex, 1);
  });
  dispatchProxyJob(job, downloadQueue, downloadPollWaiters);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");


  if (url.pathname === "/download-agent/poll" && req.method === "GET") {
    if (!tokenMatches(String(req.headers["x-agent-token"] || ""))) {
      jsonResponse(res, REVERSE_AGENT_TOKEN ? 401 : 503, { error: "Agente reverso não autorizado ou token não configurado" });
      return;
    }
    await handleDownloadAgentPoll(req, res);
    return;
  }

  const downloadResponseMatch = url.pathname.match(/^\\/download-agent\\/respond\\/([0-9a-f-]{36})$/i);
  if (downloadResponseMatch && req.method === "POST") {
    if (!tokenMatches(String(req.headers["x-agent-token"] || ""))) {
      req.resume();
      jsonResponse(res, REVERSE_AGENT_TOKEN ? 401 : 503, { error: "Agente reverso não autorizado ou token não configurado" });
      return;
    }
    handleAgentResponse(req, res, downloadResponseMatch[1], pendingDownloadRequests);
    return;
  }

  if (url.pathname === "/reverse-download") {
    handleReverseDownload(req, res, url);
    return;
  }

  if (url.pathname === "/agent/poll" && req.method === "GET") {
    await handleAgentPoll(req, res);
    return;
  }

  const responseMatch = url.pathname.match(/^\/agent\/respond\/([0-9a-f-]{36})$/i);
  if (responseMatch && req.method === "POST") {
    handleAgentResponse(req, res, responseMatch[1]);
    return;
  }

  if (url.pathname === "/iptv" || url.pathname.startsWith("/iptv/")) {
    proxyToTermux(req, res, url);
    return;
  }

  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("ok");
    return;
  }

  if (url.pathname.startsWith("/cache/")) {
    try {
      const handled = await handleCacheRoute(req, res, url);
      if (handled) return;
    } catch (error) {
      if (!res.headersSent) {
        res.writeHead(error.statusCode || 500, {
          "content-type": "text/plain; charset=utf-8"
        });
      }
      if (!res.writableEnded) res.end(error.statusCode ? error.message : "Cache error");
      if (!error.statusCode) console.error("Erro no cache:", error);
      return;
    }
  }

  const match = url.pathname.match(/^\/(enviar|receber)\/([A-Za-z0-9._-]{1,128})$/);

  if (!match || match[2] === "." || match[2] === "..") {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const [, action, id] = match;

  if (action === "enviar" && req.method === "POST") {
    receiveData(req, res, id);
    return;
  }

  if (action === "receber" && req.method === "GET") {
    sendData(res, id);
    return;
  }

  res.writeHead(405, { allow: action === "enviar" ? "POST" : "GET" });
  res.end("Method not allowed");
});

async function handleCacheRoute(req, res, url) {
  const match = url.pathname.match(/^\/cache\/([A-Za-z0-9._-]{1,128})(?:\/([A-Za-z0-9._-]{1,128}))?$/);
  if (!match || match[1] === "." || match[1] === ".." ||
      match[2] === "." || match[2] === "..") {
    res.writeHead(404);
    res.end("Not found");
    return true;
  }

  const [, streamId, segmentId] = match;

  if (!segmentId && req.method === "GET") {
    const segments = segmentCache.list(streamId);
    const body = JSON.stringify({
      stream: streamId,
      segments,
      cache: segmentCache.stats()
    });
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body),
      "cache-control": "no-store"
    });
    res.end(body);
    return true;
  }

  if (!segmentId) {
    res.writeHead(405, { allow: "GET" });
    res.end("Method not allowed");
    return true;
  }

  if (req.method === "POST") {
    const result = await segmentCache.put(streamId, segmentId, req);
    const body = JSON.stringify({
      ok: true,
      stream: streamId,
      segment: segmentId,
      size: result.size,
      expiresAt: new Date(result.expiresAt).toISOString()
    });
    res.writeHead(201, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body),
      "cache-control": "no-store"
    });
    res.end(body);
    return true;
  }

  if (req.method === "DELETE") {
    const deleted = segmentCache.deleteSegment(streamId, segmentId);
    res.writeHead(deleted ? 204 : 404);
    res.end();
    return true;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD, POST, DELETE" });
    res.end("Method not allowed");
    return true;
  }

  const entry = segmentCache.get(streamId, segmentId);
  if (!entry) {
    res.writeHead(404, { "cache-control": "no-store" });
    res.end("Segment not found");
    return true;
  }

  const etag = '"' + createHash("sha1").update(entry.data).digest("hex") + '"';
  const remainingSeconds = Math.max(0, Math.floor((entry.expiresAt - Date.now()) / 1000));
  const headers = {
    "content-type": entry.contentType,
    "accept-ranges": "bytes",
    "cache-control": "public, max-age=" + remainingSeconds,
    "etag": etag,
    "x-cache-status": "HIT"
  };

  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, headers);
    res.end();
    return true;
  }

  let start = 0;
  let end = entry.data.length - 1;
  let statusCode = 200;
  const range = req.headers.range;

  if (range) {
    const parsed = range.match(/^bytes=(\d*)-(\d*)$/);
    if (!parsed || (!parsed[1] && !parsed[2])) {
      res.writeHead(416, { "content-range": "bytes */" + entry.data.length });
      res.end();
      return true;
    }

    if (!parsed[1]) {
      const suffixLength = Number(parsed[2]);
      if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
        res.writeHead(416, { "content-range": "bytes */" + entry.data.length });
        res.end();
        return true;
      }
      start = Math.max(0, entry.data.length - suffixLength);
    } else {
      start = Number(parsed[1]);
      if (parsed[2]) end = Number(parsed[2]);
    }

    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
        start >= entry.data.length || start > end) {
      res.writeHead(416, { "content-range": "bytes */" + entry.data.length });
      res.end();
      return true;
    }
    end = Math.min(end, entry.data.length - 1);
    statusCode = 206;
    headers["content-range"] = "bytes " + start + "-" + end + "/" + entry.data.length;
  }

  headers["content-length"] = end - start + 1;
  res.writeHead(statusCode, headers);
  if (req.method === "HEAD") res.end();
  else res.end(entry.data.subarray(start, end + 1));
  return true;
}

function getTransfer(id) {
  let transfer = transfers.get(id);

  if (!transfer) {
    transfer = {
      stream: new PassThrough(),
      sender: null,
      receiver: null,
      contentType: "application/octet-stream",
      started: false
    };

    transfers.set(id, transfer);
    transfer.stream.on("close", () => removeTransfer(id, transfer));
  }

  return transfer;
}

function receiveData(req, res, id) {
  const transfer = getTransfer(id);

  if (transfer.sender) {
    res.writeHead(409);
    res.end("Sender already connected");
    return;
  }

  transfer.sender = req;
  transfer.contentType = req.headers["content-type"] || "application/octet-stream";

  req.on("aborted", () => {
    transfer.stream.destroy();
    if (transfer.receiver && !transfer.receiver.writableEnded) {
      transfer.receiver.destroy();
    }
    removeTransfer(id, transfer);
  });

  req.on("error", () => {
    transfer.stream.destroy();
    if (transfer.receiver && !transfer.receiver.writableEnded) {
      transfer.receiver.destroy();
    }
    removeTransfer(id, transfer);
  });

  req.on("end", () => {
    transfer.stream.end();
    if (!res.headersSent) {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("ok");
    }
  });

  req.pipe(transfer.stream);
  startTransfer(transfer);
}

function sendData(res, id) {
  const transfer = getTransfer(id);

  if (transfer.receiver) {
    res.writeHead(409);
    res.end("Receiver already connected");
    return;
  }

  transfer.receiver = res;

  res.on("close", () => {
    if (!res.writableEnded) {
      transfer.stream.destroy();
      if (transfer.sender && !transfer.sender.destroyed) {
        transfer.sender.destroy();
      }
      removeTransfer(id, transfer);
    }
  });

  startTransfer(transfer);
}

function startTransfer(transfer) {
  if (transfer.started || !transfer.sender || !transfer.receiver) return;

  transfer.started = true;
  transfer.receiver.writeHead(200, {
    "content-type": transfer.contentType,
    "cache-control": "no-store",
    "x-accel-buffering": "no"
  });

  transfer.stream.pipe(transfer.receiver);
}

function removeTransfer(id, transfer) {
  if (transfers.get(id) === transfer) {
    transfers.delete(id);
  }
}

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Relay + cache IPTV ouvindo na porta ${PORT}`);
  console.log("Tunnel reverso: aguardando agente Termux (sem senha).");
});
