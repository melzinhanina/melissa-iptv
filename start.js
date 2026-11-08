import { extractVideos } from "./extractor.js";

const PHOTOS_ALBUM_URL =
  process.env.PHOTOS_ALBUM_URL ||
  "https://photos.app.goo.gl/ajtsMofx5CtcwDdh8";

const PUBLIC_URL = (process.env.PUBLIC_URL || "https://melissa-iptv.hostless.app").replace(/\/$/, "");

try {
  console.log("=== Melissa IPTV Range Streaming: inicialização ===");
  console.log(`Álbum configurado: ${PHOTOS_ALBUM_URL}`);
  await extractVideos(PHOTOS_ALBUM_URL);
  console.log("Catálogo atualizado. Iniciando servidor de streaming...");
  console.log(`Acesso público: ${PUBLIC_URL}`);
  console.log(`Playlist IPTV: ${PUBLIC_URL}/playlist.m3u8`);
  await import("./server.js");
} catch (error) {
  console.error("Inicialização cancelada:", error);
  process.exit(1);
}
