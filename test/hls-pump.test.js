import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";

test("HLS pump preserves the rest of a reader chunk across prefetch pauses", { timeout: 5_000 }, async () => {
  const previousPrefetch = process.env.HLS_PREFETCH_SEGMENTS;
  process.env.HLS_PREFETCH_SEGMENTS = "2";
  let pump;
  try {
    ({ pump } = await import("../hls.js?hls-pump-regression"));
  } finally {
    if (previousPrefetch === undefined) delete process.env.HLS_PREFETCH_SEGMENTS;
    else process.env.HLS_PREFETCH_SEGMENTS = previousPrefetch;
  }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "melissa-hls-pump-"));
  const source = Buffer.alloc(200_000);
  for (let i = 0; i < source.length; i++) source[i] = i % 251;

  const received = [];
  let readerCalls = 0;
  const stdin = new Writable({
    highWaterMark: 128 * 1024,
    write(chunk, _encoding, callback) {
      received.push(Buffer.from(chunk));
      if (received.length === 1) {
        fsSync.writeFileSync(path.join(dir, "segment_00000.ts"), "segment");
        fsSync.writeFileSync(path.join(dir, "segment_00001.ts"), "segment");
      }
      callback();
    }
  });

  const session = {
    id: "regression-test",
    dir,
    reader: {
      async read() {
        readerCalls++;
        return readerCalls === 1
          ? { done: false, value: source }
          : { done: true, value: undefined };
      }
    },
    ffmpeg: { stdin },
    requestedThrough: -1,
    produced: 0,
    pumping: false,
    eof: false,
    error: null,
    closed: false,
    waiters: new Set()
  };

  const advancePlayer = setTimeout(() => {
    session.requestedThrough = 1;
    for (const wake of [...session.waiters]) wake();
  }, 100);

  try {
    await pump(session);
    assert.deepEqual(Buffer.concat(received), source);
    assert.equal(readerCalls, 2);
    assert.equal(session.eof, true);
  } finally {
    clearTimeout(advancePlayer);
    stdin.destroy();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
