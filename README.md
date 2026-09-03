<p align="right"><strong>English</strong> | <a href="./i18n/README.zh-CN.md">简体中文</a></p>

# Yui

Yui is a local control plane for intelligent Codex and Claude Agents. It keeps
user intent, Project knowledge, Tasks, handoffs, and results durable and
inspectable, while exposing small atomic capabilities for context, messaging,
delegation, workspaces, Sessions, review, and integration. Agents compose those
capabilities and decide how to plan, sequence, delegate, retry, and recover.

Yui deliberately does not turn Agent judgment into a deterministic workflow
engine. Its core owns durable identity, user authority, workspace isolation,
and atomic state changes. Provider Sessions and runtime observations support
execution and continuity, but they are not competing sources of Task truth.

The current implementation restores the useful Role/Agent/session and CLI framework without restoring the later data-maintenance, lease, schedule, and recovery-ledger systems.

## Requirements

- Node.js 20.17+, 22.9+, or 24.x
- Git
- tmux
- Codex CLI or Claude Code CLI

## Setup

```sh
npm install -g @zq-silk/yui
yui setup
yui doctor
```

`setup` is intentionally minimal. It verifies tmux, reuses or creates one
available Agent, creates the default workspace outside Yui home, and configures
both Operator and Leader so the user can start Yui and execute Tasks. It does
not create Worker, Reviewer, Profile, or review-policy configuration, and does
not ask for model/effort, permission, or shell completion. The required
Operator and Leader bindings use Yui's adapter default permission strategy
(`bypass`); further changes belong under `config role`. Running setup again
preserves already usable Operator and Leader Roles. A successful setup starts
the current Home's detached Controller before it returns.

All persistent configuration is under `yui config`. `config show` reports the
complete effective state, while `config --help` introduces each domain and
shows examples. The Operator can read the same structured catalog with
`config describe`, explain current values, effects, choices, and activation
behavior, then apply only changes the user confirms.

Durable settings are grouped by responsibility: `config system` for Home
defaults and presentation, `config runtime` for Controller health, concurrency,
launch, and delivery mechanics, `config workflow` for Leader/context/review
policy, `config resources` for quarantine and GC, and `config tools` for tmux
and diagnostic telemetry. Configured Agents, global Roles, Profiles, and shell
completion remain the sibling `config agent|role|profile|completion` domains.
Use `show`, `set`, and `clear` consistently within each durable-settings domain.

Runtime catalogs are refreshed per command and cached under Yui home. If a live probe times out or fails, Yui shows the last cache for the same Agent launch context and clearly marks it as potentially stale; without a matching cache, it offers CLI defaults and custom values. `yui config agent capabilities <id>` exposes the same one-pass catalog, including models, model-specific efforts, and other runtime choices such as permissions, search availability, profiles, settings sources, and service tiers.

`completion` is also interactive, with or without an explicit shell:

```sh
yui config completion
yui config completion zsh
```

Both forms confirm the generated script, installation path, and shell startup-file change. The installed completion is generated from the command catalog, including nested subcommands.

Yui uses `~/.yui` by default. Set `YUI_HOME` to use an isolated home:

```sh
export YUI_HOME=/absolute/path/to/yui-home
yui setup
```

The home contains `schema.json`, the authoritative SQLite database `yui.db`,
Project Catalog and knowledge, and Controller discovery files. Stable Project
checkouts and managed worktrees live under the configured workspace, outside
Yui home. Runtime storage accepts only the exact current contract; it never
falls back to `state.json`, normalizes an older shape, or repairs a historical
Home in place.

Every Task-owned record family allocates a monotonically increasing local ID
inside its Task. Different Tasks may therefore both contain `work-item-1`,
`turn-1`, or `input-1`. A managed Task session may use that short local ID
because `YUI_TASK_ID` supplies the scope. Outside a Task session, use the
qualified form `<task-id>/<local-id>`; Yui never searches every Task for a bare
ID. Commands that already take a Task explicitly, such as `task work create`
and `task integration start`, keep their subordinate IDs local to that Task.
Candidate IDs are local to their WorkItem and carry both Task and WorkItem
provenance.

Yui records layout, aggregate, and per-record-family versions in `schema.json`.
Runtime admission still has only two outcomes: exact current, or rejected; a
Controller never migrates storage while serving work. `yui upgrade --dry-run`
is read-only, while `yui upgrade` applies only the release's explicit adjacent
migration graph. Missing steps, newer layouts, and malformed Homes fail closed.

`yui update` stages and pins one exact package, runs that staged binary's
storage preflight, stops the exact old Controller, activates the same artifact,
applies any complete adjacent migration path, verifies the installed binary and
current Home, and starts the replacement Controller. If no complete path exists,
the update stops before activation and leaves both the Home and current
installation unchanged.

To retain an old Home, keep it byte-for-byte and open it only with its original
Yui version for read-only inspection. For unfinished work, initialize a new
Home and let the Operator create a new Task from the old Task's objective,
relevant WorkItems, current repository state, and available result summaries.
The Operator creates new identities; it does not import old runtime/session
state or pretend that the old Task continued.

See [Task-local identity](docs/task-local-identity.md) for the current reference
contract.

Schema work across Tasks is not serialized: any Task may advance a version axis
(`layout`, `aggregate`, or a `record` family) on its own isolated branch without
waiting for another Task's schema change to land. The later-integrating branch
owns the reconciliation — rebasing onto the latest project head, resolving schema
and code conflicts, re-advancing the schema versions and record-version-map
entries the rebase requires, rebuilding and re-validating the wiring, and
re-running the isolated E2E and docs. This is a deliberate scheduling trade-off
that avoids cross-Task blocking, not an accident to repair ad hoc. The
current manifest descriptor map is re-derived against the newest head, while the
post-baseline descriptor snapshot remains frozen. If another Task later lands a
record-schema change, the integrating branch must supply the complete adjacent
path (including an explicit `0->1` introduction for a new family) and re-test to
convergence.

Yui provides four reusable Worker Profile definitions through
`yui config profile reset`; minimum setup leaves them unconfigured:

```text
worker  explorer  implementer  reviewer
```

Profiles are versioned, provider-neutral Worker behavior templates. They hold portable prompt instructions, Skills, access expectations, and optional model and effort selections, but do not bind an Agent or own a Session or workspace. A Task Role is the Task-bound Worker instance: applying a Yui Agent Profile copies the behavior plus model/effort into that Role's active Agent binding; explicit Role options may override the copied values. This is separate from a Codex native config profile selected with `--profile`.

## Quick start

Bind a Project and create a Draft Task:

