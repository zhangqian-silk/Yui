import { reconciliationIntervalMilliseconds } from "../config/yuiConfig.js";
import type { ControllerDispatcher } from "../core/controllerServer.js";
import {
  agentComposerReadinessProbe,
  ExecutorRegistry
} from "../executor/executorRegistry.js";
import { FileRoleLaunchPlanner } from "../executor/fileRoleLaunchPlanner.js";
import { FileTaskStore, type TaskStore } from "../storage/taskStore.js";
import {
  FileTaskWorkspacePreparer,
  type TaskWorkspacePreparer
} from "../repository/taskWorkspacePreparer.js";
import { NodeCommandExecutor } from "../tmux/commandExecutor.js";
import { TmuxManager } from "../tmux/tmuxManager.js";
import {
  TmuxPromptPushAdapter,
  TmuxSessionHost,
  type ActivePromptPushPort,
  type SessionHostPort
} from "../runtime/index.js";
import {
  startFileTaskController,
  type ControllerRuntimeOptions,
  type RunningFileTaskController
} from "./controller.js";
import { FileSchedulerStoreAdapter } from "./fileSchedulerStoreAdapter.js";
import {
  createSessionNotifyDispatcher,
  type SessionTurnCompleted
} from "./sessionNotify.js";

export type FileTaskControllerFactoryOptions = ControllerRuntimeOptions & Readonly<{
  store?: TaskStore;
  schedulerStore?: FileSchedulerStoreAdapter;
  planner?: FileRoleLaunchPlanner;
  tmux?: TmuxManager;
  delivery?: ExecutorRegistry;
  sessionHost?: SessionHostPort;
  promptPush?: ActivePromptPushPort;
  dispatcher?: ControllerDispatcher;
  environment?: NodeJS.ProcessEnv;
  workspacePreparer?: TaskWorkspacePreparer;
}>;

export type RunningFileTaskControllerRuntime = RunningFileTaskController & Readonly<{
  store: TaskStore;
  schedulerStore: FileSchedulerStoreAdapter;
  planner: FileRoleLaunchPlanner;
  tmux: TmuxManager;
  delivery: ExecutorRegistry;
  sessionHost: SessionHostPort;
  promptPush: ActivePromptPushPort;
  workspacePreparer: TaskWorkspacePreparer;
}>;

/** Production composition root for the lean FileTaskStore + tmux Controller. */
export async function startFileTaskControllerRuntime(
  home: string,
  options: FileTaskControllerFactoryOptions = {}
): Promise<RunningFileTaskControllerRuntime> {
  const store = options.store ?? new FileTaskStore(home);
  const schedulerStore = options.schedulerStore ?? new FileSchedulerStoreAdapter(store);
  const planner = options.planner ?? new FileRoleLaunchPlanner(home, store, {
    environment: options.environment
  });
  const tmux = options.tmux ?? new TmuxManager(
    options.environment?.YUI_TMUX_BIN ?? process.env.YUI_TMUX_BIN ?? "tmux",
    new NodeCommandExecutor(),
    { yuiHome: home }
  );
  const sessionHost = options.sessionHost ?? new TmuxSessionHost(planner, tmux);
  const promptPush = options.promptPush
    ?? new TmuxPromptPushAdapter(tmux, agentComposerReadinessProbe);
  const delivery = options.delivery ?? new ExecutorRegistry(
    planner,
    tmux,
    agentComposerReadinessProbe,
    { sessionHost, promptPush }
  );
  const workspacePreparer = options.workspacePreparer
    ?? new FileTaskWorkspacePreparer(home, store);
  let signalTurnCompleted: ((event: SessionTurnCompleted) => void) | undefined;
  const pendingTurnCompletions: SessionTurnCompleted[] = [];
  const dispatcher = createSessionNotifyDispatcher(
    schedulerStore,
    options.dispatcher,
    (event) => {
      if (signalTurnCompleted === undefined) pendingTurnCompletions.push(event);
      else signalTurnCompleted(event);
    }
  );
  const running = await startFileTaskController(home, schedulerStore, delivery, dispatcher, {
    intervalMs: options.intervalMs
      ?? reconciliationIntervalMilliseconds(store.getConfig().reconciliationIntervalSeconds),
    signalWindowMs: options.signalWindowMs,
    deliveryRetryMs: options.deliveryRetryMs,
    deliveryRetryLimit: options.deliveryRetryLimit,
    now: options.now,
    onError: options.onError,
    workspacePreparer
  });
  signalTurnCompleted = (event) => running.runtime.signal(
    event.scope === "task"
      ? `role:${encodeURIComponent(event.taskId!)}/${encodeURIComponent(event.roleName)}`
      : "operator"
  );
  for (const event of pendingTurnCompletions) signalTurnCompleted(event);
  return {
    ...running,
    store,
    schedulerStore,
    planner,
    tmux,
    delivery,
    sessionHost,
    promptPush,
    workspacePreparer
  };
}
