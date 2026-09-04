# Agent Result Consumption

Status: proposed design  
Date: 2026-09-04  
Baseline: `8a29c294d66107c697a74f803b3190ab9c00e333`

## Product decision

Every managed Agent Turn produces one durable original result. The next Agent
in the ownership chain reads that result and decides what it means.

Yui Core owns the structured execution envelope:

- Task, Role, Turn, WorkItem, ReviewRound, and ExecutionGroup identity;
- Provider and runtime lifecycle;
- workspace ownership and write scope;
- exact frozen commits and Core-observed Git state;
- mailbox delivery, retry fences, and terminal status.

The Agent owns the result text. Core stores it unchanged and does not parse,
classify, normalize, or validate its semantic sections.

Skills and dispatch instructions may request a consistent Markdown or JSON
shape so another Agent can read results efficiently. Missing headings, invalid
JSON, an omitted finding, or an imprecise conclusion are not protocol errors.
They are result-quality evidence for the consuming Agent to accept, reject,
retry, or clarify.

## Why the current design is too complex

The current runtime has two result paths:

1. ordinary Turns preserve `TurnResult.output`;
2. Review Turns and replicated Producer Lanes additionally parse the same text
   into checks, findings, evidence, commits, delta dispositions, and finding
   ledger records.

Those derived fields then influence Lane success, Review acceptance, repair
planning, and Task completion. This creates several problems:

- the raw result and parsed projection can disagree;
- valid free-form results may be interpreted as empty structured results;
- malformed formatting can turn successful Agent work into
  `missing-result`;
- Review and execution need separate parsers and semantic state;
- Core starts making judgments that belong to the main Agent or Leader;
- each new result concept expands persistence, migration, UI, retry, and
  completion logic.

The root correction is not a more permissive parser. It is removing
Agent-authored semantics from Core decisions.

## Alternatives considered

### Require and validate one JSON schema

This makes automation straightforward but turns a formatting mistake into an
execution failure and gives Core a growing semantic contract for every Agent
role. It also duplicates the original result with a parsed representation.

Rejected because result quality belongs to the consuming Agent.

### Parse JSON or Markdown on a best-effort basis

This appears compatible with free-form output, but absence and parse failure
become indistinguishable from a genuine empty result. That is the current
source of false clean Reviews and incomplete repair projections.

Rejected because a non-authoritative parser must not influence lifecycle or
acceptance, and a parser with no influence has no product value.

### Preserve opaque output and objective Core evidence

This keeps one Agent-authored source of truth while retaining strong guarantees
for identity, workspace, commits, runtime, and delivery.

Selected because it has the smallest durable concept set and the same
Agent-to-Agent behavior for Worker, Producer, Reviewer, and Leader.

## Target result contract

### Agent-authored result

`TurnResult.output` is the only authoritative Agent-authored result. It remains
an opaque, non-empty string and is never interpreted by Core.

The result may use a recommended structure such as:

```markdown
## Outcome

## Changes or findings

## Verification

## Risks, blockers, or uncertainty

## Recommended next action
```

Reviewer instructions may use review-oriented labels, and an Agent may choose
JSON when that improves communication. Core does not require either format.

### Core-authored evidence

Core may attach facts it observed independently of the Agent text:

```ts
type TurnSystemEvidence = Readonly<{
  workspaceSnapshot?: ExecutionLaneGitSnapshot;
}>;
```

These facts are strongly validated because Core owns their production. They do
not assert that the implementation is correct or that a Review passed.

For a writable replicated Lane, a clean exact workspace snapshot remains
required. A dirty workspace, wrong managed branch, missing durable workspace,
or mismatched Project set remains a Core failure. An Agent failing to mention
a check or commit in its prose does not.

### Terminal meaning

- `Turn.completed`: the Provider completed and every required Core-observed
  artifact boundary is valid.
- `Turn.failed`: Provider, runtime, authority, workspace, or another
  Core-owned execution boundary failed.
- Neither status means that the Agent result is sufficient or accepted.

Acceptance remains an explicit action by the main Agent or Leader.

## Direct execution

Direct Worker and direct Reviewer behavior is already close to the target:

1. dispatch one exact Turn with a frozen Context Snapshot;
2. preserve the Provider's final result as `TurnResult.output`;
3. record the Provider and workspace facts Core directly observed;
4. route a terminal event containing the exact `turnId`;
5. let the Leader read the complete Turn result and decide.

