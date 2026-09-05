/** Yui design contracts. Not a production SDK or a security implementation. */
export type Id = string;
export type Time = string;
export type Json = null | boolean | number | string | readonly Json[] |
  { readonly [key: string]: Json };
export type Schema = Readonly<Record<string, Json>>;
export type Revision = number; // concurrent edit protection, not result validity
export type RecordRef = Readonly<{ id: Id; revision?: Revision }>;
export type Scope =
  | Readonly<{ kind: 'global' }>
  | Readonly<{ kind: 'project'; projectId: Id }>
  | Readonly<{ kind: 'task'; taskId: Id }>;
export type Actor = Readonly<{
  id: Id; kind: 'user' | 'operator' | 'leader' | 'worker' | 'reviewer';
}>;
export type TaskState = 'draft' | 'active' | 'completed' | 'cancelled';
export interface TaskRecord {
  readonly id: Id;
  readonly title: string;
  readonly state: TaskState;
  readonly leaderRoleId: Id;
  readonly briefRef: RecordRef;
  readonly projectRefs: readonly Id[];
  readonly revision: Revision;
  readonly createdAt: Time;
  readonly updatedAt: Time;
}
export interface BriefRecord {
  readonly id: Id;
  readonly taskId: Id;
  readonly revision: Revision;
  readonly objective: string;
  readonly context?: string;
  readonly requirements?: string;
  readonly boundaries?: string;
  readonly acceptance?: string;
  readonly approach?: string;
  readonly currentFocus?: string;
}
export interface WorkItem {
  readonly id: Id;
  readonly taskId: Id;
  readonly revision: Revision;
  readonly objective: string;
  readonly acceptance?: string;
  readonly dependencies: readonly Id[];
  readonly assigneeRoleId?: Id;
  readonly state: 'open' | 'accepted' | 'retired';
  readonly acceptedCandidateId?: Id;
}
export interface AgentSelection {
  readonly agentId: Id;
  readonly preset?: string;
  readonly model?: string;
  readonly settings: Readonly<Record<string, Json>>; // no embedded credentials
}
export interface RoleConfiguration {
  readonly selection?: AgentSelection; // a logical Role may exist before Agent configuration
  readonly instructions: string;
  readonly skillRefs: readonly RecordRef[];
  readonly resourceGrantRefs: readonly Id[];
}
export interface RoleRecord {
  readonly id: Id;
  readonly kind: 'operator' | 'leader' | 'worker' | 'reviewer';
  readonly taskId?: Id;
  readonly revision: Revision;
  readonly current: RoleConfiguration;
}
export interface ImplementationRef {
  readonly pluginId: Id;
  readonly generation: Id;
  readonly version: string;
  readonly artifactDigest: string;
}
export interface SessionRecord {
  readonly id: Id;
  readonly roleId: Id;
  readonly nativeSessionId?: Id;
  readonly implementation: ImplementationRef;
  readonly statefulDependencies: readonly ImplementationRef[];
  readonly effective: RoleConfiguration;
  readonly environmentRef?: Id;
}
export interface Assignment {
  readonly objective: string;
  readonly acceptance?: string;
  readonly contextRefs: readonly RecordRef[];
  readonly permittedResourceRefs: readonly Id[];
}
export interface TurnRecord {
  readonly id: Id;
  readonly taskId?: Id;
  readonly roleId: Id;
  readonly workItemId?: Id;
  readonly sessionId?: Id; // absent until an execution has a session
  readonly attemptId: Id;
  readonly nativeTurnId?: Id;
  readonly source: 'yui' | 'user' | 'provider';
  readonly purpose: 'planning' | 'delivery' | 'review' | 'dialogue';
  readonly inputRef: Id;
  readonly assignment?: Assignment;
  readonly effectiveConfigRef: Id;
  readonly state: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  readonly resultRef?: Id; // original output is stored once
  readonly errorRef?: Id;
}
export interface ExecutionGroup {
  readonly id: Id;
  readonly assignment: Assignment;
  readonly attempts: readonly Readonly<{
    replica: number; attempt: number; turnId: Id;
  }>[];
  readonly selectedResultTurns: readonly Id[];
  readonly synthesisTurnId?: Id;
}
export type ArtifactRef =
  | Readonly<{ kind: 'content'; id: Id; digest: string; locator: string }>
  | Readonly<{ kind: 'external-version'; id: Id; resourceId: Id; version: string }>
  | Readonly<{ kind: 'receipt'; id: Id; operationId: Id; receiptId: Id }>;
