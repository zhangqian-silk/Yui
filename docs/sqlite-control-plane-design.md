# SQLite control-plane storage

Yui has one authoritative product Store: `YUI_HOME/yui.db` in WAL mode. The
highest contiguous, checksummed row in `schema_migrations` is the one Home
storage version accepted by the running release.

## Authority

- `yui.db` owns Tasks, WorkItems, Turns, Messages, Decisions, results, Project
  Knowledge references, managed workspace records, runtime bindings, mailboxes,
  durable events, and configuration.
- Provider Sessions, transcripts, processes, caches, telemetry, and runtime
  observations support execution and diagnosis; they do not replace durable
  Task facts.
- `schema.json` and `state.json`, if found, are historical evidence only.
  Current code never reads them as a compatibility authority or rebuilds
  `yui.db` from them.

## Admission

Ordinary commands open a Home only when all of these are true:

1. `yui.db` exists and its migration ledger is a valid immutable prefix.
2. The ledger head exactly matches the running CLI's current storage version.
3. Current record validation and reference integrity succeed.

An older Home inside the CLI's supported range fails ordinary admission but is
classified as upgradeable. `yui doctor` and `yui upgrade --dry-run` report the
ordered path without changing the Home. Explicit `yui upgrade` is the only
standalone mutation boundary: it quiesces the Controller, backs up `yui.db`,
applies all missing migrations transactionally, and validates the current
model. A newer, below-minimum, incomplete, or malformed Home fails closed.
There is no runtime normalization, repair worker, file-Store fallback, dual
read/write path, or second migration authority.

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

`yui update` stages an exact package and asks that staged binary to classify the
Home as current, migration-ready, or blocked. It then stops the exact
Controller, activates the same package, runs the staged release's complete
migration chain when required, verifies the installed binary and current Home,
and starts the replacement Controller.

Every persistent schema or payload change appends one immutable, contiguous
storage migration. The CLI publishes both `storageVersion` and
`minimumStorageVersion`; every valid Home in that inclusive range can upgrade
directly to the current version without installing intermediate releases.
Yui 0.15.0 / storage version 1 is the start of that range; pre-0.15.0 Homes are
preserved but are not migration inputs.
The target binary's `upgrade --update-preflight` and `--update-apply` result
shapes and parent-owned handover-lock proof remain backward compatible with
every updater released from storage version 1 onward, so an old source CLI can
still drive a much newer target's complete migration chain.