No checks, findings, evidence, verdict, or infrastructure diagnosis is
extracted from the output.

For Review, `ReviewRound.completed` means that its exact main Reviewer Turn
completed and delivered a result. It does not mean that the candidate passed.
`ReviewRound.failed` is reserved for execution failure.

## Replicated execution

Replicated execution keeps its Assignment, isolated Lanes, all-Lanes-settled
rule, minimum successful Producer count, and one main synthesis Turn. It no
longer gives Producer prose a machine-readable semantic role.

### Producer Lane

Each Producer:

1. receives the same immutable Assignment;
2. works in its exact isolated Lane workspace;
3. returns one original result;
4. is marked successful when its Provider completes and its required
   Core-observed workspace snapshot is valid.

The Producer may be instructed to report outcome, changes, checks, findings,
uncertainty, and next action. Core does not parse those sections and does not
derive severity or check outcomes from them.

### Main synthesis

The main synthesis Turn receives stable source references in Lane order:

```ts
type SynthesisSource = Readonly<{
  laneId: string;
  roleName: string;
  turnId: string;
}>;
```

Its frozen Context Snapshot authorizes the exact successful Producer Turns.
The main Agent expands each source Turn and reads:

- the complete original `TurnResult.output`;
- the Core-observed workspace snapshot, when present;
- the immutable Assignment and Lane identity.

The dispatch input lists source references instead of embedding parsed Producer
objects. This avoids the 4 KiB Turn-input limit and keeps the existing Context
API as the only durable expansion path.

The main Agent synthesizes one new original result. For replicated WorkItem
execution, the Leader consumes that main result. For replicated Review, the
main Reviewer result completes the ReviewRound and the Leader consumes it.

Producer disagreements, reported findings, and claimed checks are resolved by
the main Agent, not by ExecutionGroup code.

## Leader result delivery

A Role completion event continues to carry the exact `turnId`; it does not
copy or summarize the result as a second authority.

Leader result consumption follows:

1. the Leader wake identifies the exact delta events;
2. `task wake show` resolves terminal events to their referenced Turn IDs,
   using event completion time rather than Turn creation time;
3. the Leader reads each exact result with `task turn show`;
4. the Leader records the lifecycle decision.

This must work for both a newly dispatched Leader Turn and a force-steer into
an active Leader Turn. A force-steer therefore includes the claimed event
references or an equivalent wake cursor, rather than only reason tags.

`task context` may keep bounded summaries for orientation, but summaries never
replace exact result consumption.

## Review and acceptance

Review keeps the boundaries that Core can prove:

- the ReviewRound and Reviewer identity;
- the exact frozen Candidate or Task heads;
- the exact Reviewer Turn and workspace;
- Provider completion or execution failure;
- whether the current Candidate still matches the reviewed heads.

Core does not derive from Reviewer text:

- Review pass or failure;
- semantic versus non-semantic output;
- findings or severity;
- check outcomes;
- accepted risk;
- delta-recheck disposition;
- repair topology.

When final Review is required, Task completion requires a completed
ReviewRound over the current exact Task heads and the required Reviewer
contract. The Leader's explicit `task complete` action is the semantic
acceptance decision.

A delta recheck may continue to freeze the previous Review, exact diff, and new
heads as objective context. Its requested disposition remains an Agent output
convention. The Leader reads the original result and decides whether to
complete, repair, or request a full Review; Core does not parse the disposition.

## Finding ledger and repair waves

Automatic finding extraction, severity normalization, cross-Round matching,
finding-ledger completion gates, and result-driven repair-wave planning leave
the active execution path.

The Leader already has the durable primitives needed to act:

- exact Worker and Reviewer Turn results;
- WorkItem accept or reject;
- same-WorkItem retry;
- Task Decision and Milestone records;
- new WorkItems only for independently owned requirements;
- explicit Review requests.

Existing valid finding-ledger records remain readable as historical audit
evidence after migration, but they do not block completion or drive
`next-action`. New Review results do not create ledger records.

## Tradeoffs

The design intentionally gives up:

- machine-readable finding and check counts derived from Agent prose;
- automatic repair-wave planning from Reviewer text;
- completion blocking based on extracted severity;
- automatic interpretation of delta-review wording.