export type ReferenceMaterial = ArtifactRef | Readonly<{
  kind: 'reference'; id: Id; locator: string; observedAt: Time;
}>;
export interface Candidate {
  readonly id: Id;
  readonly taskId: Id;
  readonly workItemId?: Id;
  readonly source:
    | Readonly<{ kind: 'turn'; turnId: Id }>
    | Readonly<{ kind: 'import'; actorId: Id; note: string }>;
  readonly summary?: string;
  readonly artifacts: readonly ArtifactRef[];
  readonly contextRefs: readonly RecordRef[]; // provenance, not expiry gates
}
export interface Review {
  readonly id: Id;
  readonly taskId: Id;
  readonly candidateId: Id;
  readonly reviewerTurnId: Id;
  // Result text belongs to the referenced Turn, not another verdict authority.
}
export interface Acceptance {
  readonly taskId: Id;
  readonly workItemId?: Id;
  readonly candidateId?: Id; // direct Task completion need not create a Candidate
  readonly actorId: Id;
  readonly summary: string;
  readonly resultRefs: readonly ArtifactRef[];
  readonly reviewRefs: readonly Id[];
  readonly recordedAt: Time;
}
export interface Message {
  readonly id: Id;
  readonly taskId?: Id;
  readonly from: Actor;
  readonly to: Readonly<{ kind: 'operator' }> | Readonly<{ kind: 'role'; roleId: Id }>;
  readonly body: string;
  readonly relatedRefs: readonly Id[];
  readonly createdAt: Time;
}
export interface InputRequest {
  readonly id: Id;
  readonly taskId: Id;
  readonly question: string;
  readonly answerMessageId?: Id;
}
export interface DeliveryReceipt {
  readonly messageIds: readonly Id[];
  readonly attemptId: Id;
  readonly state: 'pending' | 'accepted' | 'unknown';
  readonly acceptedTurnId?: Id;
}
export interface ContextCursor {
  readonly taskId: Id;
  readonly throughSequence: number;
}
export interface ContextSnapshot {
  readonly task: TaskRecord;
  readonly brief: BriefRecord;
  readonly roleRefs: readonly RecordRef[];
  readonly workRefs: readonly RecordRef[];
  readonly resultRefs: readonly RecordRef[];
  readonly pendingInputRefs: readonly Id[];
  readonly coreCursor: ContextCursor;
  readonly observations: readonly Readonly<{
    source: string; observedAt: Time; coverage: 'known' | 'partial' | 'unknown';
    value: Json;
  }>[];
  readonly omittedRefs: readonly Id[];
}
export type Effect = 'query' | 'local-mutation' | 'external-operation';
export interface TrustedCallContext {
  readonly actor: Actor;
  readonly scope: Scope;
  readonly grantRefs: readonly Id[];
  // Issued by authenticated ingress. User JSON cannot establish this authority.
}
export interface CapabilityDescriptor {
  readonly name: string;
  readonly version: string;
  readonly input: Schema;
  readonly output: Schema;
  readonly effect: Effect;
  readonly requiredGrants: readonly string[];
  readonly provider: ImplementationRef;
  readonly scope: Scope;
}
export interface CapabilityCall {
  readonly name: string;
  readonly input: Json;
  readonly requestId?: Id; // mandatory at runtime for effectful descriptors
  readonly expectedRevision?: Revision;
  readonly providerId?: Id;
}
export type CallResult =
  | Readonly<{ kind: 'value'; value: Json }>
  | Readonly<{ kind: 'operation'; operationId: Id }>
  | Readonly<{ kind: 'unavailable' | 'ambiguous' | 'denied' | 'invalid'; detail: string; refs: readonly Id[] }>;
export interface OperationRecord {
  readonly id: Id;
  readonly requestId: Id;
  readonly requestDigest: string;
  readonly actorId: Id;
  readonly targetId?: Id;
  readonly capability: string;
  readonly implementation?: ImplementationRef;
  readonly state: 'pending' | 'running' | 'finished' | 'unknown';
  readonly outcome?: 'succeeded' | 'failed' | 'cancelled';
  readonly effect: 'none' | 'possible' | 'confirmed';
  readonly receiptRefs: readonly Id[];
  readonly partialResultRefs: readonly Id[];
  readonly resultRef?: Id;
  readonly errorRef?: Id;
}
export interface EndpointFeatures {
  readonly resume: boolean;
  readonly acceptance: 'provider-ack' | 'correlated-terminal' | 'transport-only';
  readonly identity: 'native' | 'local-correlation' | 'unobserved';
  readonly input: 'idle-only' | 'queue-next' | 'steer';
  readonly cancel: boolean;
  readonly terminalAttach: boolean;
}
export type Submission =
  | Readonly<{ kind: 'accepted'; attemptId: Id; nativeTurnId?: Id; evidenceRef: Id }>
  | Readonly<{ kind: 'pending'; attemptId: Id }>
  | Readonly<{ kind: 'not-submitted'; attemptId: Id; reason: string }>
  | Readonly<{ kind: 'unknown'; attemptId: Id; evidenceRefs: readonly Id[] }>;
