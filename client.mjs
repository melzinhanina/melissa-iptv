import http from "node:http";
import https from "node:https";
import { WebSocket } from "ws";

const TUNNEL_URL = process.env.TUNNEL_URL;
const TUNNEL_TOKEN = process.env.TUNNEL_TOKEN;
const LOCAL_ORIGIN = process.env.LOCAL_ORIGIN || "http://127.0.0.1:8000";

if (!TUNNEL_URL || !TUNNEL_TOKEN) {
  console.error("TUNNEL_URL e TUNNEL_TOKEN são obrigatórios.");
  process.exit(1);
}

let ws;
let reconnectTimer;
const activeRequests = new Map();

connect();

function connect() {
  const url = new URL(TUNNEL_URL);
  url.searchParams.set("token", TUNNEL_TOKEN);

  console.log(`Conectando ao tunnel: ${url.origin}`);

  ws = new WebSocket(url, {
    perMessageDeflate: false
  });

  ws.on("open", () => {
    console.log("Tunnel conectado.");
  });

  ws.on("message", (data, isBinary) => {
    if (!isBinary) {
      handleJson(JSON.parse(data.toString()));
      return;
    }

    const buf = Buffer.from(data);
    if (buf.length < 5) return;

    const id = buf.readUInt32BE(0);
    const kind = buf[4];
    const payload = buf.subarray(5);
    const state = activeRequests.get(id);

    if (!state) return;

    if (kind === 0x01) {
      state.req.write(payload);
      return;
    }

    if (kind === 0x02) {
      state.req.end();
      return;
    }

    if (kind === 0x07) {
      state.req.destroy();
      activeRequests.delete(id);
    }
  });

  ws.on("close", () => {
    console.log("Tunnel desconectado.");
    for (const state of activeRequests.values()) {
      state.req.destroy();
    }
    activeRequests.clear();
    scheduleReconnect();
  });

  ws.on("error", err => {
    console.error("Tunnel:", err.message);
  });
}

function handleJson(msg) {
  if (msg.type === "hello") {
    return;
  }

  if (msg.type === "request") {
    handleIncomingRequest(msg);
    return;
  }

  if (msg.type === "cancel") {
    const state = activeRequests.get(msg.id);
    if (state) {
      state.req.destroy();
      activeRequests.delete(msg.id);
    }
    return;
  }
}

function handleIncomingRequest(msg) {
  let target;

  try {
    target = new URL(msg.url, LOCAL_ORIGIN);
  } catch {
    sendError(msg.id, "URL local inválida");
    return;
  }

  const transport = target.protocol === "https:" ? https : http;

  const headers = { ...msg.headers };
  delete headers.host;
  delete headers.connection;

  const req = transport.request(target, {
    method: msg.method,
    headers
  });

  const state = { req };
  activeRequests.set(msg.id, state);

  req.on("response", res => {
    const responseHeaders = { ...res.headers };
    delete responseHeaders.connection;
    delete responseHeaders["transfer-encoding"];

    sendJson({
      type: "response",
      id: msg.id,
      statusCode: res.statusCode,
      headers: responseHeaders
    });

    res.on("data", chunk => sendBinary(msg.id, 0x04, chunk));
    res.on("end", () => {
      sendBinary(msg.id, 0x05, Buffer.alloc(0));
      activeRequests.delete(msg.id);
    });
    res.on("error", err => {
      sendError(msg.id, err.message);
      activeRequests.delete(msg.id);
    });
  });

  req.on("error", err => {
    sendError(msg.id, err.message);
    activeRequests.delete(msg.id);
  });

  if (msg.method === "GET" || msg.method === "POST" || msg.method === "PUT" ||
      msg.method === "PATCH" || msg.method === "DELETE") {
    return;
  }

  req.end();
}

function sendJson(value) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(value));
  }
}

function sendBinary(id, kind, payload) {
  if (ws?.readyState !== WebSocket.OPEN) return;

  const frame = Buffer.allocUnsafe(5 + payload.length);
  frame.writeUInt32BE(id, 0);
  frame[4] = kind;
  payload.copy(frame, 5);
  ws.send(frame);
}

function sendError(id, message) {
  sendBinary(id, 0x06, Buffer.from(message));
}

function scheduleReconnect() {
  if (reconnectTimer) return;

  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    connect();
  }, 3000);
}
