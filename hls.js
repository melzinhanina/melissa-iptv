import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import { HLS_DIR } from "./storage-paths.js";

const ROOT = HLS_DIR;
const RUNTIME_FFMPEG_PATH = path.join(path.dirname(HLS_DIR), "bin", "ffmpeg");
let ffmpegExecutable = null;
const SEGMENT_SECONDS = Math.max(2, Math.min(15, Number(process.env.HLS_SEGMENT_SECONDS) || 6));
const SESSION_TTL = Math.max(60_000, Number(process.env.HLS_SESSION_TTL_MS) || 10 * 60 * 1000);
const sessions = new Map();
const creating = new Map();

function signal(session) {
  for (const wake of session.waiters) wake();
  session.waiters.clear();
}

function waitChange(session, ms = 250) {
  return new Promise(resolve => {
    let timer;
    const done = () => {
      clearTimeout(timer);
      session.waiters.delete(done);
      resolve();
    };
    session.waiters.add(done);
    timer = setTimeout(done, ms);
  });
}

async function cleanupSession(session) {
  session.closed = true;
  signal(session);
  for (const child of session.children) {
    try { child.kill("SIGTERM"); } catch {}
  }
  await fs.rm(session.dir, { recursive: true, force: true }).catch(() => {});
}

async function evictIdle() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastUsed > SESSION_TTL && !session.activeRequests && !session.segmentTasks.size) {
      sessions.delete(id);
      void cleanupSession(session);
    }
  }
}

function durationFromOutput(output) {
  const match = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/i.exec(output);
  if (!match) return null;
  const duration = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  return Number.isFinite(duration) && duration > 0 ? duration : null;
}

async function probeDuration(video) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegExecutable, [
      "-hide_banner", "-i", video.url, "-t", "0", "-f", "null", "-"
    ], { stdio: ["ignore", "ignore", "pipe"] });

    let stderr = "";
    let settled = false;
    const finish = (error, duration) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(duration);
    };

    const timeout = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch {}
      finish(new Error("Tempo esgotado ao consultar a duração do vídeo no Google Fotos."));
    }, 45_000);
    timeout.unref?.();

    child.stderr.on("data", chunk => {
      stderr = (stderr + chunk.toString()).slice(-12000);
      const duration = durationFromOutput(stderr);
      if (duration) {
        try { child.kill("SIGTERM"); } catch {}
        finish(null, duration);
      }
    });
    child.once("error", error => finish(error));
    child.once("close", code => {
      if (settled) return;
      const duration = durationFromOutput(stderr);
      if (duration) finish(null, duration);
      else finish(new Error("FFmpeg não conseguiu identificar a duração do vídeo: " + (stderr || "sem detalhes") + " (código " + code + ")."));
    });
  });
}

async function createSession(video) {
  await evictIdle();
  await fs.mkdir(ROOT, { recursive: true });
  const dir = path.join(ROOT, encodeURIComponent(video.id).replace(/%/g, "_"));
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });

  const duration = await probeDuration(video);
  const totalSegments = Math.ceil(duration / SEGMENT_SECONDS);
  if (!Number.isSafeInteger(totalSegments) || totalSegments < 1 || totalSegments > 99999) {
    throw new Error("Duração do vídeo fora do limite suportado pelo HLS.");
  }

  const session = {
    id: video.id,
    video,
    dir,
    duration,
    totalSegments,
    segmentTasks: new Map(),
    cachedSegments: new Set(),
    children: new Set(),
    activeRequests: 0,
    lastUsed: Date.now(),
    closed: false,
    waiters: new Set()
  };
  sessions.set(video.id, session);
  return session;
}

async function getSession(video) {
  await evictIdle();
  let session = sessions.get(video.id);
  if (session && session.closed) {
    sessions.delete(video.id);
    session = null;
  }
  if (!session) {
    let pending = creating.get(video.id);
    if (!pending) {
      pending = createSession(video);
      creating.set(video.id, pending);
    }
    try { session = await pending; }
    finally {
      if (creating.get(video.id) === pending) creating.delete(video.id);
    }
  }
  session.lastUsed = Date.now();
  return session;
}

