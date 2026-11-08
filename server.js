import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const PORT = Number(process.env.PORT || 8080);
const HOST = "0.0.0.0";
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(os.tmpdir(), "melissa-iptv"));
const CATALOG_PATH = path.resolve(process.env.VIDEOS_JSON || path.join(DATA_DIR, "videos.json"));
const CACHE_DIR = path.join(DATA_DIR, "cache");
const MAX_VIDEO_BYTES = Number(process.env.MAX_VIDEO_BYTES || 200 * 1024 * 1024);
const TOKEN = process.env.IPTV_TOKEN || "";

let catalog = [];
let cached = null;
let inflight = null;

async function loadCatalog() {
  let raw;
  try {
    raw = await fsp.readFile(CATALOG_PATH, "utf8");
  } catch {
    raw = await fsp.readFile(new URL("./videos.example.json", import.meta.url), "utf8");
    console.warn("videos.json não encontrado; usando videos.example.json vazio.");
  }

  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("O catálogo precisa ser um array JSON.");

  catalog = parsed.map((item, index) => {
    if (!item || typeof item.id !== "string" || typeof item.url !== "string") {
      throw new Error(`Item ${index} precisa ter id e url.`);
    }

    const parsedUrl = new URL(item.url);
    if (parsedUrl.protocol !== "https:" || parsedUrl.hostname !== "lh3.googleusercontent.com") {
      throw new Error(`URL não permitida no item ${item.id}. Esperado lh3.googleusercontent.com via HTTPS.`);
    }

    return {
      id: item.id,
      title: String(item.title || `Vídeo ${index + 1}`),
      url: item.url,
      poster: typeof item.poster === "string" ? item.poster : null,
      width: Number(item.width) || null,
      height: Number(item.height) || null
    };
  });
}

function sendJson(res, status, data) {
  const body = Buffer.from(JSON.stringify(data));
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function authorized(req, res) {
  if (!TOKEN) return true;
  const header = req.headers.authorization || "";
  const url = new URL(req.url, "http://localhost");
  const supplied = header.startsWith("Bearer ") ? header.slice(7) : url.searchParams.get("token");
  if (supplied === TOKEN) return true;
  sendJson(res, 401, { error: "Não autorizado." });
  return false;
}

function findVideo(id) {
  return catalog.find((video) => video.id === id);
}

async function removeCached() {
  if (!cached) return;
  const old = cached;
  cached = null;
  await fsp.rm(old.file, { force: true }).catch(() => {});
}

async function downloadToCache(video) {
  await fsp.mkdir(CACHE_DIR, { recursive: true });
  await removeCached();

  const tempFile = path.join(CACHE_DIR, `${Date.now()}-${process.pid}.part`);
  const finalFile = tempFile.replace(/\.part$/, ".mp4");

  try {
    const response = await fetch(video.url, {
      redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0 MelissaIPTV/1.0" },
      signal: AbortSignal.timeout(120_000)
    });

    if (!response.ok || !response.body) {
      throw new Error(`Origem respondeu HTTP ${response.status}.`);
    }

    const finalUrl = new URL(response.url);
    if (finalUrl.protocol !== "https:" || !finalUrl.hostname.endsWith("googleusercontent.com")) {
      throw new Error("O redirecionamento da origem apontou para um host não permitido.");
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("video/") && !contentType.includes("octet-stream")) {
      throw new Error(`A origem não entregou vídeo (Content-Type: ${contentType || "desconhecido"}).`);
    }

    const declaredSize = Number(response.headers.get("content-length") || 0);
    if (declaredSize > MAX_VIDEO_BYTES) {
      throw new Error(`Vídeo excede o limite de ${MAX_VIDEO_BYTES} bytes.`);
    }

    let received = 0;
    const limiter = new Transform({
      transform(chunk, encoding, callback) {
        received += chunk.length;
        if (received > MAX_VIDEO_BYTES) {
          callback(new Error("Vídeo excedeu o limite máximo durante o download."));
          return;
        }
        callback(null, chunk);
      }
    });

    await pipeline(response.body, limiter, fs.createWriteStream(tempFile));
    await fsp.rename(tempFile, finalFile);

    cached = { id: video.id, file: finalFile, size: received, mime: "video/mp4" };
    console.log(`Cache pronto: ${video.title} (${received} bytes)`);
    return cached;
  } catch (error) {
    await fsp.rm(tempFile, { force: true }).catch(() => {});
    await fsp.rm(finalFile, { force: true }).catch(() => {});
    throw error;
  }
}

async function ensureCached(video) {
  if (cached?.id === video.id) {
    try {
      await fsp.access(cached.file);
      return cached;
    } catch {
      cached = null;
    }
  }

  if (inflight) {
    await inflight;
    return ensureCached(video);
  }

  const job = downloadToCache(video);
  inflight = job;

  try {
    return await job;
  } finally {
    if (inflight === job) inflight = null;
  }
}

function parseRange(value, size) {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match) return { invalid: true };

  let start;
  let end;
  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return { invalid: true };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Number(match[2]);
  }

  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) {
    return { invalid: true };
  }
  return { start, end: Math.min(end, size - 1) };
}