```sh
yui project add app /absolute/workspace/app \
  --remote git@example.com:team/app.git --stable main --development main
yui project update app --alias app-cli
yui project refresh app
yui project list

yui task create "Fix CSV escaping" --project app --type bugfix
yui task create "Ship CSV export" --project app --type feature
yui task update <task-id> --priority high --tags release,csv --due-at 2026-08-01T00:00:00Z
yui task update <task-id> --clear-priority --clear-tags --clear-due-at
yui task message update <task-id>/<message-id> --body-file updated-message.md --wake-policy none
yui task work edit <task-id>/<work-item-id> --objective "Revised outcome" \
  --accept "New observable criterion"
yui task work retire <task-id>/<work-item-id> --summary "Removed from the current Draft"
yui task show <task-id>
yui task context <task-id>
yui task activate <task-id>
```

A Draft stores planning state and Project bindings only; it does not adopt a
writable managed Workspace. `task activate` prepares every bound Project first,
then commits the Task's `active` status and Task-owned Workspace together. A
preparation or consistency failure leaves the Task Draft and reports the
workspace diagnosis instead of exposing a partially adopted execution root.
Draft Message and WorkItem edits replace only the named mutable fields while
preserving record identity and audit history. Repeated options replace the
whole collection; matching `--clear-*` flags make an empty collection explicit.
Retired records remain visible in history but leave the current Draft. A
retired WorkItem never satisfies a dependency and does not redirect downstream
dependencies through its optional replacement; fix the remaining Draft before
activation. These Draft-only mutations do not create, stop, or clean runtime
resources, and activation validates the current dependency graph, Roles, and
Project scope before any Workspace is adopted.

Task type describes intent rather than selecting an execution protocol.
Software Projects use `bugfix` or `feature`: a bugfix is Leader-owned; if it
grows into independently owned delivery requirements, reclassify it as a
feature before creating WorkItems. The Leader decides whether a feature is
small enough to deliver on Task main or large enough for independently owned WorkItems. A WorkItem is
one substantial requirement for one Worker, not a development step, test run,
review finding, or local fix. Multiple WorkItems are useful only when distinct
Workers can advance meaningful requirements independently. A WorkItem's
governing Candidate defines its delivery obligation: its current ChangeSets
must reach committed Integration or an explicit superseded queue disposition
before Task-final Review or completion. Older Candidate and ChangeSet records
remain audit evidence without keeping the Task open.

`project refresh` is the explicit network operation for a stable Project checkout. It fetches the
configured stable branch directly from the Project remote URL and advances only through a clean,
verified fast-forward. Refresh requires matching stable and development branches, treats untracked
files as dirty, preserves ignored files, and refuses missing remotes or refs and diverged checkouts.
When the configured branch is `HEAD`, refresh resolves the remote's symbolic default branch for that
operation and requires the checkout to be on that branch; detached or mismatched checkouts fail.

### Project lifecycle

Divergence and end-of-life are explicit, Operator-authority operations with fail-closed gates.
Every destructive command refuses a managed Task Session (run it from an Operator or user
terminal), an active Task binding, a dirty checkout, and an unreachable or unverified remote.

```sh
yui project diagnose app
yui project reset app
yui project reset app --discard-local
yui project replace app --discard-local
yui project retire app --reason "superseded by app-ng"
yui project delete app --confirm app
yui project delete app --checkout --confirm app
```

`project reset` handles the divergence `project refresh` refuses. Without `--discard-local` it is
a dry run: it fetches and verifies the remote baseline, and when the checkout has diverged it
refuses while listing the exact local commits that would be discarded. With `--discard-local` it
hard-resets the clean checkout to the verified remote commit (a plain fast-forward when the
checkout is merely behind). `project replace` goes further for Home-managed checkouts: it clones
the remote into a staging directory, verifies both branches, copies the Yui-local refs
(`refs/heads/yui/`, `refs/yui/archive/`) so historical evidence keeps resolving, then swaps the
checkout on disk while the catalog record keeps its path. Replace refuses linked worktrees (Task
or Integration workspaces) and dirty checkouts, and requires `--discard-local`. The swap is
recoverable: the previous checkout is parked at a backup path and restored on any failure, a
catalog refusal rolls the swap back, and a crash mid-swap is healed on the next run (a crash
before the swap leaves only a removable staging clone).

`project retire` is the auditable soft deprecation: it records who retired the Project, when, and
why, while retaining the catalog record, checkout, and every historical
Task/Turn/Review/Integration/Publication reference. A retired Project cannot be refreshed,
updated, migrated, reset, replaced, maintained through Knowledge writes (add/retire/propose/
accept/reject), or bound to new Tasks, WorkItems, or Integrations; Knowledge reads (`list`,
`show`, `proposals list/show`) stay open so the evidence stays auditable.
`project delete` is the separate hard-removal decision: it requires a retired Project, an exact
`--confirm <project-id>` acknowledgment, and fails closed while any Task record references the
Project. `--checkout` additionally removes the Home-managed checkout (external checkouts are
user-owned and must be removed manually): it first refuses linked worktrees and dirty checkouts,
then moves the checkout to a tombstone before removing the catalog record, restoring it on any
failure so the catalog and checkout never disagree unrecoverably. `project show` and
`project list` display the lifecycle status and retirement record.

Use `task context` as the first detailed read of an existing Task. It combines the Task, Brief, active Decisions, recent Milestones, Roles, current and recent WorkItems with their Turns, recent Messages, open and resolved InputRequests, and recent Events. Terminal output keeps histories and long text compact; `yui --json task context <task-id>` returns the complete records in the top-level `data` field.

Leader wakeups stay deliberately small: the wake envelope carries only the
aggregated wake reasons, a delta window, and read pointers. The durable wake
ledger is the on-demand read for what changed:

```sh
yui task wake list <task-id>
yui task wake show <task-id> <wake-id>
```

`wake list` shows the dispatch history with status, reasons, and consuming
Turn; `wake show` renders one wake's delta window — the Events, Messages, and
Turns recorded between its cursors. A human or Agent can still force a wake
with `yui task wake <task-id> --force --reason "<text>"`.

Human-facing timestamps default to Beijing time (`Asia/Shanghai`) while durable
records and `--json` data remain UTC/RFC 3339. Inspect or change the IANA
timezone with:

```sh
yui config show
yui config system set time-zone Europe/London
```

WorkItem review is one global, optional rule that reuses an existing Global
Role's Agent, model, permissions, prompt, and Skills:

```sh
yui config workflow set review --role reviewer --trigger always
yui config show
yui config workflow clear review
```

For Project-backed software delivery, use `--trigger final` to supply the
default Reviewer Role when the Leader decides the complete frozen Task result
needs an independent Review:

```sh
yui config workflow set review --role reviewer --trigger final
```

