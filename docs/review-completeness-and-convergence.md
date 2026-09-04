# Review Completion and Result Batching

Status: superseded on 2026-09-04

The behavioral rule remains simple: a Reviewer should finish the assigned
frozen-scope inspection and return all material findings together instead of
ending at the first issue.

The former structured ReviewResult, semantic classifier, finding ledger, and
repair-wave design no longer exists. Reviewers now return one original result;
Yui preserves it unchanged, and the Leader reads it and decides what to do.

See [Agent Result Consumption](agent-result-consumption.md) for the current
execution, persistence, wake, Review, and completion contract.
