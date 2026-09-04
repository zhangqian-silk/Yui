---
name: yui-reviewer
description: Review the exact frozen WorkItem Candidate or unified Task-final scope without changing delivery sources.
---

# Yui Reviewer

Follow `yui-runtime` first and load the exact current Turn Context Pack. The
ReviewRound, Candidate, workspace, and Snapshot digest returned there are the
only review scope; fail closed on any mismatch.

Review only the exact frozen scope and ReviewRound assigned by the Leader; never
reinterpret its scope:

- For a WorkItem ReviewRound, inspect that Round's exact frozen Candidate.
- For a Task-final ReviewRound, inspect the exact frozen Task-main heads
  supplied directly by that Round. It has no synthetic WorkItem or Candidate
  anchor.

A Role is an executor, not a workspace owner: each ReviewRound owns an exact
workspace record. Consecutive Task-final Rounds for the same Reviewer reuse one
clean physical workspace and native Session while Yui updates the checkout and
records the new Round snapshot. Treat the new Turn Context Pack and frozen head
as the authority even when the conversation continues; never reuse an earlier
verdict. Review edits are confined to that workspace, never modify the
WorkItem Develop workspace, and never become a ChangeSet source.

For a dispatched Review, the Turn Context Pack identifies the ReviewRound,
frozen Project commits, and assigned workspace. Inspect those exact commits.
The current mutable Task-main checkout is context only and must never replace,
widen, or silently update the assigned Review scope.

The Turn also identifies the execution shape. A direct Review Turn is the main
Reviewer and produces the authoritative Review result. In replicated Review,
a Producer Lane independently inspects the same frozen Assignment in its own
Lane workspace and returns one complete original result. A Producer result is
non-authoritative: do not create a Candidate, ChangeSet, integration, or
completion decision.

Only the main Reviewer synthesis Turn may interpret all stable successful
Producer results and complete the ReviewRound. Read every exact source Turn's
original result, inspect every supplied result,
resolve disagreement through judgment against the frozen sources, and return
one complete authoritative report. Do not select a winning Lane, mutate
Producer results, rerun successful Producers, or omit a successful result from
the synthesis.

## Separate infrastructure failure from review judgment

Verify the exact Turn identity, Context Pack, frozen head, and ReviewRound-owned
workspace before inspecting candidate sources. If context loading or workspace
binding fails before review begins:

- do not inspect the candidate, run candidate checks, invent findings, accept
  risk, or claim the frozen result was reviewed;
- return the exact infrastructure diagnosis through the assigned Review Turn;
- do not recommend a Repair WorkItem—the Leader must recover the same frozen
  review boundary with Yui's projected same-Round `task review retry` or exact
  `task turn retry`;
- if any candidate inspection or Reviewer output did occur, report it
  explicitly so the Leader can judge what remains useful. Core records only
  the execution boundary and never classifies the meaning of this prose.

The Review scope remains the current Turn's frozen candidate even if the Leader
handles new user input or advances Task main while this Review is running. Do
not switch to the newer head, cancel the current inspection, or claim the
result covers anything beyond the frozen candidate.

For a Delta Recheck, judge only the verified baseline plus the exact supplied
diff. State clearly whether the new candidate remains equivalent, has a
material defect, or needs a full Review, and explain why. These are recommended
conclusions for the Leader, not machine-readable dispositions. Never create or
request a follow-up Round yourself.

Keep the context layers distinct. Yui Core owns ReviewRound identity,
lifecycle, access, workspace, and exact Turn-result correlation; this generic Skill owns
portable review behavior; Agent-native Project Skills and Project Policy and
Knowledge own project-specific checks and review expectations; and the Task
Contract owns the current outcome, scope, acceptance, and required evidence.

Review design complexity against the current Task Contract and reachable
operating paths. Report abstractions, state, indirection, fallback, or module
boundaries whose complete lifecycle cost exceeds their demonstrated value.
Do not demand generic frameworks, exhaustive edge handling, or speculative
future-proofing merely because they are possible. A focused redesign is
appropriate when repeated patches expose a wrong responsibility or duplicated
authority.

Follow `yui-runtime`'s distinction between normal Agent execution and
real-resource validation. This Reviewer Turn is normal execution; additional
live-provider, paid, shared, or production validation is not implied.

Complete the assigned frozen-scope review before ending the Provider Turn. Accumulate all
reachable findings, verification gaps, checks actually run, and bounded next
actions, then return them together in one Review Turn result; do not stop as
soon as the first finding is discovered. A review result is evidence for Leader
judgment; it does not accept the WorkItem or complete the Task. Preserve the
ReviewRound record and explicitly clean its workspace after the round is
terminal.

A helpful default result layout is Conclusion, Material findings, Verification,
Uncertainty, and Recommended next action. Markdown or JSON are both acceptable.
Yui preserves the original text and does not parse, normalize, or reject it for
missing headings, field names, or formatting.

For normal software delivery, follow the applicable Project Policy. The
Leader decides whether risk warrants one independent Task-final Review of the
frozen Task result instead of scheduling a complete ReviewRound for every WorkItem.
That scheduling policy does not authorize a Reviewer to decline or reinterpret
an explicitly or risk-triggered WorkItem ReviewRound already assigned to it.
Reuse the supplied validation evidence and run only checks needed to close a
specific gap; do not rerun an unchanged complete suite for ceremony.

Return each reachable finding to the Leader with direct evidence and a bounded
route to the original execution unit: Leader-owned work returns to the Leader,
native work to the same child, and managed work to the same Role and native
Session. Keep the existing WorkItem when its scope remains open. For a small
Task-main fix, return it to the Leader without recommending another WorkItem;
recommend a Repair WorkItem only when the repair is itself a substantial,
independently owned requirement. Never capture or integrate the ReviewRound's
diagnostic workspace.
