import http from "node:http";
import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";
import { createSegmentCache } from "./cache/segment-cache.mjs";

const PORT = Number(process.env.PORT || 18080);
const transfers = new Map();
const segmentCache = createSegmentCache({
  maxBytes: Number(process.env.CACHE_MAX_BYTES || 128 * 1024 * 1024),
  maxSegmentBytes: Number(process.env.CACHE_MAX_SEGMENT_BYTES || 16 * 1024 * 1024),
  defaultTtlMs: Number(process.env.CACHE_TTL_MS || 10 * 60 * 1000)
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

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
});