In return, Yui has one result authority, fewer persistent concepts, and no
false semantic decision caused by formatting. Token, tool, duration, Provider,
workspace, Git, Integration, and Core-run check observability remain
structured.

When a check must be an engineering gate, Yui must run it through an existing
Core-owned check or DurableJob boundary. Parsing an Agent's claim that a check
passed is not equivalent evidence.

## Persistence transition

Use one adjacent aggregate migration.

### Turn

Advance `Turn` to v5 and `TurnResult` to v2:

```ts
type TurnResult = Readonly<{
  schemaVersion: 2;
  output: string;
  completedAt: string;
  provider?: TurnProviderResult;
  systemEvidence?: TurnSystemEvidence;
  failureReason?: TurnFailureReason;
  legacyProducer?: ProducerTurnResult;
}>;
```

`legacyProducer` is migration-only audit evidence. New Turns never write it,
and active execution, synthesis, acceptance, and observability never read it.

Where an earlier Producer payload and Turn workspace contain sufficient exact
Project information, migration also derives the Core-owned workspace snapshot.
Failure to derive it preserves the legacy payload without inventing a
snapshot.

### ReviewRound

Advance `ReviewRound` to v8. A current terminal Round contains:

- `reviewerTurnId` pointing to the exact main Reviewer Turn when one ran;
- `status` and `endedAt`;
- an optional Core-authored terminal failure for a Round that could not create
  or complete its main Turn;
- its existing frozen Candidate, workspace, execution Group, and request
  provenance.

It does not copy the Agent result into `summary`, `report`, or `checks`.

Migration moves existing reports, checks, evidence commits, findings, and
delta dispositions into one opaque `legacyResult` audit payload. Active
acceptance and completion code never reads that payload.

The current delta-recheck record keeps only objective lineage: previous Round,
previous head, exact diff digest, changed files, and line counts. Any requested
disposition and reasoning live only in the Reviewer Turn output.

### Finding ledger

Existing rows remain audit-only. The migration removes their operational
authority and removes the active `findingLedger=enforce` completion behavior.
No malformed or historical record is automatically repaired.

## Implementation boundaries

This is one coupled feature, not a set of parallel WorkItems. Result
terminalization, replicated synthesis, Review acceptance, and migration share
the same authority boundary and should change together.

The implementation order is:

1. make `TurnResult.output` plus Core-owned evidence the common result model;
2. make direct and replicated terminalization stop parsing Agent text;
3. make main synthesis consume exact source Turn refs and raw outputs;
4. make ReviewRound and completion depend only on objective execution and
   frozen-head facts;
5. remove finding-ledger and repair-wave authority;
6. update Leader, Worker, Reviewer, built-in Profile, CLI, Web, and
   observability wording;
7. add the adjacent migration and remove change-specific scaffolding after
   validation.

## Verification

Use deterministic local evidence only:

- a direct Worker may return normal Markdown and completes its Turn unchanged;
- a writable Producer with arbitrary non-empty text and a clean exact
  workspace snapshot succeeds;
- missing headings, invalid JSON, or no reported checks do not create
  `missing-result`;
- dirty or mismatched writable Lane state still fails;
- main synthesis receives every successful Producer's exact original output in
  stable Lane order;
- a direct or replicated Reviewer result remains unchanged and wakes the
  Leader;
- final-review gating checks the completed exact-head Round, not parsed
  findings or checks;
- existing structured Producer and finding-ledger history remains readable but
  has no active authority after migration;
- build and the seconds-scale core smoke pass.

No real Provider, paid model, shared Home, or production resource is required.

## Rollout and rollback

The change should ship as one adjacent aggregate version without a dual-mode
feature flag. Running both parsed and opaque authority would preserve the
ambiguity this design removes.

Before migration, rollback is an ordinary code rollback. After migration,
standard Yui storage-version rules apply: the previous binary must not open the
newer Home. Legacy Producer and finding data remains preserved so a later
forward fix can inspect it without reconstructing Agent semantics.

## Explicit non-goals

- No natural-language, Markdown, JSON, regex, or model-based result parser.
- No proof that an Agent result is complete or correct.
- No automatic acceptance, repair, retry, WorkItem creation, or Review
  escalation based on result text.
- No removal of replicated execution.
- No weakening of identity, authorization, workspace, Git, Provider, or
  lifecycle validation.
- No duplicate summary or finding store that competes with the original Turn
  result.
