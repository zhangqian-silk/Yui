import {
  listArtifactsCapability,
  readArtifactCapability,
  saveArtifactCapability
} from "../artifacts/artifactCapability.js";
import { runConfigCommand } from "../commands/configCommands.js";
import { sendTaskMessageCommand, updateTaskMetadataCommand } from "../commands/taskCommands.js";
import { CONFIG_DOMAINS, type ConfigDomain } from "../config/configCatalog.js";
import {
  inspectTaskContext,
  readTaskContext, readTaskContextDelta,
  withContextObservations,
  type ContextObservationProvider
} from "../context/taskContext.js";
import {
  createJobCallAuthority, parseDurableJobStartParams,
  type DurableJobCaller, type DurableJobControlPort
} from "../controller/jobControl.js";
import type { JsonValue } from "../core/protocol.js";
import { inspectJobOperation } from "../job/jobOperation.js";
import type { TaskSubmissionIntent } from "../message/message.js";
import { createPluginService } from "../plugins/pluginService.js";
import { createProjectResources, type EnvironmentPlan } from "../resources/projectResourceService.js";
import type { TaskStore } from "../storage/taskStore.js";
import type { TaskMetadataUpdate } from "../task/task.js";
import type { TrustedCallContext } from "./callAuthority.js";
import {
  CapabilityRegistry, type CapabilityDescriptor, type CapabilityImplementation,
} from "./capabilityRegistry.js";
import type { CapabilitySchema } from "./capabilitySchema.js";
import type { InstanceHost } from "./instanceHost.js";

const text: CapabilitySchema = { type: "string", minLength: 1 };
const strings: CapabilitySchema = { type: "object", additionalProperties: { type: "string" } };
const object = (properties: Record<string, CapabilitySchema>, required = Object.keys(properties)): CapabilitySchema => ({
  type: "object", properties, required, additionalProperties: false
});
const taskInput = object({ taskId: text });
const recordOutput: CapabilitySchema = { type: "object" };
const taskOutput: CapabilitySchema = { type: "object", required: ["id", "status", "title"], properties: {
  id: text, status: text, title: text
} };
const provider = Object.freeze({ id: "yui:builtin-capabilities", generation: "1" });

