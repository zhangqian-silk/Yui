#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const SCENARIOS = new Set([
  "normal",
  "transport-only",
  "no-progress",
  "crash",
  "stop-failure",
  "late-event"
]);
const READY_TIMEOUT_MS = 3_000;
const MAX_DELAY_MS = 2_000;

export function parseMockClaudeArguments(argv) {
  const value = (name) => {
    const indexes = argv.flatMap((argument, index) => argument === name ? [index] : []);
    if (indexes.length !== 1 || indexes[0] + 1 >= argv.length) {
      throw new Error(`Mock Claude requires exactly one ${name}.`);
    }
    return argv[indexes[0] + 1];
  };
  const scenario = value("--yui-mock-scenario");
  if (!SCENARIOS.has(scenario)) {
    throw new Error(`Unsupported Mock Claude scenario: ${JSON.stringify(scenario)}.`);
  }
  const delayIndexes = argv.flatMap(
    (argument, index) => argument === "--yui-mock-delay-ms" ? [index] : []
  );
  if (delayIndexes.length > 1) {
    throw new Error("Mock Claude accepts at most one --yui-mock-delay-ms.");
  }
  const rawDelay = delayIndexes.length === 0 ? "0" : argv[delayIndexes[0] + 1];
  if (rawDelay === undefined || !/^\d+$/u.test(rawDelay)
    || Number(rawDelay) > MAX_DELAY_MS) {
    throw new Error(`Mock Claude delay must be an integer from 0 to ${MAX_DELAY_MS}.`);
  }
  const ownedRoot = value("--yui-mock-root");
  const observationPath = value("--yui-mock-observation");
  const readyPath = value("--yui-mock-ready");
  const pluginRoot = value("--plugin-dir");
  if (!isAbsolute(ownedRoot)
    || ![observationPath, readyPath, pluginRoot].every((path) => (
      isAbsolute(path) && isStrictlyInside(ownedRoot, path)
    ))) {
    throw new Error("Mock Claude paths must stay inside its absolute owned run root.");
  }
  return {
    scenario,
    delayMs: Number(rawDelay),
    ownedRoot: resolve(ownedRoot),
    observationPath: resolve(observationPath),
    readyPath: resolve(readyPath),
    pluginRoot: resolve(pluginRoot),
    nativeSessionId: value("--session-id")
  };
}

function isStrictlyInside(parent, child) {
  const path = relative(resolve(parent), resolve(child));
  return path.length > 0 && path !== ".." && !path.startsWith(`..${sep}`)
    && !isAbsolute(path);
}

async function main() {
  const input = parseMockClaudeArguments(process.argv.slice(2));
  if (typeof process.env.YUI_HOME !== "string"
    || !isStrictlyInside(input.ownedRoot, process.env.YUI_HOME)) {
    throw new Error("Mock Claude requires a disposable YUI_HOME inside its owned run root.");
  }
  const observe = (event, detail = {}) => appendFileSync(
    input.observationPath,
    `${JSON.stringify({
      event,
      scenario: input.scenario,
      nativeSessionId: input.nativeSessionId,
      processId: process.pid,
      ...detail
    })}\n`,
    "utf8"
  );
  const hooks = JSON.parse(readFileSync(`${input.pluginRoot}/hooks/hooks.json`, "utf8"));
  const invokeHook = (name, payload) => {
    const hook = hooks?.hooks?.[name]?.[0]?.hooks?.[0];
    if (hook === undefined || hook.type !== "command"
      || typeof hook.command !== "string" || !Array.isArray(hook.args)) {
      throw new Error(`Managed lifecycle plugin is missing ${name}.`);
    }
    const result = spawnSync(hook.command, hook.args, {
      encoding: "utf8",
      env: process.env,
      input: JSON.stringify({
        hook_event_name: name,
        session_id: input.nativeSessionId,
        ...payload
      })
    });
    observe("hook", {
      hook: name,
      exitCode: result.status,
      ...(result.stderr?.trim() ? { stderr: result.stderr.trim() } : {})
    });
    if (result.status !== 0) {
      throw new Error(`Managed ${name} hook failed with exit ${result.status}.`);
    }
  };

  for (let waited = 0; !existsSync(input.readyPath); waited += 10) {
    if (waited >= READY_TIMEOUT_MS) throw new Error("Mock Claude readiness fence timed out.");
    await delay(10);
  }

  observe("process-started", {
    yuiHome: process.env.YUI_HOME,
    taskId: process.env.YUI_TASK_ID,
    roleName: process.env.YUI_ROLE,
    agentId: process.env.YUI_AGENT_ID,
    adapterId: process.env.YUI_ADAPTER_ID,
    launchId: process.env.YUI_LAUNCH_ID,
    runId: process.env.YUI_RUN_ID
  });
  if (input.scenario === "crash") {
    observe("crash", { exitCode: 23 });
    process.exitCode = 23;
    return;
  }
  if (input.scenario === "no-progress") {
    setInterval(() => {}, 1_000);
    await new Promise(() => {});
  }
  invokeHook("SessionStart", { source: "startup" });
  observe("session-start");
  if (input.scenario === "stop-failure") {
    invokeHook("StopFailure", {
      error: "mock_stop_failure",
      error_details: "deterministic local Mock Agent failure",
      last_assistant_message: "Mock Agent stopped before completion."
    });
    observe("stop-failure", { exitCode: 70 });
    process.exitCode = 70;
    return;
  }

  process.stdin.setEncoding("utf8");
  let buffered = "";
  for await (const chunk of process.stdin) {
    buffered += chunk;
    const newline = buffered.indexOf("\n");
    if (newline < 0) continue;
    const frame = JSON.parse(buffered.slice(0, newline).replaceAll("\r", ""));
    const prompt = frame?.type === "user"
      && frame?.message?.role === "user"
      && Array.isArray(frame?.message?.content)
      && frame.message.content.length === 1
      && frame.message.content[0]?.type === "text"
      && typeof frame.message.content[0]?.text === "string"
      ? frame.message.content[0].text
      : undefined;
    if (prompt === undefined) throw new Error("Mock Claude received an invalid stream-json user frame.");
    observe("transport-received", { prompt });
    if (input.scenario === "normal" || input.scenario === "late-event") {
      if (input.delayMs > 0) await delay(input.delayMs);
      invokeHook("UserPromptSubmit", { prompt });
      observe("prompt-accepted", { prompt });
      observe("complete");
    }
    return;
  }
}

if (process.argv[1] !== undefined
  && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 70;
  });
}
