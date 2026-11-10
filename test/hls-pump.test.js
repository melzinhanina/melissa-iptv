import test from "node:test";
import assert from "node:assert/strict";
import { hlsStats } from "../hls.js";

test("HLS exposes full VOD with on-demand random-access seeking", () => {
  const stats = hlsStats();

  assert.equal(stats.playlistMode, "vod");
  assert.equal(stats.seekMode, "on-demand-http-input-seek");
  assert.equal(stats.segmentSeconds, 6);
  assert.equal(stats.sessions, 0);
  assert.equal(stats.activeRequests, 0);
  assert.equal(stats.cachedSegments, 0);
});
