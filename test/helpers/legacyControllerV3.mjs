import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const home = process.env.YUI_HOME;
if (home === undefined) throw new Error("YUI_HOME is required.");

const uid = typeof process.getuid === "function" ? process.getuid() : 0;
const socketIdentity = createHash("sha256").update(resolve(home)).digest("hex").slice(0, 24);
const socketPath = join(tmpdir(), `yui-${uid}`, `${socketIdentity}.sock`);
const discoveryPath = join(home, "runtime", "controller.json");
const token = randomBytes(32).toString("hex");
const processStat = readFileSync(`/proc/${process.pid}/stat`, "utf8");
const startIdentity = processStat
  .slice(processStat.lastIndexOf(")") + 1)
  .trim()
  .split(/\s+/u)[19];

mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
chmodSync(dirname(socketPath), 0o700);
mkdirSync(dirname(discoveryPath), { recursive: true, mode: 0o700 });
chmodSync(dirname(discoveryPath), 0o700);
rmSync(socketPath, { force: true });

let closing = false;
const server = createServer((socket) => {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    if (closing) return;
    buffer += chunk;
    const newline = buffer.indexOf("\n");
    if (newline < 0) return;
    let request;
    try {
      request = JSON.parse(buffer.slice(0, newline));
    } catch {
      socket.end(`${JSON.stringify({
        id: "invalid",
        ok: false,
        error: { code: "INVALID_REQUEST", message: "Invalid controller request." }
      })}\n`);
      return;
    }
    if (request.token !== token || request.method !== "controller.stop") {
      socket.end(`${JSON.stringify({
        id: request.id,
        ok: false,
        error: { code: "UNAUTHORIZED", message: "Controller authentication failed." }
      })}\n`);
      return;
    }
    if (request.params?.expectedPid !== process.pid) {
      socket.end(`${JSON.stringify({
        id: request.id,
        ok: false,
        error: { code: "CONTROLLER_OWNERSHIP_MISMATCH", message: "Controller PID mismatch." }
      })}\n`);
      return;
    }
    closing = true;
    socket.end(`${JSON.stringify({
      id: request.id,
      ok: true,
      result: { stopped: true, pid: process.pid }
    })}\n`, () => {
      server.close(() => {
        rmSync(discoveryPath, { force: true });
        rmSync(socketPath, { force: true });
        process.exit(0);
      });
    });
  });
});

server.listen(socketPath, () => {
  chmodSync(socketPath, 0o600);
  writeFileSync(discoveryPath, `${JSON.stringify({
    pid: process.pid,
    processStartIdentity: startIdentity,
    socketPath,
    token
  })}\n`, { mode: 0o600 });
  process.send?.({ type: "ready", pid: process.pid, socketPath });
});

function cleanup() {
  rmSync(discoveryPath, { force: true });
  rmSync(socketPath, { force: true });
}

process.on("SIGTERM", () => {
  cleanup();
  process.exit(0);
});
process.on("exit", cleanup);