Every result entering Leader acceptance is one explicit candidate on its
existing WorkItem. The current global rule applies to the next candidate in
every existing or new Task; that candidate snapshots the rule, so later
`set`/`clear` changes do not rewrite an in-flight decision.
`always` starts a ReviewRound for every candidate, including a completed Role Turn
or a Leader-managed direct result; `leader` leaves the candidate awaiting
acceptance so the Leader can accept it directly or run
`yui task work review <task-id>/<work-item-id>`. A configured review rule therefore keeps
Leader-managed candidates awaiting a decision instead of marking them done.
`final` does not create WorkItem ReviewRounds or decide Task topology. The
Leader explicitly requests a Task-scoped Review, unless an immutable Task
contract requires one. The Round snapshots the exact Task-main Project heads
directly, so even a Leader-owned Task with no WorkItem can be reviewed without
locking the mutable Task workspace. A changed frozen head needs a new semantic
Round; the same Reviewer Session continues in its
stable workspace, while every Turn remains bound to its exact Round and head.
The Reviewer follows Project Policy/Knowledge and reports reachable, material,
actionable findings across the complete Task.
A ReviewRound freezes the Candidate's exact Git commit and updates the
Reviewer Role's stable writable workspace to that head while recording exact
Round-owned workspace evidence. Its Turn may edit,
test, and optionally commit diagnostic evidence there, but never changes the
Candidate or Worker workspace and never creates another WorkItem, Candidate,
ChangeSet, or recursive review. The result wakes the Leader, who decides whether
to route evidence to the original Worker, accept, reject and redispatch that
Worker in its existing Session, review again, or request user input.
A failed review remains visible evidence and wakes the Leader, but does not
take that decision away from the Leader.
Task context and next-action expose direct Review facts: every frozen Project
commit, its relation to the current candidate, the active Turn, and the Reviewer
workspace. A request that fails after Round creation retains the ReviewRound
and reports its exact reason; the Leader opens that Round and decides whether
to retry, inspect or clean the workspace, use another Reviewer, or continue
other work.
An active Task-final Review freezes only its own candidate; it does not prevent
the Leader from processing new input or advancing a later candidate. Delta
Recheck is always available when Yui can prove an accepted contiguous baseline
and exact diff. Yui does not select a mode from generic size thresholds;
`requires-full-review` returns to the Leader without creating another Round.
Candidate history, every ReviewRound, and the Leader decision remain grouped
under the original WorkItem. A rejected result creates a new Candidate on the
next dispatch while reusing the original execution Role, Session, and
workspace.

Yui Core supplies lifecycle and exact-scope safety; generic role Skills supply
portable collaboration behavior; Project Policy/Knowledge supplies
project-specific build, test, migration, release, and review rules; the Task
Contract supplies the current objective and acceptance. Project-backed Workers
commit and leave the Develop workspace clean before ending the Provider Turn.
Yui stores the final Turn result and freezes each writable Project's HEAD in the Candidate
snapshot; ReviewRound worktrees are recreated from those exact commits even if
Develop later advances during repair.

Task identity follows one bounded outcome, not the number of repositories
involved. A repository-backed Task may bind multiple Projects, each with its
own base ref. Yui exposes them under one Task workspace root:

```text
<workspace>/tasks/<task-id>/main/
├── backend/
├── frontend/
└── shared-sdk/
```

`<workspace>/tasks/<task-id>/main` is a logical multi-Project container, not a
Git repository. Each Project child is the supported Git cwd (for example
`<workspace>/tasks/<task-id>/main/yui`) and points to that Project's managed
worktree at `<workspace>/worktree/<project>/<task-id>/main`. Run Git commands
inside the relevant Project child. With one bound Project, the native Agent
starts in its managed worktree so Agent-native project configuration and Skills
are discovered normally. With multiple Projects, it starts at the logical root
and receives every Project worktree through the provider's native
additional-directory mechanism. Create all known
bindings together, or let the active Task Leader add one when the same outcome
expands:

```sh
yui task create "Update authentication" \
  --project backend --project frontend \
  --base backend=develop --base frontend=main \
  --type feature
yui task project add <task-id> shared-sdk --base main
```

Project-backed Tasks record the local baseline, redacted remote identity, and
the remote-tracking commit observed when their main workspace is created.
Inspect delivery freshness with:

```sh
yui task base status <task-id>
yui task base status <task-id> --refresh
```

The default check is offline and uses local remote-tracking refs. `--refresh`
is the explicit authorization to query the configured remote; Yui never
fetches, rebases, merges, or force-pushes as a hidden side effect of Task
completion. Behind, diverged, or unavailable remote state is reported as
delivery-risk evidence for the Leader; it does not replace the Leader's choice
of delivery base. A dirty Task workspace remains a completion blocker.

Implementation WorkItems declare the Projects they may modify. Their workspace
keeps the same relative layout, creates isolated worktrees only for that write
scope, and exposes the other Task Projects as context from Task main. Yui puts
the exact writable and context-only Project lists into the managed dispatch and
the `yui-worker` Skill requires the Agent to honor that boundary. Native Agent
permissions remain session-wide, while Profile `access` is a behavior hint,
not a provider sandbox or write grant. Every managed Role binding defaults to
`permission.strategy=bypass`, including `explorer`, so provider prompts do not
block normal work. Profiles and Skills constrain behavior; exact WorkItem or
ReviewRound scope and the matching managed workspace are the only authority to
modify Project files. A Role may instead choose `default` or `configured` and
retain any supported subset of the provider's native permission options.

Workspace ownership is independent from the executor Role. Yui persists one
owner-keyed `ManagedWorkspace` for Task main, each WorkItem Develop checkout,
each ReviewRound, and each IntegrationAttempt; dispatch attaches a snapshot.
The delivery chain is `isolate -> Candidate -> ReviewRound -> ChangeSet capture
-> Integration -> accept -> cleanup`. Review worktrees start at the frozen
Candidate commit and never become a Develop ChangeSet source.

Write scope may only expand. The Leader supplies the complete old-plus-new set
after a Worker reports that another repository is required; an
existing writable Project cannot be removed:

```sh
yui task work create <task-id> "Update contract" \
  --project backend --project frontend --role implementer
yui task work scope <task-id>/<work-item-id> \
  --project backend --project frontend --project shared-sdk
yui task work isolate <task-id>/<work-item-id>
yui task work reject <task-id>/<work-item-id> \
  --summary "Write scope expanded; continue in the refreshed workspace."
yui task work dispatch <task-id>/<work-item-id>
yui task work capture <task-id>/<work-item-id>
yui task integration start <task-id> --project backend \
  --change-set <backend-change-set-id> --check "<validation command>"
yui task integration cleanup <task-id>/<integration-id>
yui task work cleanup <task-id>/<work-item-id> --integrated
```

`capture` records one immutable ChangeSet per modified Project. Repeat capture
at the same HEAD reuses the record; a repaired HEAD produces a new candidate.
Integration remains a single-Project Git transaction, so the Leader integrates
each Project independently. Acceptance succeeds only after every modified
Project's latest candidate is integrated. Yui refuses integrated cleanup while
any result remains unintegrated. Use `--abandon` only for deliberate discard.
Dirty worktrees are retained. Native Agent Sessions may be scoped to their
launch directory, so Yui retires a stopped Role Session whenever the Role moves
between Task main and an isolated WorkItem worktree. The next dispatch starts a
Session in the new workspace while durable Yui records preserve context.

