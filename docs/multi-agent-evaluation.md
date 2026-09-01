# Multi-Agent Evaluation and Staged Enablement

This document is the T10 evaluation contract for Yui. It answers one product
question: when does an additional Agent route produce enough independently
verified value to justify its extra cost and failure surface?

The contract is deliberately read-only. It does not add a TaskGraph, a second
runtime, a persistent benchmark aggregate, or a default multi-Agent path. A
benchmark run consumes deterministic mock/replay evidence and produces a
report outside Yui's authoritative Task state. The report may cite Yui records
(`execution audit`, Task observability, Candidates, Reviews, Integrations, and
recovery events), but it never becomes a replacement source of truth.

## Decision order

Every arm is judged in this order:

1. **Acceptance and evidence** — the result satisfies the same acceptance
   contract and has independently sufficient evidence.
2. **Safety** — Review defects, integration failures, error amplification, and
   recovery behavior stay within the gate.
3. **Context** — the added routes do not exceed the bounded context envelope or create
   unexplained context growth.
4. **Cost and latency** — only exact token/tool observations and bounded
   wall-clock observations are counted.
5. **Marginal value** — extra Lane spend is justified by new accepted evidence,
   not by vote count, optimistic text, or a completed Turn.

If a required observation is not available, the metric is `partial` or
`unavailable` and the stage cannot be promoted. Missing evidence is never
treated as zero cost, zero defects, or successful recovery.

## Controlled arms

Use the same Task case, inputs, acceptance criteria, replay seed, and isolated
resource limits for each arm. The only intentional difference is the routing
strategy:

| Arm | Yui path | Purpose |
| --- | --- | --- |
| `single` | Leader-direct or one `single` Lane | Required baseline and default product path |
| `fixed-multi` | Explicit `parallel-diverse`/`ensemble-replicated` with a fixed Lane count and manual Resolve | MVP multi-route comparison |
| `critic-synthesis` | Explicit Generate → Compare → Synthesize → Verify → Resolve stages | Tests automatic comparison/synthesis policy once implemented |
| `adaptive` | Explicit adaptive exploration with the Resource Broker budget and quorum | Tests adaptive routing and early-stop decisions |

`single` is the control arm for every paired comparison. A multi-Agent arm is
never promoted merely because it is faster or uses more tokens; it must first
pass the same acceptance and evidence gates.

## Dataset and replay protocol

The benchmark dataset is a versioned, immutable collection of synthetic or
sanitized replay cases. It must contain at least these classes:

- serial work where extra parallelism should not help;
- genuinely parallel work with an explicit fan-out/fan-in dependency;
- ambiguous or evidence-heavy work where independent approaches may help;
- a recoverable Agent/Lane failure;
- a Review or Integration conflict that must remain Leader-owned.

The minimum sample counts below are **paired cases**, not raw Agent Turns. Each
case is replayed with the same seed and isolation boundary for every selected
arm. A case is excluded only before execution for a documented fixture defect;
dropping an inconvenient result after execution is a failed benchmark.

A result file is an ephemeral evidence envelope, not a Yui record. Its shape is
equivalent to:

```json
{
  "schemaVersion": 1,
  "dataset": {"id": "t10-core", "revision": "2026-08-26", "seed": 37},
  "caseId": "parallel-03",
  "arm": "fixed-multi",
  "replicate": 1,
  "quality": {
    "firstAcceptance": true,
    "finalAcceptance": true,
    "evidenceSufficient": true,
    "reviewDefects": 0,
    "p1P2Defects": 0,
    "integration": "committed"
  },
  "resources": {
    "tokens": 18400,
    "toolCalls": 31,
    "wallClockMs": 9200,
    "observable": true
  },
  "context": {
    "snapshotCount": 3,
    "largestBytes": 42000,
    "peakInputTokens": 12000,
    "compression": "unavailable"
  },
  "recovery": {
    "attempted": false,
    "succeeded": null,
    "timeToRecoveryMs": null,
    "resultReused": false
  },
  "marginalValuePercent": null,
  "evidenceRefs": ["task:task-37", "review-round:review-1"]
}
```

Do not put full transcripts, credentials, provider secrets, or unbounded
diagnostic output in the envelope. `evidenceRefs` point back to durable Yui
records; the records remain authoritative.

## Metric definitions

All rates are computed per paired case and then summarized with the number of
cases and the arm. The report must show numerator, denominator, and an
observation status (`complete`, `partial`, or `unavailable`).

### Quality and safety

- **First acceptance rate**: cases whose first Candidate reaches acceptance
  without a rejection or repair wave.
- **Final acceptance rate**: cases that eventually reach the same accepted
  outcome as the control contract.
- **Evidence sufficiency rate**: cases for which the Leader/Reviewer can prove
  the acceptance criteria with the required checks and evidence references.
- **Review defect rate**: material Review findings per accepted case; report
  P1/P2 defects separately.
- **Integration success rate**: accepted cases whose exact candidate passes the
  required Integration checks and advances the target.

The acceptance contract is the comparison boundary. A result that wins a vote
but fails evidence or Integration is not a quality win.

### Cost and latency

Report exact observed tokens, tool calls, and bounded wall-clock duration. When
all three are observable, also report a normalized cost index against the
paired `single` case:

```text
costIndex = 0.6 × (tokens / single.tokens)
          + 0.2 × (toolCalls / single.toolCalls)
          + 0.2 × (wallClockMs / single.wallClockMs)
```

The coefficients are the T10 comparison convention, not a billing promise.
Division by a zero or unobservable control value makes the index
`unavailable`; do not substitute a guessed denominator. Cost never outranks a
failed acceptance or evidence gate.

