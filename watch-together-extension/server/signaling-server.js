#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const http = require("http");

const PORT = Number(process.env.PORT || 8787);
const rooms = new Map();

function send(client, message) {
  if (!client.socket.writable) return;
  const body = Buffer.from(JSON.stringify(message));
  const header = [];

  if (body.length < 126) {
    header.push(0x81, body.length);
  } else if (body.length < 65536) {
    header.push(0x81, 126, body.length >> 8, body.length & 255);
  } else {
    const length = BigInt(body.length);
    header.push(0x81, 127);
    for (let i = 7; i >= 0; i -= 1) {
      header.push(Number((length >> BigInt(i * 8)) & 255n));
    }
  }

  client.socket.write(Buffer.concat([Buffer.from(header), body]));
}

function broadcast(room, senderId, message) {
  const clients = rooms.get(room) || new Map();
  for (const [id, client] of clients) {
    if (id !== senderId) send(client, { ...message, from: senderId });
  }
}

function cleanup(client) {
  const clients = rooms.get(client.room);
  if (!clients) return;
  clients.delete(client.id);
  broadcast(client.room, client.id, { type: "peer-left" });
  if (clients.size === 0) rooms.delete(client.room);
}

function parseFrames(buffer, onMessage) {
  let offset = 0;

  while (offset + 2 <= buffer.length) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    let length = second & 127;
    let cursor = offset + 2;

    if (length === 126) {
      if (cursor + 2 > buffer.length) break;
      length = buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (length === 127) {
      if (cursor + 8 > buffer.length) break;
      const bigLength = buffer.readBigUInt64BE(cursor);
      if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Frame too large");
      length = Number(bigLength);
      cursor += 8;
    }

    const masked = (second & 128) !== 0;
    const opcode = first & 15;
    const mask = masked ? buffer.subarray(cursor, cursor + 4) : null;
    cursor += masked ? 4 : 0;

    if (cursor + length > buffer.length) break;
    const payload = Buffer.from(buffer.subarray(cursor, cursor + length));
    offset = cursor + length;

    if (masked) {
      for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
    }

    if (opcode === 0x8) return buffer.subarray(offset);
    if (opcode === 0x1) onMessage(payload.toString("utf8"));
  }

  return buffer.subarray(offset);
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("Watch Together signaling server is running.\n");
});

server.on("upgrade", (req, socket) => {
  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const room = (url.searchParams.get("room") || "default").trim().slice(0, 64);
  const name = (url.searchParams.get("name") || "Guest").trim().slice(0, 40);
  const id = crypto.randomUUID();
  const accept = crypto
    .createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");

  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "",
    "",
  ].join("\r\n"));

  if (!rooms.has(room)) rooms.set(room, new Map());
  const clients = rooms.get(room);
  const client = { id, name, room, socket };
  clients.set(id, client);

  send(client, {
    type: "joined",
    id,
    room,
    initiator: clients.size > 1,
    peerCount: clients.size,
  });
  broadcast(room, id, { type: "peer-joined", name, peerCount: clients.size });

  let pending = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    pending = parseFrames(pending, (raw) => {
      try {
        const message = JSON.parse(raw);
        if (message.type === "signal" || message.type === "sync" || message.type === "chat-state") {
          broadcast(room, id, message);
        }
      } catch {
        send(client, { type: "error", message: "Invalid JSON message" });
      }
    });
  });

  socket.on("close", () => cleanup(client));
  socket.on("error", () => cleanup(client));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("PORT =", PORT);
  console.log("Server started");
});
