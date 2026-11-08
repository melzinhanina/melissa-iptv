const BUFFER_BYTES = Math.max(256 * 1024, Math.min(16 * 1024 * 1024, Number(process.env.RANGE_BUFFER_BYTES) || 2 * 1024 * 1024));
const RETAIN_BYTES = Math.min(512 * 1024, Math.floor(BUFFER_BYTES / 4));
const MAX_ACTIVE_STREAMS = Math.max(1, Math.min(32, Number(process.env.MAX_ACTIVE_STREAMS) || 12));
const STATE_TTL_MS = Math.max(60_000, Number(process.env.RANGE_STATE_TTL_MS) || 10 * 60 * 1000);
const states = new Map();
const creating = new Map();

function notify(state) {
  for (const wake of state.waiters) wake();
  state.waiters.clear();
}

function oldestOffset(state) {
  return state.chunks.length ? state.chunks[0].start : state.readOffset;
}

function trim(state) {
  const minPosition = state.consumers.size
    ? Math.min(...[...state.consumers].map((consumer) => consumer.position))
    : state.readOffset;
  const keepFrom = Math.max(0, minPosition - RETAIN_BYTES);
  while (state.chunks.length && state.chunks[0].end <= keepFrom) {
    const removed = state.chunks.shift();
    state.bufferedBytes -= removed.data.length;
  }
}

function findChunk(state, position) {
  return state.chunks.find((chunk) => position >= chunk.start && position < chunk.end) || null;
}

async function pump(state) {
  if (state.pumping || state.error || state.eof) return;
  state.pumping = true;
  try {
    while (state.consumers.size && !state.eof && !state.error) {
      const minPosition = Math.min(...[...state.consumers].map((consumer) => consumer.position));
      const readLimit = Math.min(state.total, minPosition + BUFFER_BYTES);
      if (state.readOffset >= readLimit) break;

      const result = await state.reader.read();
      if (result.done) {
        state.eof = true;
        if (state.readOffset !== state.total) {
          state.error = new Error(`Origem encerrou em ${state.readOffset} de ${state.total} bytes.`);
        }
        notify(state);
        break;
      }

      const data = Buffer.from(result.value);
      if (!data.length) continue;
      const start = state.readOffset;
      state.readOffset += data.length;
      state.chunks.push({ start, end: state.readOffset, data });
      state.bufferedBytes += data.length;
      trim(state);
      notify(state);
    }
  } catch (error) {
    state.error = error;
    notify(state);
  } finally {
    state.pumping = false;
    notify(state);
  }
}

async function waitForChunk(state, position) {
  while (true) {
    if (position < oldestOffset(state)) {
      const error = new Error("O intervalo solicitado já saiu do cache circular.");
      error.code = "RANGE_EXPIRED";
      throw error;
    }
    const chunk = findChunk(state, position);
    if (chunk) return chunk;
    if (state.error) throw state.error;
    if (state.eof) return null;

    const waiting = new Promise((resolve) => state.waiters.add(resolve));
    void pump(state);
    await waiting;
  }
}

async function dispose(state) {
  try { await state.reader.cancel(); } catch {}
  state.controller.abort();
  notify(state);
}

async function createState(video) {
  const now = Date.now();
  for (const [id, item] of states) {
    if (item.consumers.size === 0 && now - item.lastUsed > STATE_TTL_MS) {
      states.delete(id);
      void dispose(item);
    }
  }
  if (states.size >= MAX_ACTIVE_STREAMS * 2) {
    const idle = [...states.entries()]
      .filter(([, item]) => item.consumers.size === 0)
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    while (states.size >= MAX_ACTIVE_STREAMS * 2 && idle.length) {
      const [id, item] = idle.shift();
      states.delete(id);
      void dispose(item);
    }
  }
  const active = [...states.values()].filter((item) => item.consumers.size > 0).length;
  if (active + creating.size >= MAX_ACTIVE_STREAMS) {
    const error = new Error("Limite de vídeos simultâneos atingido. Tente novamente em instantes.");
    error.statusCode = 503;
    throw error;
  }

  const controller = new AbortController();
  const response = await fetch(video.url, {
    method: "GET",
    redirect: "follow",
    headers: {
      "Accept": "*/*",
      "Accept-Encoding": "identity",
      "User-Agent": "Mozilla/5.0 MelissaIPTV/3.0"
    },
    signal: controller.signal
  });

  if (response.status !== 200 || !response.body) {
    controller.abort();
    throw new Error(`Google Fotos respondeu HTTP ${response.status}; era esperado HTTP 200 com corpo.`);
  }

  const rawLength = response.headers.get("content-length") || response.headers.get("x-goog-stored-content-length");
  const total = Number(rawLength);
  if (!Number.isSafeInteger(total) || total <= 0) {
    controller.abort();
    await response.body.cancel().catch(() => {});
    throw new Error("A origem não informou Content-Length válido; não é possível construir Content-Range confiável.");
  }

  const state = {
    id: video.id,
    title: video.title,
    total,
    reader: response.body.getReader(),
    controller,
    chunks: [],
    bufferedBytes: 0,
    readOffset: 0,
    consumers: new Set(),
    waiters: new Set(),
    pumping: false,
    eof: false,
    error: null,
    lastUsed: Date.now()
  };
  states.set(video.id, state);
  return state;
}