Submit information through Operator:

```sh
yui operator submit "Compare CSV and JSON compatibility" --task <task-id>
yui operator submit "Investigate a smaller cache design"
yui operator status
yui operator list
yui operator resume
yui operator resume --last
yui operator new
yui operator enter
```

If current execution cannot be settled normally, fence the Task and restart
from its durable progress:

```sh
yui task execution stop <task-id> --force --reason "<why execution must be fenced>"
yui task execution start <task-id>
```

`stop` terminates disposable Turns and Sessions while preserving WorkItems,
repository changes, Messages, reviews, and other Task progress. `start` admits
one new Leader attempt from those durable records; it does not recover an old
Agent conversation.

Without `--task`, `operator submit` creates a new Draft. Drafts accept planning changes but must be activated before Agent execution.
Operator resolves every request against the Project catalog and existing Task
context. Follow-up requirements, fixes, reviews, and questions for the same
bounded outcome stay in that Task even when they involve multiple Projects.
A distinct outcome, ownership boundary, or lifecycle creates a separate Task.
Features, bugs, and questions use the same
Task/WorkItem model rather than separate workflow types.
`operator status` shows exactly one GlobalRole-selected writer separately from
retained historical conversations. `operator list` shows recent conversations in fixed most-recently-updated order using
their Agent and readable title or preview; native provider session IDs remain
internal. Until an adapter supplies that metadata, Yui shows the provider plus
a stable short Yui reference so untitled conversations remain distinguishable.
`operator resume` opens the lightweight numbered history list, while `--last`
resumes the newest entry directly. Starting a conversation is never a resume
choice: the explicit `operator new` command starts a clean conversation and
preserves the previous one in history.

Create a Task-bound Worker instance from the configured global Worker, apply a
Profile, and dispatch a WorkItem:

```sh
yui config role show worker
yui task role add <task-id> implementer --profile implementer
yui task role show <task-id> implementer

yui task work create <task-id> "Implement the exporter" \
  --project app --role implementer
yui task work isolate <task-id>/<work-item-id>
yui task work dispatch <task-id>/<work-item-id> --input "Implement and run focused tests"
```

Without `--lane-role`, the assignee performs the WorkItem directly in its main
workspace. To request independent production attempts over exactly the same
frozen Assignment, provide at least two distinct Task Roles; one role is
rejected, roles cannot repeat, and the assignee cannot be a Lane:

```sh
yui task work dispatch <task-id>/<work-item-id> \
  --input "Implement and run focused tests" \
  --lane-role producer-a --lane-role producer-b
```

Each Lane is a recoverable logical slot. A successful Lane points to its
immutable Producer Turn result; a failed Turn leaves the Lane open and visible
as `needs-attention`. The Leader retries or explicitly settles that exact Turn:

```sh
yui task turn retry <task-id>/<failed-turn-id>
yui task turn settle <task-id>/<failed-turn-id>
```

Yui waits until every Lane is settled. At least two successful Producer results
create one idempotent main Turn for the WorkItem assignee; fewer results fail
the WorkItem attempt without falling back to a single result. A main Turn retry
keeps the same source Group and never reruns successful Lanes. Only a successful
main Turn can become the Candidate used by Review and Integration. `task work
show`, `task work list`, Task context, and the Web control room derive execution
shape, recovery targets, synthesis eligibility, main Turn, Candidate provenance,
next action, and owner from the same persisted facts. Missing facts stay
`unknown` or `unobserved`; token, duration, and tool-call totals are display-only.

Permission is one adapter-specific enum configuration on each Agent binding:
`default` follows the provider, `bypass` compiles the provider's supported
bypass flag, and `configured` retains whichever native options are explicitly
set. Codex options are `sandbox` and `approval`; Claude options are `mode`,
`allowedTools`, and `disallowedTools`. Provider permission is independent from
Profile behavior and Project write authority: only an exact WorkItem scope and
matching managed workspace grant normal Project writes. A ReviewRound is the only non-WorkItem write
purpose and must match its Turn, reviewRoundId, frozen base, and
ReviewRound-owned workspace; every mismatch fails closed. Its diagnostic commit
is visible history but is
explicitly rejected by capture, ChangeSet, Integration, and acceptance paths.
The Reviewer's final Provider response is its complete free-form Markdown or
JSON report. If a JSON report
includes known `checks` or `evidenceCommit` fields, Yui records them as
structured evidence and verifies the reported commit against the managed
Review branch HEAD; unknown fields remain part of the report. Dirty uncommitted
diagnosis may end without a commit; the worktree is retained and cleanup
refuses it until it is clean.

Every Role desired launch change increments its revision and applies only to a
future launch. Each Turn and native Role Session stores the complete actual
agent, adapter, model, effort, Profile access intent, exact writable Projects,
permission strategy and native options, workspace, context, and source desired revision. Updating,
switching, or clearing Role overrides never
hot-mutates an existing process. `task context`, Role views, Turn history,
Events, and Web show desired/effective revisions, Profile intent, permission, and
pending next-launch drift.

Both Codex and Claude deliver a managed Turn through the Provider's native Turn
terminal. Yui stores the final assistant response as the exact Turn result,
submits the WorkItem for Leader review, and queues the Leader. It does not
accept the WorkItem. A Leader never wakes itself; any pending Operator or Worker
wake remains durable until the Leader is idle.

If the outcome cannot be determined, label the handoff `uncertain`,
`incomplete`, `blocked`, or `requiring Leader judgment` and submit the most
complete truthful identities, actions, repository state, checks and errors,
lifecycle boundary, unfinished work, open decisions, risks, confidence, and
bounded next options. The Turn result is immutable execution evidence only; it
does not imply acceptance, WorkItem completion, ChangeSet capture,
Integration, or Task completion.

For one substantial feature requirement, the Leader may create a WorkItem and
give it to a native subagent or Task Role Worker. A small Task or bugfix stays
on Task main. Do not create a WorkItem merely to record implementation steps,
tests, review, or follow-up fixes:

```sh
yui task work create <task-id> "Implement the export API" \
  --objective "Deliver the independently acceptable export API requirement" \
  --accept "The API contract and focused validation are complete"
yui task work update <task-id>/<work-item-id> running
yui config profile show reviewer
```

Subagent creation and result delivery happen inside the Leader's native Agent
runtime; there is no Yui subagent launch command and Yui does not manage the
child Session. The Leader must select and read an explicit Worker Profile,
using `worker` when no specialist fits, and include its revision, instructions,
Skills, access expectations, validation, and supported model/effort hints in
the child brief. Agent bindings on Task Roles are ignored: the child inherits
the Leader Agent, credentials, and conversation context. The Leader reviews the
returned result and records the actual execution facts:

