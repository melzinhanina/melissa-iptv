import { extractVideos } from "./extractor.js";

try {
  console.log("=== Melissa IPTV: inicialização ===");
  await extractVideos();
  console.log("Catálogo atualizado. Iniciando servidor IPTV...");
  await import("./server.js");
} catch (error) {
  console.error("Inicialização cancelada:", error.message);
  process.exit(1);
}
