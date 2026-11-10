import http from "node:http";
import { PassThrough } from "node:stream";

const PORT = Number(process.env.PORT || 18080);
const TUNNEL_TOKEN = process.env.TUNNEL_TOKEN || "";
const transfers = new Map();

if (!TUNNEL_TOKEN) {
  console.error("TUNNEL_TOKEN não configurado.");
  process.exit(1);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("ok");
    return;
  }

  const match = url.pathname.match(/^\/(enviar|receber)\/([A-Za-z0-9._-]{1,128})$/);

  if (!match || match[2] === "." || match[2] === "..") {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const [, action, id] = match;

  if (action === "enviar") {
    receiveData(req, res, id);
    return;
  }

  sendData(req, res, id);
});

function getTransfer(id) {
  let transfer = transfers.get(id);

  if (!transfer) {
    transfer = {
      stream: new PassThrough(),
      sender: null,
      senderResponse: null,
      receiver: null,
      contentType: "application/octet-stream",
      started: false
    };

    transfers.set(id, transfer);

    transfer.stream.on("end", () => removeTransfer(id, transfer));
    transfer.stream.on("close", () => removeTransfer(id, transfer));
  }

  return transfer;
}

function receiveData(req, res, id) {
  if (req.headers.authorization !== `Bearer ${TUNNEL_TOKEN}`) {
    res.writeHead(401);
    res.end("Unauthorized");
    return;
  }

  const transfer = getTransfer(id);

  if (transfer.sender) {
    res.writeHead(409);
    res.end("Sender already connected");
    return;
  }

  transfer.sender = req;
  transfer.senderResponse = res;
  transfer.contentType = req.headers["content-type"] || "application/octet-stream";

  req.on("aborted", () => {
    transfer.stream.destroy(new Error("Sender disconnected"));
    if (transfer.receiver && !transfer.receiver.writableEnded) {
      transfer.receiver.destroy();
    }
    removeTransfer(id, transfer);
  });

  req.on("error", () => {
    transfer.stream.destroy();
    if (transfer.receiver && !transfer.receiver.writableEnded) {
      transfer.receiver.destroy();
    }
    removeTransfer(id, transfer);
  });

  req.on("end", () => {
    transfer.stream.end();

    if (!res.headersSent) {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end(" enviado");
    }
  });

  req.pipe(transfer.stream);
  startTransfer(transfer);
}

function sendData(req, res, id) {
  const transfer = getTransfer(id);

  if (transfer.receiver) {
    res.writeHead(409);
    res.end("Receiver already connected");
    return;
  }

  transfer.receiver = res;

  res.on("close", () => {
    if (!res.writableEnded) {
      transfer.stream.destroy(new Error("Receiver disconnected"));

      if (transfer.sender && !transfer.sender.destroyed) {
        transfer.sender.destroy();
      }

      if (transfer.senderResponse && !transfer.senderResponse.writableEnded) {
        transfer.senderResponse.destroy();
      }

      removeTransfer(id, transfer);
    }
  });

  startTransfer(transfer);
}

function startTransfer(transfer) {
  if (transfer.started || !transfer.sender || !transfer.receiver) return;

  transfer.started = true;

  transfer.receiver.writeHead(200, {
    "content-type": transfer.contentType,
    "cache-control": "no-store",
    "x-accel-buffering": "no"
  });

  transfer.stream.pipe(transfer.receiver);
}

function removeTransfer(id, transfer) {
  if (transfers.get(id) === transfer) {
    transfers.delete(id);
  }
}

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Relay ouvindo na porta ${PORT}`);
});
