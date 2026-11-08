import test from "node:test";
import assert from "node:assert/strict";

test("runtime writable paths stay under /tmp even when TMPDIR points to /app", async () => {
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = "/app";
  try {
    const paths = await import("../storage-paths.js?hostless-readonly-test");
    assert.equal(paths.DATA_DIR, "/tmp/melissa-iptv");
    assert.equal(paths.HLS_DIR, "/tmp/melissa-iptv/hls");
  } finally {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
  }
});
