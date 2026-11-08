import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureHls, checkFfmpeg } from "./hls.js";

const PORT = Number(process.env.PORT || 8080);
const HOST = "0.0.0.0";
const PUBLIC_URL = (process.env.PUBLIC_URL || "https://melissa-iptv.hostless.app").replace(/\/$/, "");
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(os.tmpdir(), "melissa-iptv"));
const CATALOG_PATH = path.resolve(process.env.VIDEOS_JSON || path.join(DATA_DIR, "videos.json"));
const HLS_DIR = path.join(DATA_DIR, "hls");
const TOKEN = process.env.IPTV_TOKEN || "";

let catalog = [];

async function loadCatalog() {
  const raw = await fsp.readFile(CATALOG_PATH, "utf8");
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
      title: String(item.title || `Vídeo ${index + 1}`).replace(/[\r\n]/g, " "),
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

function sendText(res, status, contentType, body) {
  const data = Buffer.from(body);
  res.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": data.length,
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*"
  });
  res.end(data);
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

function tokenQuery() {
  return TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : "";
}

function hlsUrl(id) {
  return `${PUBLIC_URL}/hls/${encodeURIComponent(id)}/index.m3u8${tokenQuery()}`;
}

function safeM3uTitle(value) {
  return String(value || "Vídeo").replace(/[\r\n,]/g, " ").trim();
}

function createM3u() {
  const lines = ["#EXTM3U"];
  for (const video of catalog) {
    lines.push(`#EXTINF:-1 tvg-id="${video.id.replace(/["\r\n]/g, "")}" group-title="Melissa IPTV",${safeM3uTitle(video.title)}`);
    lines.push(hlsUrl(video.id));
  }
  return lines.join("\n") + "\n";
}

async function sendHlsFile(req, res, filePath, contentType) {
  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    return sendJson(res, 404, { error: "Arquivo HLS não encontrado." });
  }
  if (!stat.isFile()) return sendJson(res, 404, { error: "Arquivo HLS não encontrado." });

  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": stat.size,
    "Cache-Control": contentType.includes("mpegurl") ? "no-store" : "public, max-age=3600",
    "Access-Control-Allow-Origin": "*"
  });
  if (req.method === "HEAD") return res.end();
  const input = fs.createReadStream(filePath);
  input.on("error", () => res.destroy());
  input.pipe(res);
}

async function handleHls(req, res, url) {
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 3) return sendJson(res, 404, { error: "Rota HLS inválida." });

  let id;
  try { id = decodeURIComponent(parts[1]); } catch {
    return sendJson(res, 400, { error: "ID inválido." });
  }
  const video = findVideo(id);
  if (!video) return sendJson(res, 404, { error: "Vídeo não encontrado." });

  const cache = await ensureHls(video);
  const filename = parts[2];

  if (filename === "index.m3u8") {
    let playlist = await fsp.readFile(cache.playlist, "utf8");
    const segmentBase = `${PUBLIC_URL}/hls/${encodeURIComponent(id)}/`;
    playlist = playlist.replace(/^(segment_\d+\.ts)$/gm, (name) => segmentBase + name + tokenQuery());
    return sendText(res, 200, "application/vnd.apple.mpegurl; charset=utf-8", playlist);
  }

  if (!/^segment_\d+\.ts$/.test(filename)) {
    return sendJson(res, 404, { error: "Segmento HLS inválido." });
  }
  return sendHlsFile(req, res, path.join(cache.directory, filename), "video/mp2t");
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const methodAllowed = req.method === "GET" || req.method === "HEAD";
  if (!methodAllowed) return sendJson(res, 405, { error: "Método não permitido." });

  if (url.pathname === "/health") {
    return sendJson(res, 200, { status: "ok", videos: catalog.length, hls: "ffmpeg" });
  }

  if (!authorized(req, res)) return;

  if (url.pathname === "/" || url.pathname === "/api") {
    return sendJson(res, 200, {
      name: "Melissa IPTV",
      url: PUBLIC_URL,
      playlist: `${PUBLIC_URL}/playlist.m3u8${tokenQuery()}`,
      videos: catalog.length,
      engine: "FFmpeg HLS",
      endpoints: ["/health", "/playlist.m3u", "/playlist.m3u8", "/api/videos", "/hls/:id/index.m3u8", "/hls/:id/segment_00000.ts"]
    });
  }

  if (url.pathname === "/playlist.m3u" || url.pathname === "/playlist.m3u8") {
    const type = url.pathname.endsWith(".m3u8")
      ? "application/vnd.apple.mpegurl; charset=utf-8"
      : "audio/x-mpegurl; charset=utf-8";
    return sendText(res, 200, type, createM3u());
  }

  if (url.pathname === "/api/videos") {
    return sendJson(res, 200, catalog.map(({ id, title, poster, width, height }) => ({
      id, title, poster, width, height,
      hls: hlsUrl(id),
      stream: hlsUrl(id)
    })));
  }

  if (url.pathname.startsWith("/hls/")) {
    try {
      return await handleHls(req, res, url);
    } catch (error) {
      console.error("Falha ao gerar/entregar HLS:", error);
      return sendJson(res, 502, { error: "Não foi possível gerar o HLS deste vídeo.", detail: error.message });
    }
  }

  if (url.pathname.startsWith("/stream/")) {
    const id = decodeURIComponent(url.pathname.slice("/stream/".length));
    if (!findVideo(id)) return sendJson(res, 404, { error: "Vídeo não encontrado." });
    res.writeHead(302, { Location: hlsUrl(id), "Cache-Control": "no-store" });
    return res.end();
  }

  return sendJson(res, 404, { error: "Rota não encontrada." });
});

Promise.all([loadCatalog(), checkFfmpeg()]).then(([_, ffmpegVersion]) => {
  server.listen(PORT, HOST, () => {
    console.log(`Melissa IPTV ouvindo em http://${HOST}:${PORT}`);
    console.log(`Endereço público: ${PUBLIC_URL}`);
    console.log(`Playlist M3U8: ${PUBLIC_URL}/playlist.m3u8`);
    console.log(`Vídeos carregados: ${catalog.length}`);
    console.log(`FFmpeg: ${ffmpegVersion}`);
    console.log(`Diretório temporário: ${DATA_DIR}`);
    console.log(`Cache HLS: ${HLS_DIR}`);
    if (TOKEN) console.log("Proteção por IPTV_TOKEN habilitada.");
  });
}).catch((error) => {
  console.error("Falha na inicialização:", error);
  process.exit(1);
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