```sh
yui task work update <task-id>/<work-item-id> done \
  --summary "executor=subagent; profile=reviewer@3; model=inherited; round=1; result=reviewed; checks=npm test passed"
```

Use `inherited` or `unknown` when the native runtime does not expose an actual
model or effort; do not guess. The three supported paths remain deliberately
small: Leader direct execution, a conversation-native subagent, or a Task Role
Turn when work needs its own provider, credentials, interaction, or durable
Session.

For an isolated Task Role result, the Leader first reviews the stored Turn result.
An insufficient result is rejected with feedback and redispatched in the same
workspace. An acceptable result is captured and integrated in a candidate
worktree. Checks run there, and the target advances only if its recorded HEAD
still matches:

```sh
yui task integration start <task-id> \
  --change-set <change-set-id> \
  --check "npm test"
```

Integration state stores compact check outcomes and failure diagnoses. Full stdout and stderr are streamed without truncation to `YUI_HOME/artifacts/integration-checks/...`; `task integration show` exposes the relative log path, and `task integration cleanup` removes both the candidate worktree and those logs.

Code or semantic conflicts remain blocked until that Task's Leader records a decision:

```sh
yui task integration resolve <task-id>/<integration-id> \
  --option manual-resolution \
  --rationale "Preserve the public contract while combining both implementations"
yui task integration continue <task-id>/<integration-id>
```

Worker Turn completion is not WorkItem completion. The Leader accepts only after reviewing
the result, validations, and the latest ChangeSet integration:

```sh
yui task work accept <task-id>/<work-item-id> --summary "Acceptance criteria met."
```

Use `task work reject` to return an awaiting result for repair and redispatch,
and `task work retire <task>/<work> --summary "..."` to retire obsolete work,
optionally naming a replacement. WorkItem and Integration
worktrees and check logs remain available as evidence until explicit cleanup.

Incorrect historical directives and execution attempts can be removed from
operational projections without deleting their audit records:

```sh
yui task message retire <task>/<message> --reason "Superseded instruction"
yui task turn retire <task>/<turn> --reason "Invalid launch record"
```

These commands append a retirement fact. Lists and audit views retain the
original Message, WorkItem, or Turn and mark it retired; managed Turn context,
actionability, recovery, review evidence, and scheduling ignore it. Retiring
an active Turn first terminalizes that exact Turn, and retirement is
idempotent. Only the user or global Operator may retire Messages or Turns;
WorkItems may also be retired by their Task Leader.

For long-running Tasks, the Leader keeps Yui—not a native transcript—as the
recovery authority. The Task Brief owns the overall technical approach,
including how coordinated Project changes fit together. WorkItems own the
executable per-Project modifications and acceptance checks. The Leader updates
Brief focus and Leader summary before ending each Provider Turn, records material choices as
Decisions, adds phase outcomes as Milestones, and promotes only cross-Task
stable facts to Project Knowledge.

When an active Leader Turn cannot continue without a user decision, it creates a durable InputRequest and ends its Provider Turn with a truthful blocked result:

```sh
yui task input request <task-id> --question "Which format should be the default?" \
  --choice csv="CSV" --choice json="JSON" --blocks work-item:<work-item-id>
yui task input list
yui task input show <task-id>/<input-id>
yui task input answer <task-id>/<input-id> --choice csv
```

Requests are user-required by default and remain open until answered or cancelled. When the Agent has a safe recommendation, it may attach a choice fallback and explicit timeout:

```sh
yui task input request <task-id> --question "Which format should be the default?" \
  --choice csv="CSV" --choice json="JSON" \
  --recommend csv --timeout-seconds 300
```

The recommendation is shown to the user. If no answer arrives, the nearest-deadline timer wakes the Controller to atomically apply that exact choice and queue the fixed Leader session to resume. Free-text and user-required requests never auto-resolve.

`task input list` is the authoritative global open-input Inbox; add a Task ID to scope it, or `--all` to include answered and cancelled requests. Task completion, retirement, Leader attention, stalls, and open input are queued to the global Operator mailbox only as immutable TaskEvent or InputRequest references. The Controller merges one pending mailbox batch into one receipt-backed `[Yui updates]` user message for an existing ready Operator; the Operator reads the referenced records through the CLI and decides what is worth presenting. A running or unavailable Operator is never started or interrupted: the whole batch remains durable and is retried after native turn completion or a later Controller pass. This path is a user message, not a tool call, and it never inspects or classifies Agent terminal text. Answers may be submitted by the user or Operator. An open request prevents unrelated pending wakes and Task completion or archival. The originating Leader may instead run `yui task input cancel <task-id> <input-id> --reason "..."`; cancellation queues that fixed Leader session to resume.

Inspect the result:

```sh
yui task context <task-id>
```

Use the narrower `task work`, `task message`, `task turn`, and Task Knowledge commands when you need one collection or record.

Record a Task's confirmed PR/MR delivery state with one idempotent command:

```sh
yui task publication upsert <task-id> --project <project> \
  --provider github --repository <owner/name> --kind pull-request --id <number> \
  --url <url> --state open --reported
```

The required provider/repository/external ID selects the current Publication.
The first upsert creates it. Later upserts inherit omitted metadata and, while
the local commit and PR/MR state remain unchanged, omitted merge evidence.
Changing the local commit without an explicit state resets the Publication to
`open` and `reported`; changing either the local commit or state clears omitted
remote commit, evidence, merge time, and verification so facts from an earlier
head or state cannot remain current. Each semantic change appends a new
immutable record linked to the previous version, while identical input creates
no event. `list`, `show`, and `task context` retain the complete history. This
records facts already known to the caller; it does not query a provider or
replace Review, Integration, or Task completion gates.

Verify one current GitHub Publication against the real PR state:

```sh
yui task publication verify <task-id>/<publication-id>
```

Verification is an explicit external read. The first implementation invokes a
trusted, PATH-pinned local `gh` executable and reuses its authentication; Yui
does not store a GitHub token. The command requires the current unsuperseded
Publication to record the exact Task delivery head, then requires GitHub to
report the same PR head as merged and to return a remote merge commit. It
rechecks the Task head and Publication after the remote call before appending a
new immutable `verified` record. Missing `gh`, unavailable authentication,
ambiguous provider output, open/closed PRs, moved heads, and concurrent local
changes fail without recording verification. GitLab verification is not
implemented in this first version.

Query whether every delivered Project head is represented by a current merged
Publication:

```sh
yui task remote-delivery <task-id>
yui task remote-delivery <task-id> --json
```

