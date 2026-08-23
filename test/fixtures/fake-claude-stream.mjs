import { createInterface } from "node:readline";

const sessionId = process.argv[2];
const lines = createInterface({ input: process.stdin });

lines.on("line", (line) => {
  const message = JSON.parse(line);
  process.stdout.write(`${JSON.stringify({ ...message, session_id: sessionId })}\n`);
});
