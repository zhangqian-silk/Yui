import type { PromptEnvelope } from "./promptEnvelope.js";
import type { RuntimeBinding } from "./runtimeBinding.js";
import type {
  NewSessionLaunchRequest,
  ResumeSessionLaunchRequest
} from "./sessionLaunchRequest.js";

export type SessionRuntimeState = "starting" | "running" | "stopped" | "unavailable";

export type SessionInspection = Readonly<{
  state: SessionRuntimeState;
  nativeSessionId?: string;
}>;

export interface SessionHostPort {
  start(request: NewSessionLaunchRequest): Promise<RuntimeBinding>;
  resume(request: ResumeSessionLaunchRequest): Promise<RuntimeBinding>;
  stop(binding: RuntimeBinding): Promise<void>;
  inspect(binding: RuntimeBinding): Promise<SessionInspection>;
}

export type PromptPushResult = "delivered" | "busy" | "unavailable";

export type ActivePromptPushRequest = Readonly<{
  binding: RuntimeBinding;
  envelope: PromptEnvelope;
}>;

export interface ActivePromptPushPort {
  tryPush(request: ActivePromptPushRequest): Promise<PromptPushResult>;
}
