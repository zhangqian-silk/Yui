# SQLite control-plane storage

Yui has one authoritative product Store: `YUI_HOME/yui.db` in WAL mode. The
manifest `schema.json` declares the exact layout, aggregate, and record-family
versions accepted by the running release.

## Authority

- `yui.db` owns Tasks, WorkItems, Turns, Messages, Decisions, results, Project
  Knowledge references, managed workspace records, runtime bindings, mailboxes,
  durable events, and configuration.
- Provider Sessions, transcripts, processes, caches, telemetry, and runtime
  observations support execution and diagnosis; they do not replace durable
  Task facts.
- `state.json`, if found, is historical evidence only. Current code never reads
  it as a fallback and never rebuilds `yui.db` from it.

## Admission

Ordinary commands open a Home only when all of these are true:

1. `schema.json` is valid and every declared version exactly matches the
   running release.
2. `yui.db` exists and opens through the current schema loader.
3. Record validation and reference integrity succeed.

An older, newer, incomplete, or malformed Home fails ordinary admission.
`yui doctor` and `yui upgrade --dry-run` report the reason without changing the
Home; explicit `yui upgrade` performs the same read-only exact-current
validation. There is no in-process normalization, repair worker, file-Store
fallback, dual read/write, backup switch, or migration receipt protocol.

Preserve an old Home byte-for-byte. Use its original Yui release for read-only
inspection, then initialize a new Home and let the Operator create a new Task
from the objective, relevant WorkItems, repository state, and available exact
Turn results. New records receive new identities; Provider/session state is not
imported.

## Write and concurrency contract

- Each mutation is one SQLite transaction.
- WAL plus `synchronous=FULL` provides the durable commit boundary.
- `home_meta.revision` is the Home-wide CAS/revision used by callers that need
  a frozen read/modify/write boundary.
- Typed columns support indexed identity and status queries; the full validated
  record payload remains the durable domain representation.
- Mailbox claim, exact Turn terminalization, active-pointer removal, result
  persistence, and downstream wake creation are transactionally coupled where
  they form one product fact.
- Idempotency keys and unique constraints protect repeatable external-effect
  acknowledgements; they do not form a second workflow state machine.

## Turn and Session boundary

A Turn is one provider-visible input/terminal interval. It records visible
inputs and the final provider output, but not hidden reasoning or the full tool
trace. A Provider Session is a reusable conversation and may contain many Yui
managed or direct-user Turns. A native Turn terminal ends the Turn only; the
Leader remains the authority for WorkItem and Task completion.

## Update behavior

`yui update` stages an exact package, asks that staged binary to verify the
existing Home against its current contract, stops the exact Controller,
activates the same package, verifies the installed binary and unchanged Home,
and starts the replacement Controller.

Every persistent schema change advances the exact current contract. This release
does not ship historical migration steps; Homes on any other contract are
rejected without mutation.
