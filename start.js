import { extractVideos } from "./extractor.js";

const PHOTOS_ALBUM_URL =
  process.env.PHOTOS_ALBUM_URL ||
  "https://photos.app.goo.gl/ajtsMofx5CtcwDdh8";

try {
  console.log("=== Melissa IPTV: inicialização ===");
  await extractVideos(PHOTOS_ALBUM_URL);
  console.log("Catálogo atualizado. Iniciando servidor IPTV...");
  await import("./server.js");
} catch (error) {
  console.error("Inicialização cancelada:", error.message);
  process.exit(1);
}
