import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import ffmpegPath from "ffmpeg-static";

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(os.tmpdir(), "melissa-iptv"));
const HLS_DIR = path.join(DATA_DIR, "hls");
const SEGMENT_SECONDS = Math.max(2, Math.min(15, Number(process.env.HLS_SEGMENT_SECONDS || 6)));
const MAX_HLS_BYTES = Math.max(32 * 1024 * 1024, Number(process.env.MAX_HLS_BYTES || 400 * 1024 * 1024));
const GENERATION_TIMEOUT_MS = Math.max(60_000, Number(process.env.HLS_TIMEOUT_MS || 15 * 60 * 1000));

let activeCache = null;
let generation = null;

function folderFor(id) {
  const safe = createHash("sha256").update(id).digest("hex").slice(0, 24);
  return path.join(HLS_DIR, safe);
}

async function directorySize(directory) {
  let total = 0;
  let entries = [];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) total += await directorySize(full);
    else if (entry.isFile()) {
      try { total += (await fs.stat(full)).size; } catch {}
    }
  }
  return total;
}

export async function checkFfmpeg() {
  if (!ffmpegPath) throw new Error("O binário ffmpeg-static não foi instalado para esta plataforma.");
  const version = await new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, ["-version"], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(output.split("\n")[0] || "FFmpeg disponível");
      else reject(new Error("Não foi possível executar o FFmpeg."));
    });
  });
  return version;
}

async function runFfmpeg(video, outputDir) {
  const playlistPath = path.join(outputDir, "index.m3u8");
  const segmentPattern = path.join(outputDir, "segment_%05d.ts");
  const args = [
    "-hide_banner", "-loglevel", "warning", "-nostdin", "-y",
    "-rw_timeout", "30000000",
    "-user_agent", "Mozilla/5.0 MelissaIPTV/2.0",
    "-i", video.url,
    "-map", "0:v:0",
    "-map", "0:a:0?",
    "-sn", "-dn",
    "-c", "copy",
    "-f", "hls",
    "-hls_time", String(SEGMENT_SECONDS),
    "-hls_playlist_type", "vod",
    "-hls_flags", "independent_segments+temp_file",
    "-hls_segment_filename", segmentPattern,
    playlistPath
  ];

  await new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let exceededLimit = false;
    let monitorRunning = false;

    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-12_000);
    });

    const monitor = setInterval(async () => {
      if (monitorRunning) return;
      monitorRunning = true;
      try {
        if (await directorySize(outputDir) > MAX_HLS_BYTES) {
          exceededLimit = true;
          child.kill("SIGKILL");
        }
      } catch {}
      monitorRunning = false;
    }, 1000);
    monitor.unref?.();

    const timeout = setTimeout(() => child.kill("SIGKILL"), GENERATION_TIMEOUT_MS);
    timeout.unref?.();

    child.once("error", (error) => {
      clearInterval(monitor);
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearInterval(monitor);
      clearTimeout(timeout);
      if (exceededLimit) {
        reject(new Error(`A geração HLS ultrapassou o limite de ${MAX_HLS_BYTES} bytes do cache.`));
      } else if (code !== 0) {
        reject(new Error(`FFmpeg terminou com código ${code ?? signal}: ${stderr.trim().slice(-2500)}`));
      } else {
        resolve();
      }
    });
  });

  const stat = await fs.stat(playlistPath).catch(() => null);
  if (!stat?.size) throw new Error("FFmpeg terminou sem criar a playlist HLS.");
  const files = await fs.readdir(outputDir);
  if (!files.some((name) => /^segment_\d+\.ts$/.test(name))) {
    throw new Error("FFmpeg não gerou segmentos de vídeo HLS.");
  }
}

export async function ensureHls(video) {
  if (activeCache?.id === video.id) {
    try {
      await fs.access(activeCache.playlist);
      return activeCache;
    } catch {
      activeCache = null;
    }
  }

  if (generation) {
    await generation;
    return ensureHls(video);
  }

  const job = (async () => {
    await fs.rm(HLS_DIR, { recursive: true, force: true });
    await fs.mkdir(HLS_DIR, { recursive: true });
    const directory = folderFor(video.id);
    await fs.mkdir(directory, { recursive: true });

    console.log(`Gerando HLS para: ${video.title}`);
    await runFfmpeg(video, directory);

    activeCache = {
      id: video.id,
      directory,
      playlist: path.join(directory, "index.m3u8")
    };
    console.log(`HLS pronto: ${video.title} (${await directorySize(directory)} bytes)`);
    return activeCache;
  })();

  generation = job;
  try {
    return await job;
  } catch (error) {
    activeCache = null;
    await fs.rm(HLS_DIR, { recursive: true, force: true }).catch(() => {});
    throw error;
  } finally {
    if (generation === job) generation = null;
  }
}
