import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import { HLS_DIR } from "./storage-paths.js";

const ROOT = HLS_DIR;
const RUNTIME_FFMPEG_PATH = path.join(path.dirname(HLS_DIR), "bin", "ffmpeg");
let ffmpegExecutable = null;
const SEGMENT_SECONDS = Math.max(2, Math.min(15, Number(process.env.HLS_SEGMENT_SECONDS) || 6));
const LIST_SIZE = Math.max(3, Math.min(20, Number(process.env.HLS_LIST_SIZE) || 8));
const PREFETCH = Math.max(1, Math.min(6, Number(process.env.HLS_PREFETCH_SEGMENTS) || 2));
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
async function countSegments(dir) {
  const files = await fs.readdir(dir).catch(() => []);
  const indexes = files
    .map(name => /^segment_(\d{5})\.ts$/.exec(name))
    .filter(Boolean)
    .map(match => Number(match[1]));
  return indexes.length ? Math.max(...indexes) + 1 : 0;
}
async function cleanupSession(session) {
  session.closed = true;
  signal(session);
  try { await session.reader?.cancel(); } catch {}
  try { session.controller?.abort(); } catch {}
  try { session.ffmpeg?.stdin?.destroy(); } catch {}
  try { session.ffmpeg?.kill("SIGTERM"); } catch {}
  await fs.rm(session.dir, { recursive: true, force: true }).catch(() => {});
}
async function evictIdle() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.lastUsed > SESSION_TTL && !s.activeRequests) {
      sessions.delete(id);
      void cleanupSession(s);
    }
  }

}
function writeChunk(stream, chunk) {
  return new Promise((resolve, reject) => {
    if (stream.destroyed || !stream.writable) return reject(new Error("FFmpeg stdin foi encerrado."));
    if (stream.write(chunk)) return resolve();
    stream.once("drain", resolve);
    stream.once("error", reject);
  });
}
export async function pump(session) {
  if (session.pumping || session.closed) return;
  session.pumping = true;
  try {
    while (!session.closed && !session.eof && !session.error) {
      const produced = await countSegments(session.dir);
      session.produced = produced;
      // Mantém somente uma pequena janela à frente do último segmento pedido pelo player.
      if (produced > session.requestedThrough + PREFETCH) {
        await waitChange(session, 500);
        continue;
      }
      const item = await session.reader.read();
      if (item.done) {
        session.eof = true;
        session.ffmpeg.stdin.end();
        signal(session);
        break;
      }
      const data = Buffer.from(item.value);
      // Fragmentar a entrada evita despejar um bloco grande no pipe do FFmpeg de uma vez.
      for (let offset = 0; offset < data.length && !session.closed && !session.error; offset += 64 * 1024) {
        const part = data.subarray(offset, Math.min(offset + 64 * 1024, data.length));
        await writeChunk(session.ffmpeg.stdin, part);
        await new Promise(resolve => setTimeout(resolve, 35));
        session.produced = await countSegments(session.dir);

        // Não descarte o restante do bloco já lido: aguarde o player avançar.
        while (
          !session.closed &&
          !session.error &&
          session.produced > session.requestedThrough + PREFETCH
        ) {
          await waitChange(session, 500);
          session.produced = await countSegments(session.dir);
        }
      }
      signal(session);
    }
  } catch (error) {
    if (!session.closed) {
      session.error = error;
      console.error("HLS upstream/FFmpeg:", session.id, error.message);
      signal(session);
    }
  } finally {
    session.pumping = false;
    signal(session);
  }
}
async function createSession(video) {
  await evictIdle();
  await fs.mkdir(ROOT, { recursive: true });
  const dir = path.join(ROOT, encodeURIComponent(video.id).replace(/%/g, "_"));
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });

  const controller = new AbortController();
  const response = await fetch(video.url, {
    headers: { Accept: "*/*", "Accept-Encoding": "identity", "User-Agent": "Mozilla/5.0 MelissaIPTV/4.0" },
    redirect: "follow",
    signal: controller.signal
  });
  if (response.status !== 200 || !response.body) {
    controller.abort();
    throw new Error(`Google Fotos respondeu HTTP ${response.status}; esperado HTTP 200 com corpo.`);
  }

  const playlistPath = path.join(dir, "index.m3u8");
  const segmentPattern = path.join(dir, "segment_%05d.ts");
  const args = [
    "-hide_banner", "-loglevel", "warning",
    "-i", "pipe:0",
    "-map", "0:v:0?", "-map", "0:a:0?",
    "-c", "copy",
    "-f", "hls",
    "-hls_time", String(SEGMENT_SECONDS),
    "-hls_list_size", String(LIST_SIZE),
    "-hls_delete_threshold", "2",
    "-hls_flags", "delete_segments+append_list+independent_segments+temp_file",
    "-hls_segment_filename", segmentPattern,
    playlistPath
  ];
  const ffmpeg = spawn(ffmpegExecutable || ffmpegPath, args, { stdio: ["pipe", "ignore", "pipe"] });
  let stderr = "";
  ffmpeg.stderr.on("data", chunk => {
    stderr = (stderr + chunk.toString()).slice(-6000);
  });

  const session = {
    id: video.id, dir, playlistPath, controller, reader: response.body.getReader(),
    ffmpeg, stderr, requestedThrough: -1, produced: 0, pumping: false,
    eof: false, ffmpegDone: false, error: null, closed: false, waiters: new Set(),
    activeRequests: 0, lastUsed: Date.now()
  };
  ffmpeg.once("error", error => {
    session.error = error;
    signal(session);
  });
  ffmpeg.once("close", code => {
    session.ffmpegDone = true;
    if (code && !session.eof && !session.closed) {
      session.error = new Error(`FFmpeg encerrou com código ${code}: ${stderr}`);
    }
    signal(session);
  });
  sessions.set(video.id, session);
  void pump(session);
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
    finally { if (creating.get(video.id) === pending) creating.delete(video.id); }
  }
  session.lastUsed = Date.now();
  return session;
}
async function waitPlaylist(session) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (session.error) throw session.error;
    const count = await countSegments(session.dir);
    if (count > 0) {
      try {
        const content = await fs.readFile(session.playlistPath, "utf8");
        if (content.includes(".ts")) return content;
      } catch {}
    }
    if (session.ffmpegDone) break;
    await waitChange(session, 200);
  }
  throw new Error("FFmpeg ainda não produziu o primeiro segmento HLS.");
}
export async function getHlsPlaylist(video) {
  const session = await getSession(video);
  session.activeRequests++;
  try {
    const content = await waitPlaylist(session);
    session.lastUsed = Date.now();
    return content;
  } finally {
    session.activeRequests--;
  }
}
export async function serveHlsSegment(req, res, video, filename) {
  if (!/^segment_\d{5}\.ts$/.test(filename)) {
    res.writeHead(400); return res.end("Nome de segmento inválido.");
  }
  const session = await getSession(video);
  const index = Number(filename.match(/segment_(\d{5})/)[1]);
  session.requestedThrough = Math.max(session.requestedThrough, index);
  session.activeRequests++;
  session.lastUsed = Date.now();
  signal(session);
  void pump(session);
  const file = path.join(session.dir, filename);
  const deadline = Date.now() + 45_000;
  try {
    while (Date.now() < deadline) {
      if (session.error) throw session.error;
      try {
        const stat = await fs.stat(file);
        if (stat.isFile() && stat.size > 0) {
          let start = 0;
          let end = stat.size - 1;
          let status = 200;
          const rangeHeader = req.headers.range;
          if (rangeHeader) {
            const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());
            if (!match || (!match[1] && !match[2])) {
              res.writeHead(416, { "Content-Range": `bytes */${stat.size}`, "Accept-Ranges": "bytes" });
              return res.end();
            }
            if (!match[1]) {
              const suffix = Number(match[2]);
              if (!Number.isSafeInteger(suffix) || suffix <= 0) {
                res.writeHead(416, { "Content-Range": `bytes */${stat.size}`, "Accept-Ranges": "bytes" });
                return res.end();
              }
              start = Math.max(0, stat.size - suffix);
            } else {
              start = Number(match[1]);
              end = match[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
            }
            if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= stat.size) {
              res.writeHead(416, { "Content-Range": `bytes */${stat.size}`, "Accept-Ranges": "bytes" });
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
          if (status === 206) headers["Content-Range"] = `bytes ${start}-${end}/${stat.size}`;
          res.writeHead(status, headers);
          if (req.method === "HEAD") return res.end();
          const stream = (await import("node:fs")).createReadStream(file, { start, end });
          stream.on("error", error => res.destroy(error));
          stream.pipe(res);
          return;
        }
      } catch {}
      if (session.eof) break;
      await waitChange(session, 200);
    }
    if (!res.headersSent) {
      res.writeHead(404, { "Cache-Control": "no-store" });
      res.end("Segmento ainda não disponível ou já expirou da janela HLS.");
    }
  } finally {
    session.activeRequests--;
    session.lastUsed = Date.now();
  }
}
export function hlsStats() {
  return {
    sessions: sessions.size,
    activeRequests: [...sessions.values()].reduce((n, s) => n + s.activeRequests, 0),
    segmentSeconds: SEGMENT_SECONDS,
    playlistWindow: LIST_SIZE,
    prefetchSegments: PREFETCH
  };
}
export async function checkFfmpeg() {
  if (!ffmpegPath) throw new Error("ffmpeg-static não forneceu um binário para esta plataforma.");

  // O diretório da aplicação no Hostless pode ser somente leitura e/ou noexec.
  // Copiamos o binário empacotado para /tmp, que é o diretório gravável do runtime.
  await fs.mkdir(path.dirname(RUNTIME_FFMPEG_PATH), { recursive: true });
  await fs.copyFile(ffmpegPath, RUNTIME_FFMPEG_PATH);
  await fs.chmod(RUNTIME_FFMPEG_PATH, 0o755);

  // Não basta verificar se o arquivo existe: executá-lo confirma que não há EACCES.
  await new Promise((resolve, reject) => {
    const child = spawn(RUNTIME_FFMPEG_PATH, ["-version"], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-2000); });
    child.once("error", reject);
    child.once("close", code => {
      if (code === 0) resolve();
      else reject(new Error(`Não foi possível executar o FFmpeg copiado para /tmp (código ${code}): ${stderr}`));
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