export type RuntimeEvent =
  | Readonly<{ kind: 'accepted'; sessionId: Id; submission: Extract<Submission, { kind: 'accepted' }> }>
  | Readonly<{ kind: 'terminal'; sessionId: Id; attemptId: Id; nativeTurnId?: Id;
      outcome: 'completed' | 'failed' | 'cancelled'; resultRef?: Id; evidenceRef: Id }>
  | Readonly<{ kind: 'activity'; sessionId: Id; observedAt: Time; detail: Json }>
  | Readonly<{ kind: 'problem'; sessionId: Id; evidenceRef: Id }>;
export interface AgentEndpoint {
  readonly features: EndpointFeatures;
  open(config: RoleConfiguration, environmentRef?: Id): Promise<SessionRecord>;
  resume(session: SessionRecord): Promise<SessionRecord>;
  submit(session: SessionRecord, input: Readonly<{ attemptId: Id; inputRef: Id }>): Promise<Submission>;
  inspect(session: SessionRecord): Promise<Readonly<{ state: 'idle' | 'busy' | 'unknown'; evidenceRefs: readonly Id[] }>>;
  cancel(session: SessionRecord, attemptId: Id): Promise<Readonly<{
    state: 'requested' | 'confirmed' | 'unknown' | 'unsupported'; evidenceRefs: readonly Id[];
  }>>;
  steer?(session: SessionRecord, attemptId: Id, inputRef: Id): Promise<Submission>;
  events(session: SessionRecord): AsyncIterable<RuntimeEvent>;
  detach(session: SessionRecord): Promise<void>;
}
export interface ProjectRecord {
  readonly id: Id;
  readonly name: string;
  readonly description?: string;
  readonly knowledgeRefs: readonly RecordRef[];
  readonly resourceRefs: readonly Id[];
  readonly defaultCapabilityProviders: Readonly<Record<string, Id>>;
}
export interface ResourceRecord {
  readonly id: Id;
  readonly kind: string;
  readonly displayName: string;
  readonly metadata: Readonly<Record<string, Json>>;
}
export interface PreparedEnvironment {
  readonly preparationId: Id;
  readonly resourceRefs: readonly Id[];
  readonly environmentRef?: Id; // an empty environment is valid
  readonly disposition: 'prepared' | 'adopted' | 'released';
}
export interface ActivationRequest {
  readonly taskId: Id;
  readonly requestId: Id;
  readonly timing: 'now' | Readonly<{ afterPlanningTurnId: Id }>;
}
export interface PluginManifest {
  readonly id: Id;
  readonly version: string;
  readonly apiVersion: string;
  readonly entrypoint: string;
  readonly provides: readonly string[];
  readonly requires: readonly string[];
  readonly permissions: readonly string[];
  readonly reloadMode: 'hot' | 'drain' | 'restart-required';
}
export interface PluginValidation {
  readonly artifactDigest: string;
  readonly reportRef: Id;
  readonly environmentRef?: Id;
  readonly checks: readonly string[];
  readonly outcome: 'passed' | 'failed';
}
export interface PluginInstance {
  readonly implementation: ImplementationRef;
  readonly scope: Scope;
  readonly state: 'loaded' | 'active' | 'draining' | 'disabled';
  readonly trust: 'builtin' | 'declarative' | 'isolated' | 'user-trusted-local';
  readonly validationRef?: Id;
}
export interface ProblemNotice {
  readonly taskId: Id;
  readonly sourceRole: 'worker' | 'reviewer' | 'leader';
  readonly evidenceRef: Id;
}
export function recipientForProblem(role: ProblemNotice['sourceRole']): 'leader' | 'operator' {
  return role === 'leader' ? 'operator' : 'leader';
}
// Operator issues are handled by the user; no Operator recovery operation is defined.
