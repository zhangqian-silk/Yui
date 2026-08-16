// Test helper: install the authenticated global Operator session into a store
// and return the environment that satisfies isCurrentGlobalOperator.
//
// Grant issue and revoke require the authenticated Operator origin. Tests that
// exercise the positive path use this helper to present that origin; tests
// that exercise the negative path present a managed or scrubbed environment
// instead. The returned `granter` is the origin-bound identity the command
// records (operator:<agent-id>).

import { createGlobalRole, createRoleAgentBinding } from "../../dist/role/role.js";
import {
  createRoleSessionSet,
  recordRoleAgentSession
} from "../../dist/executor/agentExecutor.js";
import { resolveEffectiveLaunch } from "../../dist/executor/effectiveLaunch.js";

/**
 * @param {import("../../dist/storage/taskStore.js").FileTaskStore} store
 * @param {{id: string, adapterId: string}} agent
 * @param {Date} now
 * @param {{nativeSessionId?: string, launchId?: string, workspace?: string}} [options]
 * @returns {{environment: Record<string, string>, granter: string}}
 */
export function installOperatorSession(store, agent, now, options = {}) {
  const nativeSessionId = options.nativeSessionId ?? "operator-native-1";
  const launchId = options.launchId ?? "operator-launch-1";
  const workspace = options.workspace ?? store.rootDirectory();
  const role = createGlobalRole(
    "operator",
    [createRoleAgentBinding(agent)],
    agent.id,
    workspace,
    now
  );
  let sessions = createRoleSessionSet(
    { scope: "global", roleName: role.name },
    role.activeAgentId,
    now
  );
  sessions = recordRoleAgentSession(sessions, {
    agentId: role.activeAgentId,
    adapterId: role.agentBindings[role.activeAgentId].adapterId,
    nativeSessionId,
    launchId,
    policy: "fixed",
    status: "ready",
    effective: resolveEffectiveLaunch({ role, purpose: "execution" })
  }, now);
  store.transaction((tx) => {
    tx.saveGlobalRole(role);
    tx.saveGlobalRoleSessionSet(sessions);
  });
  return {
    environment: {
      YUI_SESSION_SCOPE: "global",
      YUI_ROLE: "operator",
      YUI_AGENT_ID: agent.id,
      YUI_ADAPTER_ID: agent.adapterId,
      YUI_LAUNCH_ID: launchId,
      YUI_NATIVE_SESSION_ID: nativeSessionId
    },
    granter: `operator:${agent.id}`
  };
}
