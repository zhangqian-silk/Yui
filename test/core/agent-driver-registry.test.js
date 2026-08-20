import assert from "node:assert/strict";
import test from "node:test";

import {
  AgentDriverRegistry,
  managedRuntimeAdmission,
  validateAgentDriverCapabilities
} from "../../dist/runtime/agentDriver.js";
import { parseRuntimeObservationHook } from "../../dist/controller/runtimeObservationHook.js";

const FULL = Object.freeze({
  surfaces: ["managed-protocol", "interactive-cli"],
  control: {
    start: true,
    resume: true,
    sendTurn: true,
    interrupt: true,
    stop: true
  },
  observation: {
    sessionIdentity: "exact",
    sessionBootstrap: "discovered",
    preInputReadiness: "exact",
    promptAcceptance: "exact",
    turnLifecycle: "exact",
    operations: ["model", "tool", "subagent"],
    waiting: ["user", "permission", "external"],
    usage: "streaming-cumulative",
    delivery: "ordered-replayable"
  }
});

test("the Driver registry accepts an opaque namespaced Driver without core changes", () => {
  const registry = new AgentDriverRegistry();
  registry.register({
    id: "example/future-agent",
    label: "Future Agent",
    protocolVersion: 1,
    adapterId: "future-agent",
    capabilities: FULL,
    runtime: {
      nativeSessionId({ payload }) { return payload.conversation_id; },
      nativeTurnId({ payload }) { return payload.execution_id; },
      mapHook({ hookEventName }) {
        assert.equal(hookEventName, "TurnQueued");
        return { kind: "turn.accepted", payload: {} };
      },
      classifyHook() {
        return {
          startupSession: "discovered",
          terminal: false
        };
      },
      observer: {
        source: () => null,
        async sample() { return { cursor: {}, status: "healthy" }; }
      }
    }
  });

  assert.equal(registry.require("example/future-agent").label, "Future Agent");
  assert.throws(() => registry.register({
    id: "example/future-agent",
    label: "Duplicate",
    protocolVersion: 1,
    adapterId: "future-agent",
    capabilities: FULL,
    runtime: {
      nativeSessionId() { return undefined; },
      nativeTurnId() { return undefined; },
      mapHook() { return { kind: "turn.accepted", payload: {} }; },
      classifyHook() { return {}; }
    }
  }), /already registered/);
});

test("an opaque registered Driver crosses the canonical Hook ingress without a core switch", () => {
  const registry = new AgentDriverRegistry();
  registry.register({
    id: "example/future-agent",
    label: "Future Agent",
    protocolVersion: 1,
    adapterId: "future-agent",
    capabilities: FULL,
    runtime: {
      nativeSessionId({ payload }) { return payload.conversation_id; },
      nativeTurnId({ payload }) { return payload.execution_id; },
      mapHook({ hookEventName }) {
        assert.equal(hookEventName, "TurnQueued");
        return { kind: "turn.accepted", payload: {} };
      },
      classifyHook() {
        return {
          startupSession: "discovered",
          terminal: false
        };
      },
      observer: {
        source({ payload }) {
          return {
            schemaVersion: 1,
            sourceId: "future-source-1",
            transport: "append-only-jsonl",
            locator: payload.stream_locator
          };
        },
        async sample() {
          return { cursor: {}, status: "healthy" };
        }
      }
    }
  });
  const parsed = parseRuntimeObservationHook(
    JSON.stringify({
      hook_event_name: "TurnQueued",
      conversation_id: "native-future-1",
      execution_id: "native-turn-1",
      stream_locator: "/tmp/future-agent.jsonl"
    }),
    {
      YUI_HOME: "/tmp/yui-future-driver",
      YUI_DRIVER_ID: "example/future-agent",
      YUI_ADAPTER_ID: "future-agent"
    },
    new Date("2026-08-19T00:00:00.000Z"),
    {
      drivers: registry,
      sequence: () => 7,
      resolveRunFence(_environment, adapterId, nativeSessionId, options) {
        assert.equal(adapterId, "future-agent");
        assert.equal(nativeSessionId, "native-future-1");
        assert.deepEqual(options, {
          startupSession: "discovered",
          terminal: false,
          nativeTurnId: "native-turn-1"
        });
        return {
          taskId: "task-1",
          roleName: "worker",
          runId: "run-1",
          agentId: "agent-1",
          launchId: "launch-1",
          receiptId: "task-task-1-run-run-1",
          nativeSessionId,
          workspace: "/workspace"
        };
      }
    }
  );

  assert.deepEqual(parsed.observations.map((observation) => ({
    kind: observation.kind,
    driverId: observation.fence.driverId,
    nativeTurnId: observation.fence.nativeTurnId,
    sequence: observation.sequence,
    observerSource: observation.payload.observerSource
  })), [
    {
      kind: "turn.accepted",
      driverId: "example/future-agent",
      nativeTurnId: "native-turn-1",
      sequence: 7,
      observerSource: {
        schemaVersion: 1,
        sourceId: "future-source-1",
        transport: "append-only-jsonl",
        locator: "/tmp/future-agent.jsonl"
      }
    }
  ]);
});

test("managed automation requires exact identity, acceptance, terminal, resume and interrupt", () => {
  assert.deepEqual(managedRuntimeAdmission(validateAgentDriverCapabilities(FULL)), {
    admitted: true
  });

  assert.deepEqual(managedRuntimeAdmission(validateAgentDriverCapabilities({
    ...FULL,
    observation: { ...FULL.observation, promptAcceptance: "unavailable" }
  })), {
    admitted: false,
    missing: ["exact-prompt-acceptance"]
  });

  assert.deepEqual(managedRuntimeAdmission(validateAgentDriverCapabilities({
    ...FULL,
    control: { ...FULL.control, resume: false }
  })), {
    admitted: false,
    missing: ["resume"]
  });
});
