/**
 * Environment values owned by Yui's managed runtime.
 *
 * These values carry control-plane, Task, workspace, or runtime generation identity. They
 * are never user Agent environment bindings, and an ordinary repository test
 * must not inherit them from the managed Session that launched the test
 * command.
 */
export const YUI_MANAGED_RUNTIME_ENVIRONMENT_NAMES = Object.freeze([
  "YUI_CLI_NAME",
  "YUI_HOME",
  "YUI_SESSION_SCOPE",
  "YUI_TASK_ID",
  "YUI_ROLE",
  "YUI_AGENT_ID",
  "YUI_ADAPTER_ID",
  "YUI_DRIVER_ID",
  "YUI_WORKSPACE",
  "YUI_TURN_ID",
  "YUI_RUNTIME_GENERATION_ID",
  "YUI_NATIVE_SESSION_ROOT",
  "YUI_NATIVE_SESSION_ID",
  "YUI_CONTROL_PLANE_DESCRIPTOR",
  "YUI_TASK_RUNTIME_ISOLATION_DESCRIPTOR",
  "YUI_TASK_RUNTIME_SERVICE_NAMESPACE",
  "YUI_SESSION_TITLE",
  "YUI_AGENT_COMMAND",
  "YUI_AGENT_BASE_ARGS",
  "YUI_WRITABLE_PROJECT_IDS",
  "YUI_CONTEXT_PROJECT_IDS",
  "YUI_WORKSPACE_PROJECTS",
  "YUI_JOB_CALLER_KEY"
] as const);
