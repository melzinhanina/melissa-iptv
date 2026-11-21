const DEFAULT_MAX_BYTES = 128 * 1024 * 1024;
const DEFAULT_MAX_SEGMENT_BYTES = 16 * 1024 * 1024;
const DEFAULT_TTL_MS = 10 * 60 * 1000;
const MAX_TTL_MS = 60 * 60 * 1000;

export function createSegmentCache(options = {}) {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxSegmentBytes = options.maxSegmentBytes ?? DEFAULT_MAX_SEGMENT_BYTES;
  const defaultTtlMs = options.defaultTtlMs ?? DEFAULT_TTL_MS;
  const maxTtlMs = options.maxTtlMs ?? MAX_TTL_MS;
  const entries = new Map();
  let usedBytes = 0;

  function remove(key) {
    const entry = entries.get(key);
    if (!entry) return false;
    usedBytes -= entry.data.length;
    entries.delete(key);
    return true;
  }

  function purgeExpired(now = Date.now()) {
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= now) remove(key);
    }
  }

  function keyFor(streamId, segmentId) {
    return streamId + "/" + segmentId;
  }

  async function put(streamId, segmentId, request) {
    const key = keyFor(streamId, segmentId);
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > maxSegmentBytes) {
        tooLarge = true;
        continue;
      }
      if (!tooLarge) chunks.push(chunk);
    }
    if (tooLarge) {
      const error = new Error("Segment exceeds maximum size");
      error.statusCode = 413;
      throw error;
    }

    const data = Buffer.concat(chunks, size);
    if (data.length === 0) {
      const error = new Error("Empty segments are not cached");
      error.statusCode = 400;
      throw error;
    }
    if (data.length > maxBytes) {
      const error = new Error("Segment exceeds total cache capacity");
      error.statusCode = 413;
      throw error;
    }

    purgeExpired();
    remove(key);

    while (usedBytes + data.length > maxBytes) {
      let oldestKey;
      let oldestAccess = Infinity;
      for (const [candidateKey, entry] of entries) {
        if (entry.lastAccessedAt < oldestAccess) {
          oldestAccess = entry.lastAccessedAt;
          oldestKey = candidateKey;
        }
      }
      if (oldestKey === undefined) break;
      remove(oldestKey);
    }

    const requestedTtl = Number(request.headers["x-cache-ttl"]);
    const ttlMs = Number.isFinite(requestedTtl) && requestedTtl > 0
      ? Math.min(requestedTtl * 1000, maxTtlMs)
      : defaultTtlMs;
    const now = Date.now();
    const entry = {
      data,
      contentType: request.headers["content-type"] || "application/octet-stream",
      createdAt: now,
      lastAccessedAt: now,
      expiresAt: now + ttlMs
    };
    entries.set(key, entry);
    usedBytes += data.length;
    return { size: data.length, expiresAt: entry.expiresAt };
  }

  function get(streamId, segmentId) {
    purgeExpired();
    const entry = entries.get(keyFor(streamId, segmentId));
    if (!entry) return null;
    entry.lastAccessedAt = Date.now();
    return entry;
  }

  function list(streamId) {
    purgeExpired();
    const prefix = streamId + "/";
    const result = [];
    for (const [key, entry] of entries) {
      if (!key.startsWith(prefix)) continue;
      result.push({
        id: key.slice(prefix.length),
        size: entry.data.length,
        contentType: entry.contentType,
        createdAt: new Date(entry.createdAt).toISOString(),
        expiresAt: new Date(entry.expiresAt).toISOString()
      });
    }
    result.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
    return result;
  }

  function deleteSegment(streamId, segmentId) {
    return remove(keyFor(streamId, segmentId));
  }

  function stats() {
    purgeExpired();
    return { usedBytes, maxBytes, segments: entries.size };
  }

  return { put, get, list, deleteSegment, stats };
}