async function getState(video) {
  let state = states.get(video.id);
  if (state && Date.now() - state.lastUsed > STATE_TTL_MS && state.consumers.size === 0) {
    states.delete(video.id);
    await dispose(state);
    state = null;
  }
  if (!state) {
    let pending = creating.get(video.id);
    if (!pending) {
      pending = createState(video);
      creating.set(video.id, pending);
    }
    try {
      state = await pending;
    } finally {
      if (creating.get(video.id) === pending) creating.delete(video.id);
    }
  }
  state.lastUsed = Date.now();
  return state;
}

function parseRange(header, total) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return { invalid: true };

  let start;
  let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return { invalid: true };
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : total - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
      return { invalid: true };
    }
    end = Math.min(end, total - 1);
  }
  if (start >= total) return { invalid: true };
  return { start, end };
}

function rangeError(res, total, message = "Intervalo inválido ou não disponível.") {
  res.writeHead(416, {
    "Content-Range": `bytes */${total}`,
    "Accept-Ranges": "bytes",
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(message),
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*"
  });
  res.end(message);
}

async function resetForOldRange(video, state) {
  if (state.consumers.size) return false;
  states.delete(video.id);
  await dispose(state);
  return true;
}

function waitForDrain(res) {
  return new Promise((resolve) => {
    const done = () => {
      res.off("drain", done);
      res.off("close", done);
      res.off("error", done);
      resolve();
    };
    res.once("drain", done);
    res.once("close", done);
    res.once("error", done);
  });
}

export async function serveByteStream(req, res, video) {
  let state = await getState(video);
  const rangeHeader = req.headers.range;
  let range = parseRange(rangeHeader, state.total);
  if (range?.invalid) return rangeError(res, state.total);

  let start = range ? range.start : 0;
  let end = range ? range.end : state.total - 1;

  if (start < oldestOffset(state)) {
    const reset = await resetForOldRange(video, state);
    if (!reset) return rangeError(res, state.total, "O intervalo não está mais no cache enquanto outro player usa este vídeo.");
    state = await getState(video);
    range = parseRange(rangeHeader, state.total);
    if (range?.invalid) return rangeError(res, state.total);
    start = range ? range.start : 0;
    end = range ? range.end : state.total - 1;
  }

  const partial = Boolean(rangeHeader);
  const headers = {
    "Content-Type": "video/mp4",
    "Content-Length": String(end - start + 1),
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Expose-Headers": "Accept-Ranges, Content-Length, Content-Range"
  };
  if (partial) headers["Content-Range"] = `bytes ${start}-${end}/${state.total}`;
  res.writeHead(partial ? 206 : 200, headers);
  if (req.method === "HEAD") return res.end();

  const consumer = { position: start, end };
  state.consumers.add(consumer);
  state.lastUsed = Date.now();
  void pump(state);

  try {
    while (consumer.position <= end && !res.destroyed) {
      const chunk = await waitForChunk(state, consumer.position);
      if (!chunk) break;
      const chunkEnd = Math.min(chunk.end, end + 1);
      const offset = consumer.position - chunk.start;
      const piece = chunk.data.subarray(offset, offset + (chunkEnd - consumer.position));
      if (!res.write(piece)) await waitForDrain(res);
      consumer.position = chunkEnd;
      state.lastUsed = Date.now();
      trim(state);
      notify(state);
      void pump(state);
    }
    if (!res.destroyed) res.end();
  } catch (error) {
    if (!res.destroyed) {
      console.error(`Falha no fluxo de ${video.id}:`, error.message);
      res.destroy(error);
    }
  } finally {
    state.consumers.delete(consumer);
    state.lastUsed = Date.now();
    trim(state);
    notify(state);
    void pump(state);
  }
}

export function rangeStreamStats() {
  return {
    active: [...states.values()].filter((state) => state.consumers.size > 0).length,
    cachedVideos: states.size,
    bufferLimitPerVideo: BUFFER_BYTES
  };
}

export async function closeRangeStreams() {
  const current = [...states.values()];
  states.clear();
  await Promise.all(current.map(dispose));
}