/** Source locators identify the existing semantic owner, not a new Store. */
const definitions: readonly Omit<CapabilityDescriptor, "contractVersion" | "provider" | "scope">[] = [
  {
    name: "message.send", summary: "Save collaboration for Leader or continue the same dispatched work owner.",
    effect: "local-mutation", requiredPermissions: ["task:read"], source: "sendTaskMessageCommand",
    inputSchema: object({ taskId: text, body: text,
      intent: { enum: ["record", "discuss", "develop"] },
      wakePolicy: { enum: ["leader", "none"] },
      recipient: object({ roleName: text, workItemId: text, reviewRoundId: text }, ["roleName"])
    }, ["taskId", "body"]), outputSchema: recordOutput
  },
  {
    name: "context.read", summary: "Read a bounded authorized Task working set and atomic core cursor.",
    effect: "query", requiredPermissions: ["task:read"], source: "readTaskContext",
    inputSchema: taskInput, outputSchema: { type: "object", required: ["records", "coreCursor", "omitted"] }
  },
  {
    name: "context.delta", summary: "Read immutable Task events with a fixed pagination upper bound.",
    effect: "query", requiredPermissions: ["task:read"], source: "readTaskContextDelta",
    inputSchema: object({ taskId: text, after: text, continuation: text, limit: { type: "integer" } }, ["taskId", "after"]),
    outputSchema: { type: "object", required: ["events", "throughCursor"] }
  },
  {
    name: "context.inspect", summary: "Expand an authorized current record; optionally require its exact digest.",
    effect: "query", requiredPermissions: ["task:read"], source: "inspectTaskContext",
    inputSchema: object({ taskId: text, store: text, refId: text, digest: text }, ["taskId", "store", "refId"]),
    outputSchema: { type: "object", required: ["ref", "value", "coreCursor"] }
  },
  {
    name: "artifact.save", summary: "Save a file artifact by relativePath into the Task's local Git repository; returns a commit-pinned reference.",
    effect: "local-mutation", requiredPermissions: ["task:read"], source: "artifacts.saveArtifactCapability",
    inputSchema: object({ taskId: text, relativePath: text, content: { type: "string" }, message: text, expectedHead: text },
      ["taskId", "relativePath", "content"]),
    outputSchema: { type: "object", required: ["taskId", "commit", "relativePath"] }
  },
  {
    name: "artifact.read", summary: "Read a file artifact at HEAD, or at a pinned commit for frozen evidence, without starting a Runtime or plugin.",
    effect: "query", requiredPermissions: ["task:read"], source: "artifacts.readArtifactCapability",
    inputSchema: object({ taskId: text, relativePath: text, commit: text }, ["taskId", "relativePath"]),
    outputSchema: { type: "object", required: ["taskId", "relativePath", "commit", "content"] }
  },
  {
    name: "artifact.list", summary: "List this Task's tracked file artifacts at HEAD.",
    effect: "query", requiredPermissions: ["task:read"], source: "artifacts.listArtifactsCapability",
    inputSchema: taskInput, outputSchema: { type: "array", items: recordOutput }
  },
  {
    name: "environment.prepare", summary: "Prepare empty, Task-owned scratch, or explicitly granted trusted-local directory; does not adopt it or create a sandbox.",
    effect: "local-mutation", requiredPermissions: ["task:manage"], source: "ProjectResources.prepare",
    inputSchema: object({ taskId: text, plan: { anyOf: [
      object({ kind: { const: "empty" } }), object({ kind: { const: "scratch" } }),
      object({ kind: { const: "local" }, resourceId: text, access: { enum: ["read", "write"] } })
    ] } }), outputSchema: recordOutput
  },
  {
    name: "environment.adopt", summary: "Recheck current resource intent, grants and conflicts, then record Task ownership.",
    effect: "local-mutation", requiredPermissions: ["task:manage"], source: "ProjectResources.adopt",
    inputSchema: object({ taskId: text, preparationId: text }), outputSchema: recordOutput
  },
  {
    name: "environment.bind", summary: "Select an adopted environment for a Role's next native Session; null restores managed workspace. Active Sessions keep their environment.",
    effect: "local-mutation", requiredPermissions: ["task:manage"], source: "ProjectResources.bindEnvironment",
    inputSchema: object({ taskId: text, roleName: text, preparationId: { anyOf: [text, { const: null }] } }),
    outputSchema: recordOutput
  },
  {
    name: "environment.release", summary: "Release exact preparation; adopted resources need actual quiescence evidence. Never deletes user directories.",
    effect: "local-mutation", requiredPermissions: ["task:manage"], source: "ProjectResources.release",
    inputSchema: object({ taskId: text, preparationId: text, quiescence: text }, ["taskId", "preparationId"]), outputSchema: recordOutput
  },
  {
    name: "environment.list", summary: "Read preparation/adoption facts, not inferred process state.",
    effect: "query", requiredPermissions: ["task:read"], source: "TaskStore.listEnvironmentPreparations",
    inputSchema: taskInput, outputSchema: { type: "array", items: recordOutput }
  },
  {
    name: "resource.local.register", summary: "Register a user-owned local directory by canonical identity (Operator); registration does not grant use.",
    effect: "local-mutation", requiredPermissions: ["resource:register"], source: "ProjectResources.registerLocalDirectory",
    inputSchema: object({ displayName: text, path: text }), outputSchema: recordOutput
  },
  {
    name: "resource.local.read", summary: "Read an explicitly granted local resource.",
    effect: "query", requiredPermissions: ["task:read"], source: "ProjectResources.readLocalResource",
    inputSchema: object({ taskId: text, resourceId: text }), outputSchema: recordOutput
  },
  {
    name: "project.context", summary: "Read Project Knowledge, resource references and default Provider references; no credential grant.",
    effect: "query", requiredPermissions: ["task:read"], source: "TaskStore.getProject",
    inputSchema: object({ taskId: text, projectId: text }), outputSchema: recordOutput
  },
  {
    name: "project.resources.configure", summary: "Configure existing Project resource and Provider references (Operator).",
    effect: "local-mutation", requiredPermissions: ["resource:register"], source: "ProjectResources.configureProject",
    inputSchema: object({ projectId: text, resourceRefs: { type: "array", items: text }, defaultCapabilityProviders: strings }),
    outputSchema: recordOutput
  },
  {
    name: "task.read", summary: "Read the current Task record.", effect: "query",
    inputSchema: taskInput, outputSchema: taskOutput, requiredPermissions: ["task:read"],
    source: "TaskStore.getTask (task show)"
  },
  {
    name: "task.update", summary: "Update Task metadata through the existing command transaction.",
    effect: "local-mutation", requiredPermissions: ["task:manage"],
    source: "updateTaskMetadataCommand (task update)",
    inputSchema: object({
      taskId: text,
      patch: object({
        title: text, description: { type: "string" },
        priority: { enum: ["low", "medium", "high", "urgent"] },
        tags: { type: "array", items: text }
      }, [])
    }), outputSchema: taskOutput
  },
  {
    name: "config.read", summary: "Read effective global configuration (Operator only).",
    effect: "query", requiredPermissions: ["config:read"],
    source: "runConfigCommand (config <domain> show)",
    inputSchema: object({ domain: { enum: CONFIG_DOMAINS } }),
    outputSchema: { type: "object" }
  },
  {
    name: "resource.git.result", summary: "Read an original fixed Git ChangeSet and its external-version reference.",
    effect: "query", requiredPermissions: ["task:read"], source: "TaskStore.getChangeSet",
    inputSchema: object({ taskId: text, changeSetId: text }), outputSchema: recordOutput
  },
  {
    name: "resource.workspaces", summary: "Read the Task's managed workspace resources.",
    effect: "query", requiredPermissions: ["task:read"],
    source: "TaskStore.listManagedWorkspaces (task workspace list)",
    inputSchema: taskInput, outputSchema: { type: "array", items: { type: "object", required: ["owner", "root", "entries"] } }
  },
  {
    name: "job.get", summary: "Read the original Job and its operation evidence.",
    effect: "query", requiredPermissions: ["task:read"],
    source: "DurableJobControlPort.getJob (job.get RPC)",
    inputSchema: object({ taskId: text, jobId: text }),
    outputSchema: { type: "object", required: ["job", "operation"] }
  },
  {
    name: "job.start", summary: "Request an idempotent Job through the existing Controller owner.",
    effect: "external-operation", requiredPermissions: ["job:start"],
    source: "DurableJobControlPort.startJob (job.start RPC)",
    inputSchema: object({
      taskId: text, projectId: text, head: text, workspace: text,
      owner: { anyOf: [
        object({ kind: { const: "task" } }),
        object({ kind: { const: "work-item" }, workItemId: text }),
        object({ kind: { const: "integration-attempt" }, integrationAttemptId: text })
      ] },
      env: strings,
      steps: { type: "array", minItems: 1, items: object({
        name: text, command: text, timeoutMs: { type: "integer" },
        argv: { type: "array", minItems: 1, items: text }, cwd: text, env: strings
      }, ["name", "command"]) },
      retryOf: text
    }, ["taskId", "projectId", "head", "workspace", "owner", "env", "steps"]),
    outputSchema: { type: "object", required: ["job", "created", "operation"], properties: { created: { type: "boolean" } } }
  },
  ...[
    { action: "create", summary: "Create an independent data or trusted-local package in an adopted environment; executes no author code.",
      inputSchema: object({ preparationId: text, id: text, kind: { enum: ["declarative", "trusted-local"] } }) },
    { action: "validate", summary: "Validate captured package bytes in an explicit environment; author build/test code needs a separate execution grant.",
      inputSchema: object({ preparationId: text, directory: text }) },
    { action: "activate", summary: "Recheck validated bytes, current authority and dependencies; publish one complete Task-local provider.",
      inputSchema: object({ validationId: text }) },
    { action: "disable", summary: "Stop new plugin calls and drain the exact Host instance before disposal.",
      inputSchema: object({ id: text }) }
  ].map(({ action, summary, inputSchema }) => ({
    name: `plugin.${action}`, summary, inputSchema,
    effect: "local-mutation" as const, requiredPermissions: ["plugin:manage"],
    source: "PluginService", outputSchema: recordOutput
  })),
  {
    name: "plugin.scan", summary: "Data-only package digest and manifest inspection; never executes author code.",
    effect: "query", requiredPermissions: ["plugin:manage"], source: "PluginService.scan",
    inputSchema: object({ preparationId: text, directory: text }), outputSchema: recordOutput
  },
  {
    name: "plugin.validation", summary: "Read immutable validation evidence without starting the plugin.",
    effect: "query", requiredPermissions: ["task:read"], source: "PluginService.inspect",
    inputSchema: object({ validationId: text }), outputSchema: recordOutput
  },
  {
    name: "plugin.inspect", summary: "Read durable desired selection, actual Host selection/references and latest intent failure; never activates code.",
    effect: "query", requiredPermissions: ["task:read"], source: "PluginService.current",
    inputSchema: object({ id: text }), outputSchema: recordOutput
  },
  {
    name: "plugin.list", summary: "List this Task's explicit plugin choices and current Host observations without executing code.",
    effect: "query", requiredPermissions: ["task:read"], source: "PluginService.list",
    inputSchema: object({}), outputSchema: { type: "array", items: recordOutput }
  }
];
export const BUILTIN_CAPABILITIES: readonly CapabilityDescriptor[] = definitions.map((entry) => ({
  ...entry, contractVersion: "1", provider, scope: { kind: "global" as const }
}));

