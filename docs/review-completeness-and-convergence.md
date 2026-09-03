# Review Completion and Result Batching

Status: implemented contract

This document defines the minimal change needed to prevent
one-finding-per-round Review behavior. It is deliberately separate from
[Managed Turn and Session Runtime](managed-turn-and-session-runtime.md),
which owns Turn delivery, native Session continuity, monitoring, and recovery.

## Product decision

A Reviewer does not submit a Review result when it discovers the first finding.
It keeps reviewing, accumulates findings locally, and submits one result only
after it judges the current review complete.

That is a Reviewer Skill rule, not a new workflow protocol. Yui does not add a
mandatory checklist, second pass, final sweep, minimum duration, minimum
finding count, completeness validator, or Review-admission gate.

The rule improves batching but cannot guarantee that a model discovers every
possible defect. A later Review may still find something new.

Review execution has two shapes over that same semantic contract:

- direct Review creates one authoritative main Reviewer Turn and no Group or
  Lane;
- replicated Review freezes one Assignment for at least two isolated Producer
  Lanes, waits for every Lane to settle, then creates one authoritative main
  Reviewer synthesis Turn from all successful durable Producer results.

Producer results never create Review findings, classifications, completion, or
delivery artifacts. They are evidence for the main Reviewer, not competing
Review verdicts.

## Why task-58 produced repeated findings

The existing `ReviewResultReport` can already contain multiple findings. The
finding ledger can already preserve each finding across repair rounds. The
problem was not a one-finding schema limit.

The Reviewer behavior allowed a valid first finding to become a terminal Review
result before the Reviewer had finished examining the candidate. The Leader
then fixed that one reported issue, requested another Review, and the next Round
found another issue. Infrastructure failures and unnecessary Session churn made
the trajectory longer, but they were separate runtime problems.

The smallest correction is to require the Reviewer to finish inspection before
ending its Provider Turn.

## Goals

- Make Review result submission a terminal action after review completion.
- Accumulate all findings discovered before that terminal submission.
- Let the Leader receive and address the complete submitted batch.
- Keep each ReviewRound bound to one exact frozen candidate.
- Reuse the same Reviewer native Conversation across ordinary rounds.
- Keep infrastructure failure separate from semantic Review results.
- Preserve one authoritative Review result whether execution is direct or
  replicated.
- Make Producer retry and main retry reuse successful immutable Lane results.

## Non-goals

- Defining how a Reviewer must inspect code.
- Proving that a Reviewer found every possible issue.
- Adding coverage declarations or machine-readable completion evidence.
- Grouping findings through a new invariant-family domain model.
- Adding a semantic Review budget or forced acceptance rule.
- Blocking Review requests based on prose, round count, or elapsed time.
- Creating a new Reviewer Session for every ReviewRound.
- Selecting a winning Producer Lane or resolving a Group by policy.
- Treating Producer findings as authoritative ledger entries.

## Review behavior

### 1. Start from the exact candidate

The Reviewer reads the ReviewRound, frozen candidate, scope, relevant Task or
Work Item context, previous findings, and available evidence through Yui's
durable context API.

The candidate remains immutable for that Round. If the candidate identity is
wrong or changes during inspection, the Reviewer cannot produce a trustworthy
semantic result for that Round.

### 2. Accumulate before ending the Turn

While reviewing, the Reviewer keeps discovered findings in its working context.
Finding one valid defect does not end the review or its Provider Turn.

The Reviewer decides how much inspection is appropriate and when the review is
complete. Yui does not prescribe an internal checklist or additional sweep.

### 3. Submit one authoritative completed result

For direct Review, the main Reviewer returns the complete result after judging
the review complete.

For replicated Review, each Producer returns durable summary, checks, findings,
evidence, and exact code references for its isolated attempt. After all Lanes
settle, at least two successful Producer results create one idempotent main
Reviewer synthesis Turn. The main Reviewer inspects every stable successful
result, resolves disagreement against the frozen sources, and returns the one
authoritative Review result containing:

- the overall verdict and summary;
- every material finding accumulated during the review;
- checks and evidence actually used, when any; and
- the exact reviewed candidate evidence required by the existing contract.

The main report shape remains authoritative. `findings` is already an array;
Producer findings remain embedded in Producer Turn evidence until the main
Reviewer chooses and supports an authoritative finding.

### 4. Keep non-semantic failure separate

If Provider, Host, workspace, candidate identity, or required context failure
prevents any candidate inspection or Reviewer semantic output, the attempt ends
as non-semantic failure. It submits only the exact infrastructure diagnosis and
does not reject the candidate semantically.

If candidate inspection, a finding, or any other semantic Reviewer output
already occurred before the infrastructure failure, the attempt is
`ambiguous`, not cleanly non-semantic. The Reviewer reports both the partial
semantic evidence and the infrastructure failure, but does not label that
partial batch as a completed Review verdict. The Leader diagnoses the ambiguous
boundary before deciding whether to retry review or plan a repair.

Retry remains a Leader-owned decision. A failed Producer Turn leaves its
logical Lane open for exact retry or explicit settlement, while successful
siblings remain reusable. A failed main synthesis Turn preserves the settled
Group and Producer results for one later main retry. Neither path creates
another ReviewRound or reruns successful Producers.

