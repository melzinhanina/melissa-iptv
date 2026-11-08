import { extractVideos } from "./extractor.js";

const PHOTOS_ALBUM_URL =
  process.env.PHOTOS_ALBUM_URL ||
  "https://photos.app.goo.gl/ajtsMofx5CtcwDdh8";

const PUBLIC_URL = (process.env.PUBLIC_URL || "https://melissa-iptv.hostless.app").replace(/\/$/, "");
const REFRESH_INTERVAL_MS = Math.max(
  5 * 60 * 1000,
  Number(process.env.CATALOG_REFRESH_MS) || 30 * 60 * 1000
);

try {
  console.log("=== Melissa IPTV Range Streaming: inicialização ===");
  console.log(`Álbum configurado: ${PHOTOS_ALBUM_URL}`);
  await extractVideos(PHOTOS_ALBUM_URL);
  console.log("Catálogo inicial atualizado. Iniciando servidor de streaming...");
  console.log(`Acesso público: ${PUBLIC_URL}`);
  console.log(`Playlist IPTV: ${PUBLIC_URL}/playlist.m3u8`);

  const { reloadCatalog } = await import("./server.js");

  let refreshing = false;
  const refreshCatalog = async () => {
    if (refreshing) {
      console.log("Renovação anterior ainda está em andamento; pulando esta rodada.");
      return;
    }

    refreshing = true;
    try {
      console.log("=== Renovação automática do catálogo ===");
      await extractVideos(PHOTOS_ALBUM_URL);
      await reloadCatalog();
    } catch (error) {
      console.error("Renovação automática falhou; catálogo atual continua ativo:", error.message);
    } finally {
      refreshing = false;
    }
  };

  setInterval(refreshCatalog, REFRESH_INTERVAL_MS);
  console.log(`Renovação automática do catálogo: a cada ${Math.round(REFRESH_INTERVAL_MS / 60000)} minutos.`);
} catch (error) {
  console.error("Inicialização cancelada:", error);
  process.exit(1);
}
