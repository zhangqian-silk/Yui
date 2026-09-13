<p align="right"><strong>English</strong> | <a href="./agent-result-consumption.zh-CN.md">简体中文</a></p>

# Agent result consumption

For candidate discovery before reading original results, use the
[bounded Task catalog](task-discovery.md). A catalog summary never replaces a
requirement or the original result.

Every explicitly dispatched AgentRun produces one durable original result.
Ordinary notification and native conversation do not implicitly create Runs.
The next Agent in the ownership chain reads the exact result and decides what
it means.

## One original result

`AgentRunResult.output` is the Agent-authored report. Core preserves its bytes
and does not parse, classify or validate semantic content. Markdown, JSON and
ordinary prose are all legal; omitted headings or an unconvincing conclusion are
quality evidence, not a runtime failure.

Core separately records Provider identity/status, completion time, diagnostics,
failure reasons and system-owned workspace evidence. Non-empty output must fit
the current transport limit and contain no NUL. Missing or untransportable text
fails the Run without fabricated prose. An arrived report can remain on a failed
Run when a later Core-owned boundary fails.

One reference Message is saved with the terminal result.
`task message show <task/message>` and Context inspect expand the same
`resultRef`. ReviewRound does not hold a second report. Files and durable
business outputs belong to Artifacts or managed Git results.

## Execution is not acceptance

Run lifecycle is `active / completed / failed`. Provider outcome, input
acceptance and resource quiescence are separate facts. A completed Run means
its required Core execution boundaries succeeded, not that its answer is
correct or the WorkItem accepted.

Writable replicated Lanes require their exact Core-owned workspace evidence.
A wrong branch, dirty snapshot, mismatched owner or scope fails that boundary
without replacing an already arrived original report.

Only the Leader decides whether evidence warrants acceptance, further work,
another review or abandonment. Core never derives findings, votes or repair
topology from Agent text.

## Direct and replicated execution

Direct WorkItem execution uses one main Run and no ExecutionGroup. Direct
Review likewise uses one main Reviewer Run.

Replicated execution uses distinct Producer Lanes over one frozen Assignment.
Each Producer retains its own original result and exact lineage. Leader
explicitly supplies distinct terminal source Run references to synthesis.
Sources must belong to the exact Group/Lane and have a result; they may be
completed or failed. There is no automatic synthesis, vote, minimum successful
Producer count or requirement to wait for all Lanes before choosing sources.

The synthesis snapshot retains the selected source order and bounded views of
their original outputs, diagnostics and provenance. It does not copy complete
transcripts. Only the main synthesis result can supply the WorkItem Candidate
or authoritative replicated Review result. Producers never enter Integration
or acceptance directly. Retry targets the failed exact execution; it does not
silently rerun successful Producers.

## Review

ReviewRound owns frozen Candidate or Task-head identity, workspace provenance,
execution topology, exact main Reviewer Run, lifecycle and Core diagnostics.
Its completed state is structural execution evidence, not a “pass” extracted
from the report.

Candidate review follows its captured review rule. Task-final review can be
explicitly requested or required by the immutable final-review contract. A
requested review is evidence, not an automatic new policy requiring review
after every subsequent change. When current delivery requires a review, it
must cover the exact governing candidate or heads and completed main Run.

The Reviewer should inspect the complete bounded scope and report material
findings together. The Leader reads the full report, routes findings to the
original owner, fixes small Task-main issues directly, and creates a new
WorkItem only for substantial independent work.

## Leader consumption

Wake windows point to result-bearing events, including a Run created before
the window but completed inside it. Read the exact source:

```sh
yui task wake show <task> <wake>
yui task run show <task/run>
yui task message show <task/message>
```

An optional report layout is outcome, changes/findings, verification, uncertainty
and next action. It is communication guidance, not a machine protocol.

Acceptance and Task completion remain explicit operations with current Git,
review, scope and resource checks. See [Session and AgentRun](managed-turn-and-session-runtime.md)
and [Task dependencies](task-dag-semantics.md).
