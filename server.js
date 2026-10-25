const http = require("node:http");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const PORT = Number(process.env.PORT) || 3000;
const TIKWM_API = "https://www.tikwm.com/api/";
const MAX_BODY_BYTES = 8 * 1024;
const MAX_VIDEO_BYTES = 500 * 1024 * 1024;

function sendJson(res, status, payload) {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

async function readJson(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk.toString("utf8");
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
      const error = new Error("Request body too large");
      error.statusCode = 413;
      throw error;
    }
  }
  try {
    return JSON.parse(body);
  } catch {
    const error = new Error("Invalid JSON");
    error.statusCode = 400;
    throw error;
  }
}

function isTikTokUrl(value) {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" &&
      /(^|\.)tiktok\.com$/i.test(parsed.hostname);
  } catch {
    return false;
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    return sendJson(res, 200, {
      status: "online",
      service: "Melissa API",
      provider: "TikWM"
    });
  }

  if (req.method !== "POST" || req.url !== "/download") {
    return sendJson(res, 404, { error: "Not found" });
  }

  let upstream;
  try {
    const { url } = await readJson(req);
    if (!isTikTokUrl(url)) {
      return sendJson(res, 400, {
        error: "Send a valid HTTPS TikTok URL in the url field"
      });
    }

    console.log("[download] Request received");

    const lookup = await fetch(TIKWM_API, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": "MelissaAPI/1.0"
      },
      body: new URLSearchParams({ url, hd: "1" }),
      signal: AbortSignal.timeout(30000)
    });

    if (!lookup.ok) {
      throw new Error("TikWM returned HTTP " + lookup.status);
    }

    const result = await lookup.json();
    if (result.code !== 0 || !result.data) {
      throw new Error(result.msg || "TikWM did not return video data");
    }

    const videoUrl = result.data.hdplay || result.data.play;
    if (typeof videoUrl !== "string") {
      throw new Error("Video URL missing from TikWM response");
    }

    const parsedVideoUrl = new URL(videoUrl);
    if (parsedVideoUrl.protocol !== "https:") {
      throw new Error("TikWM returned an unsupported video URL");
    }

    upstream = await fetch(parsedVideoUrl, {
      headers: { "user-agent": "Mozilla/5.0 MelissaAPI/1.0" },
      signal: AbortSignal.timeout(120000)
    });

    if (!upstream.ok || !upstream.body) {
      throw new Error("Could not fetch the video (HTTP " + upstream.status + ")");
    }

    const contentLength = Number(upstream.headers.get("content-length") || 0);
    if (contentLength > MAX_VIDEO_BYTES) {
      await upstream.body.cancel();
      return sendJson(res, 413, { error: "Video exceeds the 500 MB test limit" });
    }

    res.writeHead(200, {
      "content-type": upstream.headers.get("content-type")?.includes("video")
        ? upstream.headers.get("content-type")
        : "video/mp4",
      "content-disposition": 'attachment; filename="melissa-video.mp4"',
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    });

    let bytesSent = 0;
    const source = Readable.fromWeb(upstream.body);
    source.on("data", (chunk) => {
      bytesSent += chunk.length;
      if (bytesSent > MAX_VIDEO_BYTES) {
        source.destroy(new Error("Video exceeds the 500 MB test limit"));
      }
    });

    await pipeline(source, res);
    console.log("[download] Stream completed:", bytesSent, "bytes");
  } catch (error) {
    if (upstream?.body && !upstream.bodyUsed) {
      upstream.body.cancel().catch(() => {});
    }
    console.error("[download] Error:", error.message);
    if (!res.headersSent) {
      sendJson(res, error.statusCode || 502, {
        error: error.statusCode === 413
          ? "Request too large"
          : "Download failed",
        message: error.message
      });
    } else if (!res.destroyed) {
      res.destroy(error);
    }
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Melissa API listening on port ${PORT}`);
});