This is a read-only derived projection, not a Task status or writable `merged`
flag. Active and reopened Tasks use the current clean Task-main heads and mark
them provisional; completed and archived Tasks use the latest frozen
`task.completed` heads. For each Project, Yui reports the expected local
commit, the matching current unsuperseded Publication, PR/MR state,
verification, and remote commit. Aggregate coverage is `none`, `pending`,
`partial`, or `merged`, with independent `allMerged` and `allVerified` values.
Only a current Publication whose `localCommit` exactly matches the expected
head and whose state is `merged` contributes merged coverage. Missing commits,
open/closed records, stale heads, and superseded Publications never imply
remote delivery. Projects whose Task head equals their managed base need no
Publication. `task show`, `task context`, `task next-action`, and the Web detail
projection use this same selector.
`Archive --integrated coverage` requires both `allMerged=true` and
`allVerified=true`.

When the requested outcome is finished, complete the Task to stop automatic Leader wakes without deleting its sessions or Task main worktree:

```sh
yui task complete <task-id> --summary "CSV export shipped and verified"
yui task complete <task-id> --summary-file delivery.txt --refresh-remote
yui task reopen <task-id>
```

When a verified squash-merge Publication records a remote commit that is
ancestry-divergent from the unchanged local Task head, a user or global Operator
may explicitly authorize completion against its identical Git tree:

```sh
yui task complete <task-id> --summary-file delivery.txt \
  --accept-published-tree <publication-id>
```

This is an independent exact-tree authorization. Yui requires the current,
unsuperseded Publication to be merged and verified, its local commit to equal
the physical Task head, its remote commit to be ancestry-divergent, and both
commits to resolve to the same exact tree. When a Task-final Review obligation
exists, completion also requires the latest semantic Round to attest the
accepted Task head; otherwise completion does not invent a ReviewRound.
`--refresh-remote` fetches
the remote object graph before resolving that Publication commit. For a Task
governed by a durable final-review contract, the stored contract continues to
require its Reviewer policy, but compatible CLI and Controller updates do not
need to reproduce its historical control-plane digest. Tasks without that
contract retain the one-step explicit completion path. The Task event
audit records the authorization and, on completion, the accepted Project,
Publication, optional ReviewRound, both commits, and tree.

Completed Tasks reject messages, dispatch, Provider authority changes, retry,
and late Turn delivery until explicitly reopened, while retaining Task main for
inspection or integration. Terminal WorkItem, Review, Integration, and Lane
worktrees are non-blocking completion advisories, but they must be settled
before archive. Every isolated WorkItem worktree is explicitly cleaned as
integrated or abandoned; that cleanup also removes its managed branch. Archive
requires `--integrated` or `--abandon` to state the Task main outcome and is
allowed only after Task main is clean. `--integrated` additionally requires
remote-delivery `allMerged=true` and `allVerified=true`; Task completion or a
reported merge alone is never treated as verified remote delivery. When every
exact Task head is merged but one or more Publications remain `reported`, the
command identifies those Publications and refuses archive. An explicitly
authorized `task archive <task-id> --integrated --force` may override only that
verification gap and records the override in the archive event; it never
bypasses missing, stale, open, or closed merge evidence. An intentional
non-merge uses the existing explicit `--abandon` path. Archive removes managed
worktrees but retains Task and WorkItem records. The Task main branch is
retained as a recovery artifact instead of being silently deleted.
Task lifecycle completion/selection only suggests valid source states: Draft for activate, active for complete, and completed for reopen.

## Sessions and tmux

Managed Task Agents use the [hybrid Provider runtime](docs/provider-runtime.md).
Provider conversations remain ordinary user conversations. Yui adds the Role
Skill and Session Manifest pointer, then sends Task work through provider-native
structured requests. Managed prompts are never delivered as terminal bytes.

Codex establishes the App Server WebSocket protocol through `app-server proxy`
to create or resume an ordinary thread on the shared native daemon. The thread
remains visible and directly usable in Desktop. Task execution stop terminates
Yui's Agent Host and proxy while leaving the daemon and thread untouched; start
creates a fresh proxy attachment.
If the proxy disconnects, the Host may attach a bounded replacement client and
reconcile the exact owned Turn from native history. A failed fresh attachment
is released instead of becoming a cleanup prerequisite for later Turns.
Claude Code keeps its independent stream-json process. Agent Host is the sole
writer to that process, so a completed stream write accepts the Turn; the
later provider `result` event settles it. An uncertain write becomes
`delivery-unknown` and is never automatically retried.

Task Role observation and takeover are explicit:

```sh
yui task role view <task-id> <role>
yui task role takeover <task-id> <role>
yui task role release <task-id> <role>
```

For an independently hosted Provider such as Claude, these commands are the
supported human-control boundary. A Codex Role uses an ordinary shared thread
and may be operated directly in Desktop; an active Desktop Turn creates bounded
backpressure for Yui rather than a failed Turn.

Turn is the only durable Role scheduling state. Conversation state does not
carry a second current-Turn pointer. A Yui-dispatched Provider Turn carries the
durable Turn id that correlates its visible input and terminal result; a direct
Provider Turn is recorded as direct conversation history without entering the
scheduling pointer. A native Turn terminal completes that Turn, after which Yui
may claim the next Turn and submit it through the same Session.
TaskRole itself stores identity and desired launch configuration, not runtime
status; Role status shown by CLI/Web is derived from the active Turn plus
Session/Driver lifecycle facts.

Global Operator and global Role sessions remain native interactive CLIs. Codex
connects that TUI to the default shared App Server, so the same thread can move
between Yui and Desktop without transferring a rollout writer or losing its
Global Context entry:

```sh
yui session enter <global-role>
```

`yui update` accepts the current Home contract or a complete centralized
migration path. Unsupported older Homes remain untouched; inspect those with a
compatible Yui version and let the current Operator recreate unfinished intent
as new Tasks in a newly initialized Home.

tmux fixes a pane's history capacity when that pane is created. Existing panes
retain their configured capacity; managed runtime output remains observable in
the Agent Host pane without becoming lifecycle or acknowledgement evidence.

Each Role, including Operator and a Task-bound Worker instance, can bind multiple
configured Agents, has one active Agent, and keeps a separate native session per
Agent binding. Multiple bindings may use the same adapter for different accounts,
models, profiles, or environment sources. They are ready-to-switch configurations,
not parallel writers: the active binding remains the unique authority. Operator can
keep multiple conversations for each binding. `operator new` and
`operator resume` reuse the single Operator tmux pane: when a process is
running, Yui asks before stopping it and switching the conversation. On a
cross-Agent switch, the saved model and effort are reused unless the user
explicitly chooses to update them.

The Role's active binding is desired state for the next compatible launch. A
running Turn and its native Session continue under their immutable
effective snapshot even if the Role is edited or switched. Resume is allowed
only when the complete effective snapshot and workspace remain compatible;
otherwise Yui starts a new Session after the old process has stopped and keeps
the terminal Session's immutable effective snapshot in history. Managed
Sessions invoke the ordinary `yui` command; their Manifest and durable
Role/Turn fences authenticate scope while protocol and storage compatibility
allow a CLI package or Controller upgrade in place. Exact internal callbacks
remain fenced to their originating runtime snapshot.

