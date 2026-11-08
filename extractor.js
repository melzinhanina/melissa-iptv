import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchImageUrls } from "@marcus5914/google-photos-album-image-url-fetch";

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(os.tmpdir(), "melissa-iptv"));
const OUTPUT = path.resolve(process.env.VIDEOS_JSON || path.join(DATA_DIR, "videos.json"));

function cleanTitle(value) {
  if (typeof value !== "string") return null;
  const title = value.replace(/[\r\n]/g, " ").replace(/\s+/g, " ").trim();
  return title || null;
}

function titleFromItem(item, index) {
  const candidates = [item?.title, item?.name, item?.filename, item?.fileName, item?.description];
  for (const candidate of candidates) {
    const title = cleanTitle(candidate);
    if (title) return title;
  }
  return `Vídeo ${index + 1}`;
}

export async function extractVideos(albumUrl = process.env.PHOTOS_ALBUM_URL) {
  if (!albumUrl) {
    throw new Error("Defina PHOTOS_ALBUM_URL com o link compartilhado do álbum do Google Fotos.");
  }

  console.log("Consultando o álbum do Google Fotos...");
  const items = await fetchImageUrls(albumUrl, {
    signal: AbortSignal.timeout(180_000),
    timeoutMs: 30_000,
    maxAttempts: 5
  });

  if (!Array.isArray(items)) {
    throw new Error("O extrator não conseguiu ler o álbum. Confira se o link está público e tente novamente.");
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
        title: titleFromItem(item, index),
        url: item.videoUrl,
        poster: item.posterUrl ?? item.url ?? null,
        width: Number(item.width) || null,
        height: Number(item.height) || null
      };
    });

  if (videos.length === 0) {
    throw new Error("Nenhum vídeo foi encontrado no álbum. O servidor não será iniciado com catálogo vazio.");
  }

  const unique = [...new Map(videos.map((video) => [video.id, video])).values()];
  await fs.mkdir(path.dirname(OUTPUT), { recursive: true });
  const temporary = `${OUTPUT}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(unique, null, 2) + "\n", "utf8");
  await fs.rename(temporary, OUTPUT);

  console.log(`Mídias encontradas: ${items.length}`);
  console.log(`Vídeos extraídos: ${unique.length}`);
  console.log(`Catálogo salvo em ${OUTPUT}`);
  return unique;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  extractVideos(process.argv[2]).catch((error) => {
    console.error("Falha ao extrair álbum:", error);
    process.exitCode = 1;
  });
}
