import http from "node:http";
import https from "node:https";

const SOURCE_URL = process.env.SOURCE_URL;
const RELAY_URL = process.env.RELAY_URL;
const STREAM_ID = process.env.STREAM_ID;
const TUNNEL_TOKEN = process.env.TUNNEL_TOKEN;

if (!SOURCE_URL || !RELAY_URL || !STREAM_ID || !TUNNEL_TOKEN) {
  console.error("Configure SOURCE_URL, RELAY_URL, STREAM_ID e TUNNEL_TOKEN.");
  process.exit(1);
}

const sourceUrl = new URL(SOURCE_URL);
const relayUrl = new URL(`/enviar/${encodeURIComponent(STREAM_ID)}`, RELAY_URL);

const sourceTransport = sourceUrl.protocol === "https:" ? https : http;
const relayTransport = relayUrl.protocol === "https:" ? https : http;

const sourceRequest = sourceTransport.get(sourceUrl, sourceResponse => {
  if (sourceResponse.statusCode < 200 || sourceResponse.statusCode >= 300) {
    console.error(`Origem respondeu HTTP ${sourceResponse.statusCode}`);
    sourceResponse.resume();
    process.exitCode = 1;
    return;
  }

  const headers = {
    authorization: `Bearer ${TUNNEL_TOKEN}`,
    "content-type": sourceResponse.headers["content-type"] || "application/octet-stream"
  };

  if (sourceResponse.headers["content-length"]) {
    headers["content-length"] = sourceResponse.headers["content-length"];
  }

  const upload = relayTransport.request(relayUrl, {
    method: "POST",
    headers
  }, response => {
    console.log(`Relay respondeu HTTP ${response.statusCode}`);
    response.pipe(process.stdout);
    response.on("end", () => {
      if (response.statusCode < 200 || response.statusCode >= 300) {
        process.exitCode = 1;
      }
    });
  });

  upload.on("error", error => {
    console.error("Falha ao enviar ao relay:", error.message);
    sourceRequest.destroy();
    process.exitCode = 1;
  });

  sourceResponse.on("error", error => {
    console.error("Falha na origem:", error.message);
    upload.destroy(error);
    process.exitCode = 1;
  });

  sourceResponse.pipe(upload);
});

sourceRequest.on("error", error => {
  console.error("Falha ao acessar a origem:", error.message);
  process.exitCode = 1;
});
