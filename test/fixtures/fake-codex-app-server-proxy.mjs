import { createHash } from "node:crypto";

const WEB_SOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
let input = Buffer.alloc(0);
let upgraded = false;
let turnSequence = 0;
let activeTurnId;
const controlled = process.env.YUI_FAKE_CONTROLLED === "1";
const threadId = process.env.YUI_FAKE_THREAD_ID ?? "fake-thread-1";

process.stdin.on("data", (chunk) => {
  input = Buffer.concat([input, chunk]);
  if (!upgraded) upgrade();
  if (upgraded) receiveFrames();
});

function upgrade() {
  const end = input.indexOf("\r\n\r\n");
  if (end < 0) return;
  const request = input.subarray(0, end).toString("utf8");
  input = input.subarray(end + 4);
  const key = /^sec-websocket-key:\s*(.+)$/imu.exec(request)?.[1]?.trim();
  if (key === undefined) process.exit(2);
  const accept = createHash("sha1").update(`${key}${WEB_SOCKET_GUID}`).digest("base64");
  process.stdout.write(
    `HTTP/1.1 101 Switching Protocols\r\n`
    + `Upgrade: websocket\r\n`
    + `Connection: Upgrade\r\n`
    + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  upgraded = true;
}

function receiveFrames() {
  for (;;) {
    if (input.length < 2) return;
    const opcode = input[0] & 0x0f;
    const masked = (input[1] & 0x80) !== 0;
    let length = input[1] & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (input.length < 4) return;
      length = input.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (input.length < 10) return;
      const wide = input.readBigUInt64BE(2);
      if (wide > BigInt(Number.MAX_SAFE_INTEGER)) process.exit(3);
      length = Number(wide);
      offset = 10;
    }
    const maskLength = masked ? 4 : 0;
    if (input.length < offset + maskLength + length) return;
    const mask = masked ? input.subarray(offset, offset + 4) : undefined;
    offset += maskLength;
    const payload = Buffer.from(input.subarray(offset, offset + length));
    input = input.subarray(offset + length);
    if (mask !== undefined) {
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] ^= mask[index % 4];
      }
    }
    if (opcode === 0x8) {
      sendFrame(0x8, payload);
      process.exit(0);
    }
    if (opcode === 0x9) {
      sendFrame(0xA, payload);
      continue;
    }
    if (opcode !== 0x1) continue;
    handleMessage(JSON.parse(payload.toString("utf8")));
  }
}

function handleMessage(message) {
  const respond = (result) => sendJson({ id: message.id, result });
  switch (message.method) {
    case "initialize":
      respond({ codexHome: process.env.CODEX_HOME ?? "/tmp/fake-codex-home" });
      break;
    case "thread/start":
      respond({ thread: { id: threadId } });
      break;
    case "thread/resume":
      respond({ thread: { id: message.params.threadId, status: { type: "idle" }, turns: [] } });
      break;
    case "thread/name/set":
      respond({});
      break;
    case "thread/read":
      respond({
        thread: {
          id: message.params.threadId ?? threadId,
          status: { type: activeTurnId === undefined ? "idle" : "active" },
          turns: activeTurnId === undefined ? [] : [{ id: activeTurnId, status: "inProgress", items: [] }]
        }
      });
      break;
    case "thread/goal/get":
      respond({ goal: null });
      break;
    case "thread/backgroundTerminals/clean":
      respond({});
      break;
    case "thread/backgroundTerminals/list":
      respond({ data: [], nextCursor: null });
      break;
    case "turn/start":
      turnSequence += 1;
      const turnId = `fake-turn-${turnSequence}`;
      if (controlled) activeTurnId = turnId;
      respond({ turn: { id: turnId } });
      setImmediate(() => {
        sendJson({
          method: "turn/started",
          params: { threadId, turn: { id: turnId } }
        });
        if (controlled) return;
        sendJson({
          method: "turn/completed",
          params: {
            threadId,
            turn: {
              id: turnId,
              status: "completed",
              items: [{ id: "item-1", type: "agentMessage", text: "Native Codex result." }]
            }
          }
        });
      });
      break;
    case "turn/steer":
      respond({ turnId: `fake-turn-${turnSequence}` });
      break;
    case "turn/interrupt":
      respond({});
      activeTurnId = undefined;
      setImmediate(() => sendJson({
        method: "turn/completed",
        params: { threadId, turn: {
          id: `fake-turn-${turnSequence}`, status: "interrupted", items: []
        } }
      }));
      break;
    default:
      break;
  }
}

function sendJson(value) {
  sendFrame(0x1, Buffer.from(JSON.stringify(value), "utf8"));
}

function sendFrame(opcode, payload) {
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x80 | opcode, payload.length]);
  } else if (payload.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  process.stdout.write(Buffer.concat([header, payload]));
}
