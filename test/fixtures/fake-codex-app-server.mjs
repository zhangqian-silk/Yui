import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const mode = process.argv[2] ?? "accept";
const evidencePath = process.argv[3];
const lines = createInterface({ input: process.stdin });

lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialized") return;
  if (request.method === "initialize") {
    reply(request.id, { userAgent: "fake" });
    return;
  }
  if (request.method === "thread/start") {
    reply(request.id, { thread: { id: `thread-${mode}-1` } });
    return;
  }
  if (request.method === "thread/resume") {
    if (mode === "missing") {
      process.stdout.write(`${JSON.stringify({
        id: request.id,
        error: { code: "NOT_FOUND", message: "thread not found" }
      })}\n`);
    } else {
      reply(request.id, {
        thread: {
          id: request.params.threadId,
          status: { type: "idle" },
          turns: []
        }
      });
    }
    return;
  }
  if (request.method === "thread/name/set") {
    if (evidencePath !== undefined) appendFileSync(evidencePath, "thread/name/set\n");
    reply(request.id, {});
    return;
  }
  if (request.method === "thread/read") {
    if (mode === "unmaterialized") {
      process.stdout.write(`${JSON.stringify({
        id: request.id,
        error: {
          code: -32600,
          message: `thread thread-${mode}-1 is not materialized yet; includeTurns is unavailable before first user message`
        }
      })}\n`);
      return;
    }
    reply(request.id, {
      thread: {
        id: request.params.threadId,
        status: { type: "idle" },
        turns: []
      }
    });
    return;
  }
  if (request.method !== "turn/start") return;
  if (evidencePath !== undefined) appendFileSync(evidencePath, "turn/start\n");
  if (mode === "unknown") {
    process.exit(17);
    return;
  }
  const text = request.params.input?.[0];
  if (request.params.clientUserMessageId !== "task-1/agentRun/run-1"
    || text?.text !== "perform the managed work"
    || !Array.isArray(text?.text_elements)) {
    process.stdout.write(`${JSON.stringify({
      id: request.id,
      error: { code: -32602, message: "invalid managed input" }
    })}\n`);
    return;
  }
  setTimeout(() => reply(request.id, { turn: { id: "turn-structured-1" } }), 15);
});

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ id, result })}\n`);
}