Use `yui config role unbind <global-role> <agent-id>` or `yui task role unbind <task-id> <role> <agent-id>` to retire a dormant binding. The active binding and any non-stopped native session are rejected; a stopped session record is removed atomically with the binding.

Claude session IDs are preallocated at launch. Codex discovers its native
thread identity from App Server responses. Managed Task Turns use structured
Provider observations for both CLIs. Global interactive Codex sessions may
still use its `notify` callback for conversation presentation.

Automated lifecycle and delivery decisions use structured Provider events or
supported Hook payloads, persisted identities, usage snapshots, tmux process state, receipts, and pane
fences. Yui never
parses prompt glyphs, progress text, trust dialogs, or other Agent terminal
output to infer readiness or success. `captureRole()` remains an explicit
human-facing transcript read and has no lifecycle authority.

The [AgentRuntime Driver architecture](docs/agent-runtime-drivers.md) keeps
native Codex/Claude event names at the edge. Core consumes exact-fenced
Session, Turn, operation, waiting, host, and activity observations. A positive
token delta is evidence of recent runtime activity; an unchanged counter is
not. A live tmux pane proves only that the host exists. Runtime activity and
durable workflow progress use independent clocks, so token/tool/resource
movement cannot conceal a workflow that is not advancing.

Stable Role context never creates a separate bootstrap Turn. Task execution Turns use the generic Leader or Worker Skill, while review Turns use the generic Reviewer Skill based on durable Turn purpose rather than a configured Role name. The provider either carries the Skill through a safe additive native context channel or points to it from the ordinary Task delivery. These Yui-owned Role Skills define portable orchestration only. Project Skills remain ordinary versioned files in the Project and are discovered, selected, and loaded by the Agent through its native project mechanism; Yui does not scan, parse, copy, or inject them.

Managed Codex keeps the user's native developer instructions unchanged. The ordinary Task message includes a compact absolute Session Manifest pointer, and the manifest identifies the matching Yui-owned Role Skill for Codex to read on demand. Model, effort, permission, workspace, and shell settings are supplied to `thread/start` or `thread/resume` through the shared App Server daemon; a Codex native config profile is rejected because it cannot be isolated to one shared-daemon thread. The underlying Codex config file is never mutated. App Server notifications are the managed thread's lifecycle authority; Yui installs no managed Codex Hook and does not claim `notify`. Interactive Codex Sessions may still use Yui's structured `notify` callback, and Doctor reports any effective configuration conflict. `skills.config` is not misused because it only enables or disables already-discovered Skills. Claude receives the same Yui-owned Role Skill content from a private `0600` managed context file rather than a large or sensitive argv value; retries and resumes reuse the purpose-specific Role path. Non-Operator global Roles stay neutral and receive no Task orchestration Skill. Operator therefore opens at an empty native composer, so the user's text remains its first user message. Leader wakeups and Worker or Reviewer Turn assignments remain real mailbox-delivered work messages.

## Controller and failure handling

One background Controller runs per `YUI_HOME`:

```sh
yui controller status
yui controller status --all
yui controller status --all --verbose
yui controller cleanup
yui controller cleanup --all
yui controller stop
yui controller restart
```

`controller status` scans the current `YUI_HOME` without starting a Controller. It
shows a bounded summary of the current Controller, owned Agent sessions, residual
resources, and live anomalies. `--all` also discovers other same-user Yui homes
from running processes; `--verbose` expands the resource details. `--json`
returns the complete typed snapshot even when the human view is abbreviated.

`controller cleanup` is interactive and never selects active Task or Role
resources. It separates safe and review-required candidates, confirms live
process cleanup explicitly, and revalidates process, tmux pane, and socket
identity immediately before acting. Partial failures are reported without
hiding the resources that remain. Use `--all` to include discovered Yui homes.

`controller restart` replaces the Controller process and its scheduler/socket services with the currently installed Yui version. It can recover a lost discovery record only when the old process still matches the current UID, Controller entrypoint, physical Home, PID, and process-start identity. It does not stop or restart managed tmux/Agent sessions.

Successful `setup`, `upgrade`, and `update` commands ensure that the current
Home has a running Controller, starting one when the Home was previously idle.
Read-only commands and `upgrade --dry-run` do not start a Controller. `update`
also replaces an already-running Controller only after the new binary passes its
health checks.

Its recovery reconciliation runs every 120 seconds by default. Normal durable state changes enqueue a Task, Role, or Operator key and return immediately; keys received in the same fixed 100 ms window trigger one non-overlapping targeted pass. Operator presentation has an independent lane, so a blocked Task workspace operation cannot delay a user question. Periodic Git/worktree work is limited to Tasks with durable Task-mailbox work, while active Role liveness uses one tmux inventory. Structured Agent Driver observations, whether received from native provider events or supported Hooks, are exact-fenced before they reach the durable runtime inbox. A terminal Turn observation atomically records the exact Turn result. Durable mailboxes freeze the current batch while new signals merge into the next batch. Task-orchestration failures retain the exact Controller-owned processing batch for two bounded fast retries and later periodic recovery; a successful retry completes that batch before newer pending work is claimed. Recommended InputRequest and pending Turn deadlines share one nearest-deadline selector and therefore do not wait for the recovery interval. Explicit `task reconcile` still requests an immediate recovery pass. The retained loop is:

1. dispatch pending Leader wakes whose Task workspaces are already ready;
2. prepare active Project Task main worktrees with durable orchestration work;
3. deliver queued Worker Turns;
4. resolve due Turn completions and reconcile Role liveness;
5. dispatch Leader work created or unblocked by the later recovery phases.

Automated input is sent only through tmux. Each pass performs one non-blocking process-state readiness check; a busy startup is retried through a small bounded mailbox timer, while later busy sessions are woken by canonical Agent Driver terminal observations. A pane-local receipt prevents the same Turn input from being typed twice after a Controller retry.

If a Role process exits without a terminal Provider result, the Controller fails that Turn and queues the Leader. A replicated WorkItem Lane remains open for exact retry or explicit settlement; completed sibling results remain reusable. Recovery failures are exposed through the small Jobs view:

```sh
yui jobs list
yui jobs retry leader-recovery:<task-id>
yui task reconcile <task-id>
yui task turn retry <failed-turn-id>
yui task turn settle <failed-turn-id>
```

`jobs` is not a restored generic queue: it presents durable pending Leader wakes and Leader recovery failures only.

`task turn settle` records that the Leader will no longer recover the exact
current failed WorkItem Lane Turn. Only then does the Lane become failed and the
settled Group become eligible for synthesis when at least two Producer results
succeeded. The same command retains its narrow repair for an obsolete failed
Reviewer Turn whose Task-final ReviewRound is stranded on an old frozen
candidate; that repair never creates a retry Round.