## Leader behavior

The Leader reads the entire submitted Review result before planning repairs. It
addresses the submitted findings as one batch and freezes a new candidate only
after the intended repairs and bounded verification are complete.

How the Leader groups or implements those repairs remains Leader judgment. This
design does not introduce a required invariant-family projection, repair matrix,
or design-reassessment gate.

Existing ReviewFinding dispositions and Task completion policy continue to
control whether unresolved findings block completion. No number of ReviewRounds
automatically accepts or rejects the Task.

## Re-review

A repaired candidate receives a new ReviewRound because it is new semantic
evidence against a different frozen candidate. The Reviewer receives the prior
result and repair delta as context, completes its review, and again submits one
result at the end.

A new ReviewRound does not imply a new Provider Conversation. Ordinary
re-review resumes the same Reviewer native Conversation and reuses the managed
Reviewer workspace. Only the exact runtime recovery rules in the companion
design can authorize Session replacement.

## Runtime and mailbox boundary

Review orchestration follows these shared rules:

1. A completed Review writes its ReviewRound, finding-ledger changes, and
   durable mailbox references.
2. It does not pre-create a future Leader Turn.
3. If the Leader is active, the Review result remains pending until a natural
   Turn boundary; Yui does not interrupt the Leader.
4. If a new Leader Turn is needed, its initial delivery intent is
   admitted atomically; the Provider Turn begins only after the Host binds the
   exact Conversation and Activation.
5. Leader and Reviewer Sessions survive ordinary Turn and ReviewRound
   boundaries.
6. Review duration, finding count, verdict, and round count are not Session
   replacement evidence.
7. Producer terminalization updates only the exact Lane and queues normal
   reconciliation. Only the main Reviewer Turn terminalizes the ReviewRound and
   reconciles the finding ledger.

## Skill changes

### Reviewer Skill

Add one direct instruction to `skills/yui-reviewer/SKILL.md`:

> Complete the review before ending the Provider Turn. Do not stop when you
> discover the first finding. Accumulate all findings discovered during the
> review and return them together in one final Review result.

Existing guidance for candidate identity, evidence, delta review, and
infra-versus-semantic failure remains unchanged.

### Leader Skill

Clarify in `skills/yui-leader/SKILL.md` that the Leader reads the complete
submitted finding batch before planning repairs and does not treat each finding
as a reason to launch an independent Review cycle.

This is behavioral guidance only. It does not add a new durable state or
scheduler gate.

## Engineering impact

ReviewRound schema v7 stores only the current direct/replicated execution unit
plus the existing authoritative terminal Review fields. Turn schema v4 permits
a main Review Turn to record the settled source ExecutionGroup while remaining
outside every Lane.

The adjacent aggregate migration preserves valid terminal pre-v7 Review
history as opaque legacy evidence. An active legacy strategy/resolution Group
cannot be reinterpreted as the new immutable producer unit, so migration
explicitly fails the Round and its active Turns and appends an audit event. No
adapter, repair worker, or dual runtime behavior remains.

The finding ledger, semantic classifier, Candidate, ChangeSet, Integration, and
acceptance paths consume only the main Reviewer result. No canonical
`ReviewCheck`, semantic-completeness validator, Review-count admission rule,
selected-Lane resolution, or resource-budget protocol is added.

## Verification

Verification follows [Yui's verification policy](testing/verification-levels.md).
No real Provider or shared Home is required.

- Inspect the final Reviewer Skill to confirm that the Provider Turn ends after
  review completion, not after the first finding.
- Inspect the final Leader Skill to confirm that it consumes the complete
  submitted result before planning repairs.
- Exercise direct Review with no Group/Lane and replicated Review with at least
  two isolated Producer Roles followed by one main synthesis Turn.
- Verify Producer terminalization cannot update the ReviewRound result or
  finding ledger, and main retry preserves successful Producer results.
- Exercise the adjacent migration for preserved terminal history and audited
  terminalization of an active legacy Group.
- Use a small deterministic report/ledger check only if current evidence does
  not already prove that one result can carry multiple findings.
- Validate Session continuity and no-precreated-Leader-Turn behavior under the
  companion runtime implementation, not through a semantic completeness test.

No permanent combinatorial Review fixture is required for a Skill-only behavior
change.

## Acceptance criteria

The design is implemented when:

- Reviewer guidance says to finish reviewing before ending the Turn.
- Discovering the first finding does not instruct the Reviewer to end the
  Review.
- All findings collected before completion are submitted in one existing
  `ReviewResultReport`.
- Leader guidance consumes the complete submitted batch before repair planning.
- Direct Review has one main Turn and no Group or Lane.
- Replicated Review waits for all Lanes, requires at least two successes, and
  creates at most one initial main synthesis Turn.
- Only the main Reviewer result is authoritative; Producer results are durable
  non-authoritative evidence.
- No checklist, final sweep, completion validator, Review budget, or new
  independently writable resolution state is introduced.
- Ordinary re-review reuses the Reviewer Conversation.
- Review completion does not pre-create or interrupt a Leader Turn.
- Infrastructure failure before semantic inspection remains non-semantic;
  mixed infrastructure and semantic evidence remains ambiguous.