async function streamVideo(req, res, video) {
  let file;
  try {
    file = await ensureCached(video);
  } catch (error) {
    console.error("Falha ao preparar vídeo:", error);
    sendJson(res, 502, { error: "Não foi possível obter o vídeo da origem.", detail: error.message });
    return;
  }

  const range = parseRange(req.headers.range, file.size);
  const commonHeaders = {
    "Content-Type": file.mime,
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*"
  };

  if (range?.invalid) {
    res.writeHead(416, { ...commonHeaders, "Content-Range": `bytes */${file.size}` });
    res.end();
    return;
  }

  if (range) {
    const length = range.end - range.start + 1;
    res.writeHead(206, {
      ...commonHeaders,
      "Content-Length": length,
      "Content-Range": `bytes ${range.start}-${range.end}/${file.size}`
    });
    if (req.method === "HEAD") return res.end();
    const input = fs.createReadStream(file.file, { start: range.start, end: range.end });
    input.on("error", () => res.destroy());
    input.pipe(res);
    return;
  }

  res.writeHead(200, { ...commonHeaders, "Content-Length": file.size });
  if (req.method === "HEAD") return res.end();
  const input = fs.createReadStream(file.file);
  input.on("error", () => res.destroy());
  input.pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const methodAllowed = req.method === "GET" || req.method === "HEAD";
  if (!methodAllowed) return sendJson(res, 405, { error: "Método não permitido." });

  if (url.pathname === "/health") {
    return sendJson(res, 200, { status: "ok", videos: catalog.length, cache: cached?.id || null });
  }

  if (!authorized(req, res)) return;

  if (url.pathname === "/api/videos") {
    return sendJson(res, 200, catalog.map(({ id, title, poster, width, height }) => ({
      id, title, poster, width, height, stream: `/stream/${encodeURIComponent(id)}`
    })));
  }

  if (url.pathname.startsWith("/stream/")) {
    const id = decodeURIComponent(url.pathname.slice("/stream/".length));
    const video = findVideo(id);
    if (!video) return sendJson(res, 404, { error: "Vídeo não encontrado." });
    return streamVideo(req, res, video);
  }

  return sendJson(res, 200, {
    name: "Melissa IPTV",
    endpoints: ["/health", "/api/videos", "/stream/:id"],
    note: "O primeiro acesso baixa o vídeo inteiro para cache temporário; depois o servidor entrega respostas 200/206."
  });
});

loadCatalog().then(() => {
  server.listen(PORT, HOST, () => {
    console.log(`Melissa IPTV ouvindo em http://${HOST}:${PORT}`);
    console.log(`Vídeos carregados: ${catalog.length}`);
    console.log(`Diretório temporário: ${DATA_DIR}`);
    if (TOKEN) console.log("Proteção por IPTV_TOKEN habilitada.");
  });
}).catch((error) => {
  console.error("Erro ao carregar catálogo:", error);
  process.exit(1);
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