Completion is the reversible execution fence. Archiving is terminal and is accepted only after active work is settled: it stops the Task's tmux session and removes clean managed worktrees. Dirty worktrees keep the Task completed and are preserved for deliberate resolution.

## Local web control room

Run the local control room on the default loopback address:

```sh
yui web
# Yui web control room: http://127.0.0.1:4173
```

Use `--port <port>` or `--host 127.0.0.1|::1|localhost` to change the
listener. Yui rejects non-loopback hosts because the control room exposes Task
metadata, Briefs, Roles, WorkItems, Turns, messages, Decisions, Milestones, and
InputRequests. A random token embedded in the served page protects its write
and terminal endpoints.

The Web surface can answer an open InputRequest through the same durable CLI
mutation used by Terminal users. It can also attach to the existing Operator,
Leader, or Worker tmux pane through a native xterm client. Closing the browser
terminal detaches only that tmux client; the Agent process and conversation
continue running in tmux. The Web surface does not duplicate transcripts or
maintain another session state.

The dashboard opens on an overview cockpit: four operational metrics (active
tasks, open inputs waiting on you, completed tasks, and the total), a
cross-task attention inbox that surfaces every open InputRequest with its
question and urgency so you can answer without drilling in, and the list of
currently active tasks. Each task row carries a derived execution status
(progressing, needs attention, blocked, recovering) so stalled or failed
work is visible before you open a task. Selecting a task opens an anchored
detail view (Summary, Focus, Work items, Turns, Roles, History, Messages)
with a sticky tab bar that tracks the visible section. The Summary tab leads
with an execution band that consolidates the Task's owner, current action,
attention list, blockers, and fail-closed indicators; Work items surface
their current ExecutionGroup with per-lane status, Candidates, and
retirement disposition; Turns show purpose, execution lineage, final result,
and Leader disposition.

The control room supports English and Simplified Chinese, selecting an initial locale from the browser and remembering manual changes. The theme selector switches between the dark Control Room, the light Paper Ledger, and the dark-blue Atlas themes. Both choices are stored only in browser `localStorage`; they do not modify `YUI_HOME`.

## Management commands

The restored management surface includes:

```sh
yui update
yui upgrade [--dry-run]
yui config agent add|list|show|capabilities|update|remove
yui config role add|list|show|update|remove|bind|unbind
yui config profile add|list|show|update|remove|reset
yui config completion [bash|zsh|fish]
yui session enter|record|replace|reconcile
yui session stop --all
yui project add|clone|refresh|update|discover|list|show|knowledge
yui project reset|replace|retire|delete
```

`yui update` stages the newly published package side by side and asks that exact
binary to verify either a current Home or a complete adjacent migration path.
Only then does it stop the exact old Controller, activate the same concrete
package version, apply that path, validate the actually installed binary and
Home, and start the replacement Controller. Unsupported Homes block preflight
and remain untouched.

`yui upgrade --dry-run` reports the exact adjacent steps without writing.
`yui upgrade` applies those steps transactionally to SQLite record payloads and
then advances the atomic manifest; rerunning completes an interrupted manifest
advance without inventing repair behavior.

Agent environment bindings store process-environment variable names, never secret values. Adapter-owned lifecycle arguments cannot be overridden through raw arguments.

## Scope

Yui targets one trusted local user on one machine. Its Web/API surface is
loopback-only and intentionally omits remote or multi-user Web access,
distributed coordination, backup/import/export commands, trash/restore,
derived indexes, recovery journals, runtime leases, inactivity TTLs,
cooldowns, and recurring schedules.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for persistence and scheduling details.
## Development

```sh
npm ci
npm test
```

The permanent suite is intentionally one seconds-scale core smoke. It checks
CLI startup, a normal SQLite Task path, the supported migration graph, and the
built-in Agent Drivers. Change-specific TDD fixtures and abnormal-data repros
are temporary development evidence and are removed when the change is complete;
they do not accumulate as permanent regression tests. See
[the verification policy](./docs/testing/verification-levels.md).

To make user terminals use this checkout, reversibly link the user-level `yui` command:

```sh
make link
command -v yui
yui doctor
```

The first `make link` saves the original `yui` entry in the same user-level bin directory and replaces it with a managed symlink to this checkout. A later `make link` from another checkout only moves that managed symlink; the last checkout wins and development links never form a backup chain. Run `make link` and `make unlink` serially—do not invoke them concurrently from multiple environments or checkouts. The launcher defaults `YUI_HOME` to the active checkout's `output/dev/home`; an explicit `YUI_HOME` remains authoritative. Managed Agent launches do not depend on this global link: the Controller prepends a private launcher for its own Yui CLI and `YUI_HOME`. Run `yui controller restart` if an already-running Controller must load the new build. `make unlink` from any checkout using this implementation verifies the shared managed state and restores the one original `yui` entry.

```sh
make unlink
```

To run this checkout in isolation without changing the global `yui`, build only
its local launcher instead of linking:

```sh
make install-local
./output/dev/bin/yui doctor
```

`make install-local` writes a self-contained launcher at `output/dev/bin/yui`
and never touches the user-level `yui` command. The launcher resolves its own
checkout and defaults `YUI_HOME` to this checkout's `output/dev/home`. The
Controller socket is derived from that Home's durable `homeId` at the fixed
Linux path `/tmp/yui-<uid>/<homeId>.sock`; discovery also binds the physical
Home directory, so caller `TMPDIR`, path aliases, and copied runtime records
cannot redirect control requests. The tmux server namespace and state remain
scoped to the selected Home, so the checkout stays separate from other
checkouts and the global install.
It is idempotent, so re-run it after pulling new code (then run
`./output/dev/bin/yui controller restart` if a Controller is already running).
Call the launcher by its absolute path for a stable per-checkout entry point;
exporting `output/dev/bin` onto `PATH` is a per-shell convenience only.

`make install-local` builds `dist/` and writes exactly one file—the launcher
itself. It does not modify `PATH` and does not create the data home, so run
`./output/dev/bin/yui setup` once before commands that need state. Because a
bare `yui` is resolved through `PATH` and not by the current directory, working
inside this checkout does not make a bare `yui` use the local launcher; it still
runs whatever `PATH` finds. Select this instance with the absolute launcher
path, or, for one interactive shell only, prepend it to `PATH`:

```sh
export PATH="$PWD/output/dev/bin:$PATH"   # this shell only; not for automation
```

This is the recommended entry point for agents and scripts: run
`make install-local` once, then call `<checkout>/output/dev/bin/yui ...` by
absolute path from any working directory. Avoid relying on `export` persisting,
since each command runs in a fresh process.

## License

[MIT](./LICENSE)
