import http from "node:http";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT || 18080);
const TUNNEL_TOKEN = process.env.TUNNEL_TOKEN || "";

if (!TUNNEL_TOKEN) {
  console.error("TUNNEL_TOKEN não configurado.");
  process.exit(1);
}

const server = http.createServer((req, res) => {
  const tunnel = activeTunnel;

  if (!tunnel || tunnel.readyState !== tunnel.OPEN) {
    res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
    res.end("Tunnel offline");
    return;
  }

  const id = nextRequestId++;
  pending.set(id, res);

  tunnel.send(JSON.stringify({
    type: "request",
    id,
    method: req.method,
    url: req.url,
    headers: req.headers
  }));

  req.on("data", chunk => sendBinary(tunnel, id, 0x01, chunk));
  req.on("end", () => sendBinary(tunnel, id, 0x02, Buffer.alloc(0)));
  req.on("error", err => {
    sendJson(tunnel, { type: "client-error", id, message: err.message });
    cleanupRequest(id);
  });

  res.on("close", () => {
    if (pending.has(id)) {
      sendJson(tunnel, { type: "cancel", id });
      cleanupRequest(id);
    }
  });
});

let activeTunnel = null;
let nextRequestId = 1;
const pending = new Map();

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (req.url !== "/tunnel") {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, ws => {
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", (ws, req) => {
  const token = new URL(req.url, "http://tunnel.local").searchParams.get("token");

  if (token !== TUNNEL_TOKEN) {
    ws.close(1008, "unauthorized");
    return;
  }

  if (activeTunnel && activeTunnel.readyState === activeTunnel.OPEN) {
    activeTunnel.close(1012, "replaced");
  }

  activeTunnel = ws;

  ws.send(JSON.stringify({
    type: "hello",
    version: 1
  }));

  ws.on("message", (data, isBinary) => {
    if (!isBinary) {
      handleJson(ws, JSON.parse(data.toString()));
      return;
    }

    const buf = Buffer.from(data);
    if (buf.length < 5) return;

    const id = buf.readUInt32BE(0);
    const kind = buf[4];
    const payload = buf.subarray(5);
    const res = pending.get(id);

    if (!res) return;

    if (kind === 0x03) {
      const headerLength = payload.readUInt32BE(0);
      const headers = JSON.parse(payload.subarray(4, 4 + headerLength).toString());
      res.writeHead(headers.statusCode, headers.headers);
      return;
    }

    if (kind === 0x04) {
      res.write(payload);
      return;
    }

    if (kind === 0x05) {
      res.end();
      cleanupRequest(id);
      return;
    }

    if (kind === 0x06) {
      res.destroy(new Error(payload.toString() || "Tunnel request failed"));
      cleanupRequest(id);
    }
  });

  ws.on("close", () => {
    if (activeTunnel === ws) activeTunnel = null;

    for (const [id, res] of pending) {
      res.destroy(new Error("Tunnel disconnected"));
      pending.delete(id);
    }
  });

  ws.on("error", () => {});
});

function sendJson(ws, value) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(value));
  }
}

function sendBinary(ws, id, kind, payload) {
  if (ws.readyState !== ws.OPEN) return;

  const frame = Buffer.allocUnsafe(5 + payload.length);
  frame.writeUInt32BE(id, 0);
  frame[4] = kind;
  payload.copy(frame, 5);
  ws.send(frame);
}

function cleanupRequest(id) {
  pending.delete(id);
}

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Tunnel server ouvindo na porta ${PORT}`);
});