function segmentName(index) {
  return "segment_" + String(index).padStart(5, "0") + ".ts";
}

async function generateSegment(session, index) {
  if (session.closed) throw new Error("Sessão HLS encerrada.");
  const start = index * SEGMENT_SECONDS;
  const duration = Math.min(SEGMENT_SECONDS, session.duration - start);
  const outputPath = path.join(session.dir, segmentName(index));
  const temporaryPath = outputPath + ".tmp";

  const args = [
    "-hide_banner", "-loglevel", "warning",
    "-ss", start.toFixed(3),
    "-i", session.video.url,
    "-t", duration.toFixed(3),
    "-map", "0:v:0?", "-map", "0:a:0?",
    "-c", "copy",
    "-avoid_negative_ts", "make_zero",
    "-f", "mpegts",
    "pipe:1"
  ];

  await fs.rm(temporaryPath, { force: true });
  await new Promise((resolve, reject) => {
    const child = spawn(ffmpegExecutable, args, { stdio: ["ignore", "pipe", "pipe"] });
    session.children.add(child);
    let stderr = "";
    let settled = false;
    const output = (async () => {
      const file = await fs.open(temporaryPath, "w");
      try {
        for await (const chunk of child.stdout) await file.write(chunk);
      } finally {
        await file.close();
      }
    })();

    const timeout = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch {}
    }, 120_000);
    timeout.unref?.();

    child.stderr.on("data", chunk => {
      stderr = (stderr + chunk.toString()).slice(-6000);
    });
    child.once("error", error => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      session.children.delete(child);
      reject(error);
    });
    child.once("close", async code => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      session.children.delete(child);
      try {
        await output;
        if (code !== 0) throw new Error("FFmpeg falhou ao gerar o segmento " + index + ": " + stderr);
        const stat = await fs.stat(temporaryPath);
        if (!stat.size) throw new Error("FFmpeg gerou um segmento vazio: " + index);
        await fs.rename(temporaryPath, outputPath);
        session.cachedSegments.add(index);
        resolve();
      } catch (error) {
        await fs.rm(temporaryPath, { force: true }).catch(() => {});
        reject(error);
      }
    });
  });
}

async function ensureSegment(session, index) {
  const file = path.join(session.dir, segmentName(index));
  try {
    const stat = await fs.stat(file);
    if (stat.isFile() && stat.size > 0) return file;
  } catch {}

  let task = session.segmentTasks.get(index);
  if (!task) {
    task = generateSegment(session, index).finally(() => {
      if (session.segmentTasks.get(index) === task) session.segmentTasks.delete(index);
      session.lastUsed = Date.now();
      signal(session);
    });
    session.segmentTasks.set(index, task);
  }
  await task;
  return file;
}

export async function getHlsPlaylist(video) {
  const session = await getSession(video);
  session.activeRequests++;
  try {
    const lines = [
      "#EXTM3U",
      "#EXT-X-VERSION:3",
      "#EXT-X-PLAYLIST-TYPE:VOD",
      "#EXT-X-TARGETDURATION:" + Math.ceil(SEGMENT_SECONDS),
      "#EXT-X-MEDIA-SEQUENCE:0"
    ];
    for (let index = 0; index < session.totalSegments; index++) {
      const segmentDuration = Math.min(SEGMENT_SECONDS, session.duration - index * SEGMENT_SECONDS);
      lines.push("#EXTINF:" + segmentDuration.toFixed(3) + ",");
      lines.push(segmentName(index));
    }
    lines.push("#EXT-X-ENDLIST");
    session.lastUsed = Date.now();
    return lines.join("\n") + "\n";
  } finally {
    session.activeRequests--;
  }
}

