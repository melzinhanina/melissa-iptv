import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => listener.listen(0, "127.0.0.1", resolve).once("error", reject));
  const port = listener.address().port;
  await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  return port;
}

test("server starts with TMPDIR=/app while catalog remains in /tmp", { timeout: 25_000 }, async () => {
  const dataDir = "/tmp/melissa-iptv";
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(path.join(dataDir, "videos.json"), "[]\n");
  const port = await freePort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: { ...process.env, TMPDIR: "/app", PORT: String(port), PUBLIC_URL: `http://127.0.0.1:${port}` },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let output = "";
  child.stdout.on("data", chunk => { output += chunk.toString(); });
  child.stderr.on("data", chunk => { output += chunk.toString(); });

  try {
    const deadline = Date.now() + 15_000;
    let response;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) break;
      try {
        response = await fetch(`http://127.0.0.1:${port}/health`);
        break;
      } catch {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    assert.ok(response, `server did not become ready. Output: ${output}`);
    assert.equal(response.status, 200, output);
    const health = await response.json();
    assert.equal(health.status, "ok");
    assert.equal(health.videos, 0);
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([
        new Promise(resolve => child.once("exit", resolve)),
        new Promise(resolve => setTimeout(resolve, 3_000))
      ]);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
