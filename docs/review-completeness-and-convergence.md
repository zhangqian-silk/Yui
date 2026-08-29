# Review Completion and Result Batching

Status: implemented contract

This document defines the minimal change needed to prevent
one-finding-per-round Review behavior. It is deliberately separate from
[Managed Run Delivery and Session Recovery](managed-run-delivery-and-session-recovery.md),
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

## Why task-58 produced repeated findings

The existing `ReviewYieldReport` can already contain multiple findings. The
finding ledger can already preserve each finding across repair rounds. The
problem was not a one-finding schema limit.

The Reviewer behavior allowed a valid first finding to become a terminal Review
result before the Reviewer had finished examining the candidate. The Leader
then fixed that one reported issue, requested another Review, and the next Round
found another issue. Infrastructure failures and unnecessary Session churn made
the trajectory longer, but they were separate runtime problems.

The smallest correction is to move the semantic yield boundary to the end of
the Reviewer's own review process.

## Goals

- Make Review result submission a terminal action after review completion.
- Accumulate all findings discovered before that terminal submission.
- Let the Leader receive and address the complete submitted batch.
- Keep each ReviewRound bound to one exact frozen candidate.
- Reuse the same Reviewer native Conversation across ordinary rounds.
- Keep infrastructure failure separate from semantic Review results.

## Non-goals

- Defining how a Reviewer must inspect code.
- Proving that a Reviewer found every possible issue.
- Adding coverage declarations or machine-readable completion evidence.
- Grouping findings through a new invariant-family domain model.
- Adding a semantic Review budget or forced acceptance rule.
- Blocking Review requests based on prose, round count, or elapsed time.
- Creating a new Reviewer Session for every ReviewRound.

## Review behavior

### 1. Start from the exact candidate

The Reviewer reads the ReviewRound, frozen candidate, scope, relevant Task or
Work Item context, previous findings, and available evidence through Yui's
durable context API.

The candidate remains immutable for that Round. If the candidate identity is
wrong or changes during inspection, the Reviewer cannot produce a trustworthy
semantic result for that Round.

### 2. Accumulate instead of yielding early

While reviewing, the Reviewer keeps discovered findings in its working context.
Finding one valid defect does not end the review and does not trigger `yield`.

The Reviewer decides how much inspection is appropriate and when the review is
complete. Yui does not prescribe an internal checklist or additional sweep.

### 3. Submit one completed result

After the Reviewer judges the review complete, it yields one
`ReviewYieldReport` containing:

- the overall verdict and summary;
- every material finding accumulated during the review;
- checks and evidence actually used, when any; and
- the exact reviewed candidate evidence required by the existing contract.

The existing report shape remains authoritative. `findings` is already an
array, so no new persistent field or schema version is expected.

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

Retry remains a Leader-owned decision. A failed attempt does not automatically
create another ReviewRound or another Reviewer Session.

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
2. It does not pre-create a future Leader Run.
3. If the Leader is active, the Review result remains pending until a natural
   Turn boundary; Yui does not interrupt the Leader.
4. If a new Leader Run is needed, its Run and initial delivery intent are
   admitted atomically; the Provider Turn begins only after the Host binds the
   exact Conversation and Activation.
5. Leader and Reviewer Conversations survive ordinary Run and ReviewRound
   boundaries.
6. Review duration, finding count, verdict, and round count are not Session
   replacement evidence.

## Skill changes

### Reviewer Skill

Add one direct instruction to `skills/yui-reviewer/SKILL.md`:

> Complete the review before yielding. Do not yield when you discover the first
> finding. Accumulate all findings discovered during the review and submit them
> together in one final Review result.

Existing guidance for candidate identity, evidence, delta review, and
infra-versus-semantic failure remains unchanged.

### Leader Skill

Clarify in `skills/yui-leader/SKILL.md` that the Leader reads the complete
submitted finding batch before planning repairs and does not treat each finding
as a reason to launch an independent Review cycle.

This is behavioral guidance only. It does not add a new durable state or
scheduler gate.

## Engineering impact

No Review-domain schema or migration is expected.

- `ReviewYieldReport.findings` already carries multiple findings.
- Review terminalization and the finding ledger retain their existing identity
  and atomicity rules.
- No canonical `ReviewCheck` values are added.
- No semantic-completeness validator is added.
- No Review-count or finding-family admission rule is added.

Production-code changes for Run delivery and Session continuity belong to the
companion runtime design. If implementation inspection confirms that one
Review result already reconciles multiple findings correctly, the semantic
Review change is limited to the two Skills.

## Verification

Verification follows [Yui's verification policy](testing/verification-levels.md).
No real Provider or shared Home is required.

- Inspect the final Reviewer Skill to confirm that the yield boundary is after
  review completion, not after the first finding.
- Inspect the final Leader Skill to confirm that it consumes the complete
  submitted result before planning repairs.
- Use a small deterministic report/ledger check only if current evidence does
  not already prove that one result can carry multiple findings.
- Validate Session continuity and no-precreated-Leader-Run behavior under the
  companion runtime implementation, not through a semantic completeness test.

No permanent combinatorial Review fixture is required for a Skill-only behavior
change.

## Acceptance criteria

The design is implemented when:

- Reviewer guidance says to finish reviewing before yielding.
- Discovering the first finding does not instruct the Reviewer to end the
  Review.
- All findings collected before completion are submitted in one existing
  `ReviewYieldReport`.
- Leader guidance consumes the complete submitted batch before repair planning.
- No checklist, final sweep, completion validator, Review budget, or new
  persistent state is introduced.
- Ordinary re-review reuses the Reviewer Conversation.
- Review completion does not pre-create or interrupt a Leader Run.
- Infrastructure failure before semantic inspection remains non-semantic;
  mixed infrastructure and semantic evidence remains ambiguous.