export async function serveHlsSegment(req, res, video, filename) {
  if (!/^segment_\d{5}\.ts$/.test(filename)) {
    res.writeHead(400);
    return res.end("Nome de segmento inválido.");
  }

  const session = await getSession(video);
  const index = Number(filename.match(/segment_(\d{5})/)[1]);
  if (index >= session.totalSegments) {
    res.writeHead(404, { "Cache-Control": "no-store" });
    return res.end("Segmento fora da duração do vídeo.");
  }

  session.activeRequests++;
  session.lastUsed = Date.now();
  try {
    const file = await ensureSegment(session, index);
    const stat = await fs.stat(file);
    let start = 0;
    let end = stat.size - 1;
    let status = 200;
    const rangeHeader = req.headers.range;

    if (rangeHeader) {
      const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());
      if (!match || (!match[1] && !match[2])) {
        res.writeHead(416, { "Content-Range": "bytes */" + stat.size, "Accept-Ranges": "bytes" });
        return res.end();
      }
      if (!match[1]) {
        const suffix = Number(match[2]);
        if (!Number.isSafeInteger(suffix) || suffix <= 0) {
          res.writeHead(416, { "Content-Range": "bytes */" + stat.size, "Accept-Ranges": "bytes" });
          return res.end();
        }
        start = Math.max(0, stat.size - suffix);
      } else {
        start = Number(match[1]);
        end = match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
      }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= stat.size) {
        res.writeHead(416, { "Content-Range": "bytes */" + stat.size, "Accept-Ranges": "bytes" });
        return res.end();
      }
      status = 206;
    }

    const headers = {
      "Content-Type": "video/mp2t",
      "Content-Length": end - start + 1,
      "Accept-Ranges": "bytes",
      "Cache-Control": "public, max-age=60",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Expose-Headers": "Accept-Ranges, Content-Length, Content-Range"
    };
    if (status === 206) headers["Content-Range"] = "bytes " + start + "-" + end + "/" + stat.size;
    res.writeHead(status, headers);
    if (req.method === "HEAD") return res.end();

    const stream = (await import("node:fs")).createReadStream(file, { start, end });
    stream.on("error", error => res.destroy(error));
    stream.pipe(res);
  } catch (error) {
    if (!res.headersSent) {
      res.writeHead(502, { "Cache-Control": "no-store" });
      res.end("Não foi possível gerar o trecho solicitado: " + error.message);
    } else {
      res.destroy(error);
    }
  } finally {
    session.activeRequests--;
    session.lastUsed = Date.now();
  }
}

export function hlsStats() {
  return {
    sessions: sessions.size,
    activeRequests: [...sessions.values()].reduce((count, session) => count + session.activeRequests, 0),
    segmentSeconds: SEGMENT_SECONDS,
    playlistMode: "vod",
    seekMode: "on-demand-http-input-seek",
    cachedSegments: [...sessions.values()].reduce((count, session) => count + session.cachedSegments.size, 0)
  };
}

export async function checkFfmpeg() {
  if (!ffmpegPath) throw new Error("ffmpeg-static não forneceu um binário para esta plataforma.");

  await fs.mkdir(path.dirname(RUNTIME_FFMPEG_PATH), { recursive: true });
  await fs.copyFile(ffmpegPath, RUNTIME_FFMPEG_PATH);
  await fs.chmod(RUNTIME_FFMPEG_PATH, 0o755);

  await new Promise((resolve, reject) => {
    const child = spawn(RUNTIME_FFMPEG_PATH, ["-version"], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-2000); });
    child.once("error", reject);
    child.once("close", code => {
      if (code === 0) resolve();
      else reject(new Error("Não foi possível executar o FFmpeg copiado para /tmp (código " + code + "): " + stderr));
    });
  });

  ffmpegExecutable = RUNTIME_FFMPEG_PATH;
  return ffmpegExecutable;
}

export async function closeHls() {
  const all = [...sessions.values()];
  sessions.clear();
  await Promise.all(all.map(cleanupSession));
}