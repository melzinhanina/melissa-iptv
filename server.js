import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getHlsPlaylist, serveHlsSegment, hlsStats, checkFfmpeg, closeHls } from "./hls.js";

const PORT = Number(process.env.PORT || 8080);
const HOST = "0.0.0.0";
const PUBLIC_URL = (process.env.PUBLIC_URL || "https://melissa-iptv.hostless.app").replace(/\/$/, "");
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(os.tmpdir(), "melissa-iptv"));
const CATALOG_PATH = path.resolve(process.env.VIDEOS_JSON || path.join(DATA_DIR, "videos.json"));
const TOKEN = process.env.IPTV_TOKEN || "";
let catalog = [];

async function loadCatalog() {
  const raw = await fs.readFile(CATALOG_PATH, "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("O catálogo precisa ser um array JSON.");
  catalog = parsed.map((item, index) => {
    if (!item || typeof item.id !== "string" || typeof item.url !== "string") throw new Error(`Item ${index} precisa ter id e url.`);
    const parsedUrl = new URL(item.url);
    if (parsedUrl.protocol !== "https:" || parsedUrl.hostname !== "lh3.googleusercontent.com") throw new Error(`URL não permitida no item ${item.id}.`);
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
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": body.length, "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" });
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
function findVideo(id) { return catalog.find(video => video.id === id); }
function tokenQuery() { return TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : ""; }
function hlsUrl(id) { return `${PUBLIC_URL}/hls/${encodeURIComponent(id)}/index.m3u8${tokenQuery()}`; }
function safeTitle(value) { return String(value || "Vídeo").replace(/[\r\n,]/g, " ").trim(); }
function createM3u() {
  const lines = ["#EXTM3U"];
  for (const video of catalog) {
    lines.push(`#EXTINF:-1 tvg-id="${video.id.replace(/["\r\n]/g, "")}" group-title="Melissa IPTV",${safeTitle(video.title)}`);
    lines.push(hlsUrl(video.id));
  }
  return lines.join("\n") + "\n";
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, 405, { error: "Método não permitido." });
  if (url.pathname === "/health") return sendJson(res, 200, { status: "ok", videos: catalog.length, engine: "Google Photos HTTP 200 -> paced FFmpeg HLS", ...hlsStats() });
  if (!authorized(req, res)) return;
  if (url.pathname === "/" || url.pathname === "/api") {
    return sendJson(res, 200, {
      name: "Melissa IPTV", url: PUBLIC_URL, playlist: `${PUBLIC_URL}/playlist.m3u8${tokenQuery()}`,
      videos: catalog.length, engine: "Progressive HLS with per-video rolling cache",
      endpoints: ["/health", "/playlist.m3u", "/playlist.m3u8", "/api/videos", "/hls/:id/index.m3u8", "/hls/:id/segment_00000.ts"]
    });
  }
  if (url.pathname === "/playlist.m3u" || url.pathname === "/playlist.m3u8") {
    const body = Buffer.from(createM3u());
    res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl; charset=utf-8", "Content-Length": body.length, "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" });
    return res.end(body);
  }
  if (url.pathname === "/api/videos") {
    return sendJson(res, 200, catalog.map(({ id, title, poster, width, height }) => ({ id, title, poster, width, height, hls: hlsUrl(id) })));
  }
  const hlsMatch = /^\/hls\/([^/]+)\/(index\.m3u8|segment_\d{5}\.ts)$/.exec(url.pathname);
  if (hlsMatch) {
    let id;
    try { id = decodeURIComponent(hlsMatch[1]); } catch { return sendJson(res, 400, { error: "ID inválido." }); }
    const video = findVideo(id);
    if (!video) return sendJson(res, 404, { error: "Vídeo não encontrado." });
    try {
      if (hlsMatch[2] === "index.m3u8") {
        const playlist = await getHlsPlaylist(video);
        const segmentBase = `${PUBLIC_URL}/hls/${encodeURIComponent(video.id)}/`;
        const playablePlaylist = playlist.replace(/^(segment_\d{5}\.ts)$/gm, name => `${segmentBase}${name}${tokenQuery()}`);
        const body = Buffer.from(playablePlaylist);
        res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl; charset=utf-8", "Content-Length": body.length, "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" });
        return res.end(body);
      }
      return await serveHlsSegment(req, res, video, hlsMatch[2]);
    } catch (error) {
      console.error("Falha HLS:", error);
      if (!res.headersSent) return sendJson(res, error.statusCode || 502, { error: "Não foi possível gerar/entregar o HLS.", detail: error.message });
      res.destroy(error);
    }
  }
  if (url.pathname.startsWith("/stream/")) {
    const id = url.pathname.slice("/stream/".length);
    const video = findVideo(decodeURIComponent(id));
    if (!video) return sendJson(res, 404, { error: "Vídeo não encontrado." });
    res.writeHead(302, { Location: hlsUrl(video.id), "Cache-Control": "no-store" });
    return res.end();
  }
  return sendJson(res, 404, { error: "Rota não encontrada." });
});
async function shutdown() {
  server.close(async () => { await closeHls(); process.exit(0); });
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

Promise.all([loadCatalog(), checkFfmpeg()]).then(([_, ffmpeg]) => {
  server.listen(PORT, HOST, () => {
    console.log(`Melissa IPTV ouvindo em http://${HOST}:${PORT}`);
    console.log(`Endereço público: ${PUBLIC_URL}`);
    console.log(`Playlist IPTV: ${PUBLIC_URL}/playlist.m3u8`);
    console.log(`Vídeos carregados: ${catalog.length}`);
    console.log(`FFmpeg: ${ffmpeg}`);
    console.log("Entrada Google Fotos HTTP 200; FFmpeg gera HLS progressivamente; player recebe segmentos HTTP 200.");
  });
}).catch(error => {
  console.error("Falha na inicialização:", error);
  process.exit(1);
});
