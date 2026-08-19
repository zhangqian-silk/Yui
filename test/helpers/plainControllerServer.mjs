import { startControllerServer } from "../../dist/core/controllerServer.js";

const home = process.env.YUI_HOME;
if (home === undefined) throw new Error("YUI_HOME is required.");

const server = await startControllerServer(home);
process.send?.({ type: "ready", pid: process.pid });

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await server.close();
  process.exit(0);
}

process.on("SIGTERM", () => void close());
process.on("SIGINT", () => void close());