### Context

Report snapshot count, total/largest serialized bytes, and observed peak input
tokens from structured runtime observations. Provider compression and cache
effects remain `unavailable` until a driver records them explicitly. Context
growth is a safety signal even when the model appears to finish successfully.

### Error amplification

For each arm, count material defects that are introduced, missed, or propagated
through Generate, Synthesize, Verify, Review, or Integration. Compare the arm
with its paired `single` control:

```text
errorAmplification = arm.materialDefectRate / single.materialDefectRate
```

If the control defect rate is zero, report `not-estimable` plus the arm's raw
defect count; never manufacture a ratio of `1.0`. A multi-Agent arm fails the
safety gate when it increases P1/P2 defects or turns a recoverable failure into
an accepted-but-incorrect result.

### Recovery

- **Recovery success rate**: attempted recoveries that reach a valid terminal
  outcome with the original acceptance contract intact.
- **Time to recovery**: bounded time from the first confirmed failure signal to
  the recovered Turn/Lane or explicit Leader disposition.
- **Result reuse rate**: recoveries that reuse durable in-flight evidence
  instead of replaying an already completed result.

Use structured Turn/Lane recovery records and durable result references. A live
pane, silence timeout, or provider Turn completion is not recovery evidence.

### Marginal value

Only Verify/Resolve evidence may supply `marginalValuePercent`. It represents
the independently accepted evidence gained by the additional Lane spend after
quorum, divided by that additional spend. If no new accepted evidence is
produced, the value is `0`; if the runtime did not observe the comparison, it
is `unavailable`. Do not infer it from the number of Lanes, vote counts, or
wall-clock savings.

## Initial staged gates

These are conservative starting thresholds for the T10 rollout. Changing a
number requires a new durable Decision with the benchmark evidence; changing a
gate is not an implementation detail.

### Stage 0 — establish the baseline

- At least **20 control cases**, with **5 cases in each required class** and
  **3 deterministic replicates** per case. These are the `single` arm; later
  stages replay the same cases as paired comparisons.
- Run only the `single` arm first.
- Record complete quality, safety, cost, context, and recovery observations.
- Do not enable multi-Agent routing based on a partial baseline.

### Stage 1 — fixed multi-route MVP, manual Resolve

Promotion requires all of the following over at least **20 paired cases**:

- first acceptance is no worse than `single` by **5 percentage points**;
- final acceptance and evidence sufficiency are no worse than `single`;
- Integration success is no worse by **2 percentage points**;
- P1/P2 defect rate is no higher by **5 percentage points** and
  `errorAmplification ≤ 1.10` when estimable;
- `costIndex ≤ 2.00` and largest context bytes/peak input tokens are each
  `≤ 2.00×` the paired `single` case;
- attempted recovery success is **≥ 95%** and no accepted result loses durable
  evidence;
- every gate metric is complete (not partial/unavailable).

The feature remains explicit and opt-in. The Leader manually compares and
resolves the selected result; `single` remains the default.

### Stage 2 — automatic comparison/synthesis

Promotion requires at least **40 paired cases**, **10 per class**, and:

- first acceptance improves by **≥ 5 percentage points**, or Review defect rate
  drops by **≥ 10%** relative to `single`;
- final acceptance and evidence sufficiency are no worse than `single`, with
  evidence sufficiency **≥ 98%**;
- Integration success is **≥ 99%** and P1/P2 defects do not increase;
- `errorAmplification ≤ 1.05`, `costIndex ≤ 2.50`, and context growth is
  `≤ 2.00×`;
- recovery success is **≥ 95%** and the median observed marginal value of
  extra Lane spend is **≥ 10%**;
- automatic synthesis is still disabled when any metric is incomplete.

### Stage 3 — adaptive scheduling

Promotion requires at least **60 paired cases**, **15 per class**, and:

- final acceptance improves by **≥ 5 percentage points** without lowering
  first acceptance or evidence sufficiency;
- P1/P2 defect rate is no higher than `single`, `errorAmplification ≤ 1.00`,
  and Integration success is **≥ 99%**;
- `costIndex ≤ 1.75`, context growth is `≤ 1.50×`, and the 75th-percentile
  marginal value of additional Lane spend is **≥ 10%**;
- recovery success is **≥ 98%**, with every confirmed-dead case ending in an
  explicit Leader disposition;
- no unbounded Lane fan-out, default-on behavior, or budget bypass appears in
  the replay evidence.

Failure of a gate keeps the current stage; it does not auto-retry with more
resources or silently downgrade the acceptance contract.

## Rollout and rollback

1. Keep `single` as the default and collect Stage 0 evidence from deterministic
   mocks/replays.
2. Enable only the explicit fixed multi-route command for Stage 1. Record the
   dataset revision, replay seed, Yui build identity, and exact evidence refs.
3. Promote to automatic comparison/synthesis or adaptive scheduling only after
   the corresponding gate is met and a Leader/Operator Decision records the
   scope, metrics, and residual risk.
4. Any real Provider, paid model, shared Home, or production validation is a
   separate user-authorized action; it is never implied by this benchmark.
5. Roll back by returning to the last accepted stage or `single`. No Yui
   storage migration or business-state rewrite is required. A failed or
   incomplete report is retained as evidence and cannot authorize promotion.

The existing read-only commands are the primary evidence entry points:

```sh
yui execution audit --task <task-id> --json
yui task context <task-id> --json
yui task next-action <task-id> --json
```

These commands expose what Yui can prove. The evaluator must preserve their
`partial`/`unavailable` signals rather than filling gaps from token estimates,
process presence, or transcript inspection.