/** One registry with separate managed credentials and in-process Web query
 * issuance. Socket possession or caller-scope JSON never issues a Web context. */
export function createBuiltinCapabilities(
  host: InstanceHost,
  store: TaskStore,
  jobs: DurableJobControlPort,
  signal: (taskId: string) => void = () => undefined,
  contextProviders: readonly ContextObservationProvider[] = []
) {
  const authority = createJobCallAuthority(store);
  const resources = createProjectResources(store);
  const callers = new WeakMap<TrustedCallContext, DurableJobCaller>();
  // Issued only by the Controller's in-process, token-authenticated Web root.
  // This is not accepted by the managed RPC credential adapter.
  const webQueries = new WeakSet<TrustedCallContext>();
  const current = (context: TrustedCallContext) => {
    if (webQueries.has(context)) {
      requireTask(store, context.targetId);
      return { scope: "user" } as const;
    }
    authority.authorize(context, context.targetId);
    const caller = callers.get(context);
    if (!caller) throw new Error("Untrusted capability ingress.");
    return caller;
  };
  const implementation: CapabilityImplementation = {
    invoke(name, input, invocation) {
      const caller = current(invocation.context);
      const params = input as Record<string, unknown>;
      if (params.taskId !== undefined && params.taskId !== invocation.context.targetId) {
        throw new Error("Capability target is outside the authenticated Task.");
      }
      const taskId = invocation.context.targetId;
      if (name === "message.send") {
        // A managed Task Session resolves to Leader/role authority and never
        // gains develop from an intent argument; only a global Operator Session
        // (user-authority) may carry one. sendTaskMessageCommand enforces this,
        // so the capability just forwards the optional intent unchanged.
        const result = sendTaskMessageCommand(store, taskId, params.body as string,
          params.wakePolicy as "leader" | "none" | undefined, { environment: callerEnvironment(caller) },
          params.recipient as { roleName: string; workItemId?: string; reviewRoundId?: string } | undefined,
          params.intent as TaskSubmissionIntent | undefined);
        signal(taskId);
        return result.message;
      }
      if (name === "plugin.create") return plugins.create(taskId, params.preparationId as string,
        params.id as string, params.kind as "declarative" | "trusted-local");
      if (name === "plugin.scan") return plugins.scan(taskId, params.preparationId as string, params.directory as string);
      if (name === "plugin.validate") return plugins.validate(invocation.context, params.preparationId as string, params.directory as string);
      if (name === "plugin.validation") return plugins.inspect(taskId, params.validationId as string);
      if (name === "plugin.inspect") return plugins.current(taskId, params.id as string);
      if (name === "plugin.list") return plugins.list(taskId);
      if (name === "plugin.activate") return plugins.activate(invocation.context, params.validationId as string);
      if (name === "plugin.disable") return plugins.disable(taskId, params.id as string);
      if (name === "context.read") {
        const core = readTaskContext(store, taskId, callerEnvironment(caller));
        return withContextObservations(core, contextProviders);
      }
      if (name === "context.delta") return readTaskContextDelta(store, taskId, {
        after: params.after as string, continuation: params.continuation as string | undefined,
        limit: params.limit as number | undefined
      }, callerEnvironment(caller));
      if (name === "context.inspect") return inspectTaskContext(store, taskId, {
        store: params.store as string, refId: params.refId as string, digest: params.digest as string | undefined
      }, callerEnvironment(caller));
      // File/directory artifacts live in the Task's local Git repository, not
      // the DB. Save commits exactly one path and returns a self-certifying
      // commit-pinned reference; read/list are ordinary current reads. These
      // are the async Git path (the capability layer awaits invoke()).
      if (name === "artifact.save") return saveArtifactCapability(store.rootDirectory(), taskId, {
        relativePath: params.relativePath as string, content: params.content as string,
        ...(params.message === undefined ? {} : { message: params.message as string }),
        ...(params.expectedHead === undefined ? {} : { expectedHead: params.expectedHead as string })
      });
      if (name === "artifact.read") return readArtifactCapability(store.rootDirectory(), taskId, {
        relativePath: params.relativePath as string,
        ...(params.commit === undefined ? {} : { commit: params.commit as string })
      });
      if (name === "artifact.list") return listArtifactsCapability(store.rootDirectory(), taskId);
      if (name === "environment.prepare") return resources.prepare(taskId, params.plan as EnvironmentPlan);
      if (name === "environment.adopt") return resources.adopt(taskId, params.preparationId as string);
      if (name === "environment.bind") {
        const role = resources.bindEnvironment(taskId, params.roleName as string,
          params.preparationId as string | null, {
            source: name, actorId: invocation.context.actorId, requestId: invocation.requestId!
          });
        signal(taskId);
        return role;
      }
      if (name === "environment.release") {
        plugins.assertEnvironmentUnused(taskId, params.preparationId as string);
        return resources.release(taskId, params.preparationId as string,
          params.quiescence === undefined ? undefined : { quiescence: params.quiescence as string });
      }
      if (name === "environment.list") return store.listEnvironmentPreparations(taskId);
      if (name === "resource.local.register") return resources.registerLocalDirectory(params.displayName as string, params.path as string);
      if (name === "resource.local.read") return resources.readLocalResource(taskId, params.resourceId as string);
      if (name === "project.context") return resources.projectContext(taskId, params.projectId as string);
      if (name === "project.resources.configure") return resources.configureProject(params.projectId as string,
        params.resourceRefs as string[], params.defaultCapabilityProviders as Record<string, string>);
      if (name === "task.read") return requireTask(store, taskId);
      if (name === "resource.workspaces") return store.listManagedWorkspaces(taskId);
      if (name === "resource.git.result") return resources.gitResult(taskId, params.changeSetId as string);
      if (name === "config.read") return runConfigCommand(params.domain as ConfigDomain, ["show"], store).data;
      if (name === "task.update") {
        const patch = params.patch as Pick<TaskMetadataUpdate, "title" | "description" | "priority" | "tags">;
        return updateTaskMetadataCommand(store, taskId, {
          ...patch,
          ...(patch.description === "" ? { description: null } : {}),
          ...(patch.tags?.length === 0 ? { tags: null } : {})
        }, {
          environment: callerEnvironment(caller),
          runtime: { notifyStateChanged: signal, reconcileTask: signal }
        });
      }
      if (name === "job.get") {
        const job = jobs.getJob(taskId, params.jobId as string);
        if (!job) throw new Error(`Job not found: ${taskId}/${params.jobId}.`);
        const operation = inspectJobOperation(job);
        invocation.observe(operation);
        return { job, operation };
      }
      if (name === "job.start") {
        const parsed = parseDurableJobStartParams({
          ...params, caller, requestId: invocation.requestId
        } as JsonValue);
        const { job, created } = jobs.startJob(parsed, new Date());
        const operation = inspectJobOperation(job);
        invocation.observe(operation);
        if (created) signal(taskId);
        return { job, created, operation };
      }
      throw new Error(`Builtin capability unavailable: ${name}.`);
    }
  };
  host.attach(provider, implementation);
  const registry = new CapabilityRegistry(host, (context, descriptor, input) => {
    const caller = current(context);
    const task = requireTask(store, context.targetId);
    if (caller.scope === "user" && descriptor !== undefined && descriptor.effect !== "query") {
      throw new Error("Web panels may only query capabilities.");
    }
    if (typeof input === "object" && input !== null && "taskId" in input && input.taskId !== task.id) {
      throw new Error("Capability target is outside the authenticated Task.");
    }
    for (const permission of descriptor?.requiredPermissions ?? []) {
      if (permission === "job:start" && caller.scope === "task") {
        const sessions = store.getTaskRoleSessionSet(task.id, caller.role!);
        if (sessions?.sessions[sessions.activeAgentId]?.effective.executionAuthority !== "delivery") {
          throw new Error("Planning Sessions cannot start delivery Jobs.");
        }
      }
      if (permission === "task:read" || permission === "job:start") continue;
      if (permission === "task:manage" && (
        (caller.scope === "task" && caller.role === "leader")
        || (caller.scope === "global" && caller.role === "operator")
      )) continue;
      // PluginService binds every management target to this authenticated
      // Task. This admits package management, not author-code execution:
      // adopted environments and exact plugin.execute grants remain separate.
      if (permission === "plugin:manage" && caller.scope === "task" && caller.role === "leader") continue;
      if ((permission === "config:read" || permission === "plugin:manage" || permission === "resource:register")
        && caller.scope === "global" && caller.role === "operator") continue;
      throw new Error(`Permission unavailable: ${permission}.`);
    }
    return { taskIds: [task.id], projectIds: task.projectBindings.map((binding) => binding.projectId) };
  }, BUILTIN_CAPABILITIES);
  const plugins = createPluginService(store, host, registry);
  return {
    registry,
    authenticateWebQuery(taskId: string): TrustedCallContext {
      requireTask(store, taskId);
      const context = Object.freeze({ actorId: "local-web-user", targetId: taskId });
      webQueries.add(context);
      return context;
    },
    authenticate(caller: DurableJobCaller, taskId: string): TrustedCallContext {
      const credential = Object.freeze({ ...caller });
      const context = authority.authenticate(credential, taskId);
      callers.set(context, credential);
      return context;
    }
  };
}

function requireTask(store: TaskStore, taskId: string) {
  const task = store.getTask(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}.`);
  return task;
}

function callerEnvironment(caller: DurableJobCaller): NodeJS.ProcessEnv {
  if (caller.scope === "user") return {};
  return {
    YUI_SESSION_SCOPE: caller.scope, YUI_TASK_ID: caller.taskId,
    YUI_ROLE: caller.role, YUI_AGENT_ID: caller.agentId,
    YUI_ADAPTER_ID: caller.adapterId, YUI_NATIVE_SESSION_ID: caller.nativeSessionId
  };
}
