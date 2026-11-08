import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchImageUrls } from "@marcus5914/google-photos-album-image-url-fetch";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(os.tmpdir(), "melissa-iptv"));
const OUTPUT = path.resolve(process.env.VIDEOS_JSON || path.join(DATA_DIR, "videos.json"));

export async function extractVideos(albumUrl = process.env.PHOTOS_ALBUM_URL) {
  if (!albumUrl) {
    throw new Error("Defina PHOTOS_ALBUM_URL com o link compartilhado do álbum do Google Fotos.");
  }

  console.log("Verificando disponibilidade do extrator...");
  console.log("Buscando mídias do álbum...");

  const items = await fetchImageUrls(albumUrl);
  if (!Array.isArray(items)) {
    throw new Error("O Google Fotos não retornou uma lista válida. Verifique se o álbum está compartilhado.");
  }

  const videos = items
    .filter((item) => item?.isVideo && typeof item.videoUrl === "string")
    .map((item, index) => {
      const url = new URL(item.videoUrl);
      if (url.protocol !== "https:" || url.hostname !== "lh3.googleusercontent.com") {
        throw new Error(`URL de vídeo inesperada no item ${index + 1}.`);
      }

      return {
        id: String(item.uid ?? item.id ?? `video-${index + 1}`),
        title: `Vídeo ${index + 1}`,
        url: item.videoUrl,
        poster: item.posterUrl ?? item.url ?? null,
        width: Number(item.width) || null,
        height: Number(item.height) || null
      };
    });

  if (videos.length === 0) {
    throw new Error("Nenhum vídeo foi encontrado no álbum. O servidor não será iniciado com catálogo vazio.");
  }

  await fs.mkdir(path.dirname(OUTPUT), { recursive: true });
  const temporary = `${OUTPUT}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(videos, null, 2) + "\n", "utf8");
  await fs.rename(temporary, OUTPUT);

  console.log(`Total de mídias: ${items.length}`);
  console.log(`Total de vídeos: ${videos.length}`);
  console.log(`Lista salva em ${OUTPUT}`);

  return videos;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  extractVideos(process.argv[2]).catch((error) => {
    console.error("Falha ao extrair álbum:", error.message);
    process.exitCode = 1;
  });
}
