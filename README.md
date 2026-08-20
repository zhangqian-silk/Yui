<p align="right"><strong>English</strong> | <a href="./i18n/README.zh-CN.md">简体中文</a></p>

# Yui

Yui is a local control plane for durable Codex and Claude work. It keeps control state and Project knowledge in inspectable JSON, lets tmux own native Agent terminals, and combines reusable Worker Profiles, Leader-owned delegation, explicit acceptance, and isolated Git worktrees for Project-backed Tasks.

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

`setup` is interactive. It detects installed Agent CLIs, asks which Agents to configure, selects the default and Operator Agent, and probes each selected CLI for its current models. It configures the Leader and Operator, then explains that the global Worker configuration is copied into new Task Roles and asks whether Worker should reuse Leader or be configured separately. Model selection is followed by that model's supported reasoning efforts. Setup also confirms the Project workspace outside Yui home and offers shell-completion setup. The picker includes the native CLI default and a custom-value option. Running setup again preserves existing Tasks, Roles, and the installation's Project workspace while allowing safe configuration changes.

Model and effort are per-Agent Role settings, so Operator, Leader, and the global Worker can use different values even when they share an Agent CLI. Interactive Role flows validate those settings against the selected Agent runtime. Worker Profile model and effort fields are provider-neutral child-execution hints and therefore remain explicit, scriptable values rather than Agent capability selections.

Setup gives every managed Agent binding the explicit `bypass` permission
strategy. Later Role updates may select `default`, `bypass`, or `configured`;
the last choice exposes that adapter's native permission enums and tool rules.

Runtime catalogs are refreshed per command and cached under Yui home. If a live probe times out or fails, Yui shows the last cache for the same Agent launch context and clearly marks it as potentially stale; without a matching cache, it offers CLI defaults and custom values. `yui agent capabilities <id>` exposes the same one-pass catalog, including models, model-specific efforts, and other runtime choices such as permissions, search availability, profiles, settings sources, and service tiers.

`completion` is also interactive, with or without an explicit shell:

```sh
yui completion
yui completion zsh
```

Both forms confirm the generated script, installation path, and shell startup-file change. The installed completion is generated from the command catalog, including nested subcommands.

Yui uses `~/.yui` by default. Set `YUI_HOME` to use an isolated home:

```sh
export YUI_HOME=/absolute/path/to/yui-home
yui setup
```

The home contains `schema.json`, the authoritative `state.json`, Project Catalog and knowledge, and Controller discovery files. Stable Project checkouts and managed worktrees live under the configured workspace, outside Yui home. Runtime storage is strict and its writer is current-only. A specifically declared, record-only older shape may be normalized into the current domain model in memory; Yui never dual-writes formats, preserves unknown old fields, or guesses an old identifier.

Every Task-owned record family allocates a monotonically increasing local ID
inside its Task. Different Tasks may therefore both contain `work-item-1`,
`agent-run-1`, or `input-1`. A managed Task session may use that short local ID
because `YUI_TASK_ID` supplies the scope. Outside a Task session, use the
qualified form `<task-id>/<local-id>`; Yui never searches every Task for a bare
ID. Commands that already take a Task explicitly, such as `task work create`
and `task integration start`, keep their subordinate IDs local to that Task.
Candidate IDs are local to their WorkItem and carry both Task and WorkItem
provenance.

Yui models three independent, monotonic storage version axes: the on-disk
`layout` (`schema.json`, `state.json`, locks), the authoritative `aggregate`
document, and the `record` axis — a `recordKind -> version` map where every
record family (WorkItem, AgentRun, ReviewRound, …) versions on its own. A
centralized compatibility framework (registry → planner → loader/engine)
covers all three. Every adjacent version transition must be declared explicitly:
a `compatible` declaration is permitted only for one record family and must
provide deterministic defaults, a strict validator for the exact old shape, and
a fresh-object normalizer into the current model; an `offline-migration`
declaration owns layout, aggregate, identity/reference, record-split, and other
semantic changes and must also have an executable migration step. A transform
without a declaration, a declaration without its required step, a future version,
or structural damage fails closed. Multi-hop is compatible only when every hop
is compatible; one offline hop selects the complete offline path. The production
registry contains the explicit aggregate `16→17` offline transition; no
historical record-family normalization is implicitly authorized. A frozen
post-baseline descriptor snapshot (versions and locators) is checked against the
current descriptor map through the same planner, so a version bump, locator
drift, or new target family cannot ship without its complete declared path.

The record axis is genuinely independent: `schema.json#/recordVersions` is the
durable per-family source of truth and raw `state.json` is structurally
cross-checked against it before the strict current loader. A target family that
the persisted manifest does not yet name is explicit version `0`; it is usable
only through a declared record-family `0->1` introduction. Absence of records in
`state.json` never promotes that family to current by itself.
`yui doctor`, staged `yui update` preflight, and `yui upgrade` therefore share
four product states:

- **current** (`USABLE`) — every axis is current.
- **compatible-old** (`COMPATIBLE`) — every older hop is an explicitly declared
  record-only normalization; ordinary commands load the current domain model and
  the first write emits current records plus the matching current manifest only.
- **migration-required** (`MIGRATABLE`) — at least one declared offline hop has
  a complete deterministic step path.
- **unsupported** (`NEEDS_NEW_VERSION` or `CORRUPTED`) — a future version,
  missing declaration/step, invalid old shape, or real structural/reference
  damage. The result names the incompatible component and reason.

`yui update` stages and pins the new package side by side, then lets that exact
artifact run an internal path-specific read-only preflight against the target
Home: classification for current, strict compatible-source/current-model
validation for compatible-old, and classification plus authoritative offline
inventory for migration-required. This is deliberately distinct from user-facing
`upgrade --dry-run`: it creates no migration target or staged Home and claims no
staged-output validation, so it remains usable while the exact old Controller is
running. Current and compatible-old Homes
take the fast path: Yui captures and stops the exact old Controller, promotes the
same staged artifact, authenticates and starts the replacement Controller, and
post-verifies through the compatible loader. It does not copy, back up, rename,
or replay the Home and does not wait for Provider Sessions. Existing managed
Task Sessions keep their frozen exact executable/CLI path, Home, control digest,
Task/Run/launch/native-Session fence; replacement never retargets them through
PATH. At that managed continuity gate, package-version drift alone is accepted
because the same path now runs the activated CLI, while protocol, layout,
aggregate, path, Home, digest, and runtime-identity drift still fail closed. The
existing Session can therefore record progress and yield through the replacement
Controller without weakening the offline path's zero-Session requirement.
The first successful new write is the downgrade boundary because it is current-only.

Migration-required Homes take the offline path. Before binary activation,
Controller stop, admission fence, staging, or Home mutation, Yui re-reads an
authoritative inventory and blocks on active or in-flight Runs, live or unknown
native Sessions, pending turn completion, lifecycle mailboxes, or durable inbox
events. Stopped/history-only Sessions, a Role with no native process, and an open
Input by itself do not block. A blocker reports the total and exact available
Task/Role/Run/native-session/launch identities and reason, leaves the scene
unchanged, and tells the user to re-run `yui update` after the listed work clears;
it never kills, resets, rebinds, retries, or drains on the user's behalf.

Only that user re-run may enter the existing full migration. Once its preflight
is clear, the update parent captures and stops the exact old Controller PID. The
staged activation then runs the full migration: it places an admission fence (new
writers, CLI and Controller alike, refuse to start), waits for any writer already
admitted through `.state.lock`, and rechecks the offline inventory before staging,
validation, and switch. It then enters one shared sibling coordination boundary.
Inside it, both the runtime-lifecycle mailboxes AND the durable runtime inbox (`runtime/inbox/*`) are
checked (either non-empty blocks at `drain-incomplete`, so authoritative
not-yet-applied events are never dropped by a switch), followed by the revision
pin, complete-home copy, validation, and two-step switch.
The boundary is `<home>.upgrade-coordination.lock`, outside the Home so renames
cannot move a live lock. Inbox `publish` takes that same lock, checks the fence
and any unresolved switch-progress marker while holding it, writes the temp/link/
fsync event, and releases it. Upgrade takes the lock after the Controller drain,
proves both runtime lanes, re-pins the revision under `.state.lock`, copies the
complete Home, and keeps the coordination lock through `home -> backup` and
`staging -> home`. Thus a hook admitted before the fence either finishes before
the final snapshot (and its event is copied) or waits and receives an explicit
`UpgradeFenceError` after cutover; it can safely re-deliver and is never silently
stranded only in the backup. With no fence, the normal hook path keeps the same
durable behavior, only serialized at this boundary. **Fence acquisition is a
single atomic file create**, so two concurrent upgraders never both acquire —
exactly one wins and the other fails closed. A provably-dead owner's stale fence
is reclaimed, but the reclaim is an **atomic compare-and-delete** (it removes only
the exact stale bytes, under a lock), so a fresh live fence a racer created in the
meantime is never clobbered — two entrants can never both end up "acquired". That
reclaim lock is itself **crash-recoverable** (owner-pid + age reclaim), so a
holder that crashes mid-reclaim cannot orphan it and permanently block admission;
when a reclaim cannot be proven complete the writer fails closed rather than
falsely reporting the home writable. The coordination lock uses the same bounded
crash-recovery rule: it records an owner PID, waits only for a bounded interval,
and atomically renames aside a lock whose owner is provably dead (or whose
owner-less directory is older than the conservative acquisition window). A live
or undeterminable holder fails closed, so a crash cannot deadlock the Home and a
live writer is never evicted by a TTL. A switch-progress marker blocks hook
admission when the Home is missing or uninitialized (including a malformed
marker, because its recovery phase is unknowable); a stale marker beside an
intact Home is ignored just as the update probe ignores it after corroborating
the filesystem. The lock order is one-way — coordination
lock, then `.state.lock`; inbox writers never acquire `.state.lock` — so no
coordination cycle is introduced. An **uninitialized home** (never `yui setup`)
returns a structured "run `yui setup`" blocker rather than a silent no-op. Quiesce
**fails closed on any undeterminable signal**: a `.state.lock` that exists but
whose owner is missing/empty/non-integer/unreadable (a writer may be
mid-acquisition), or a malformed `runtime/controller.json`, is treated as an
active runtime and blocks the upgrade; only a provably-absent lock or a
clearly-dead owner is safe to proceed past.

The migration only transforms `schema.json` + `state.json`, but because the
atomic switch replaces the whole home directory, **staging carries a complete
copy of the home** — `runtime/`, `runtime/inbox/*` (authoritative), `cache/`, and
`artifacts/` are all preserved through the switch and retained in the backup, with
no silent loss (the transient `.state.lock` is the sole exception; a real home
entry that happens to share the staging directory's name is preserved too, and an
in-home staging layout is refused outright). The switch is two renames with one
non-atomic window, and **every** step after the first rename — the fsyncs and the
progress-marker writes, not just the rename — is phase-aware: a failure first
attempts an automatic rollback, and only if that rollback **also** fails is the
home reported as partially switched (a distinct `switch-ambiguous` blocker with
the exact `mv "<backup>" "<home>"` recovery) — it never falsely claims the home is
unchanged. A crash mid-switch leaves a durable marker; `yui update` recovery reads
that marker plus filesystem evidence (backup present, home missing) to name the
exact backup restore rather than a generic retry. Any other failed or blocked step
leaves the authoritative home byte-for-byte unchanged and reports the exact
blocker stage and recovery action. Only explicitly registered adjacent steps
can convert a real home; Yui never dual-reads an older schema or guesses an old
identifier. Compatible loading remains an explicit normalization contract, not
a permissive old-schema reader. See
[Task-local identity](docs/task-local-identity.md) for the current reference
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

Setup also seeds four reusable Worker Profiles:

```text
worker  explorer  implementer  reviewer
```

Profiles are versioned, provider-neutral Worker behavior templates. They hold portable prompt instructions, Skills, access expectations, and optional model and effort hints, but do not bind an Agent or own a Session or workspace. A Task Role is the Task-bound Worker instance: applying a Profile copies its portable behavior into that mutable instance, while each Agent binding keeps its own runtime configuration.

## Quick start

Bind a Project and create a Draft Task:

```sh
yui project add app /absolute/workspace/app \
  --remote git@example.com:team/app.git --stable main --development main
yui project update app --alias app-cli
yui project refresh app
yui project list

yui task create "Ship CSV export" --project app
yui task update <task-id> --priority high --tags release,csv --due-at 2026-08-01T00:00:00Z
yui task update <task-id> --clear-priority --clear-tags --clear-due-at
yui task show <task-id>
yui task context <task-id>
yui task activate <task-id>
```

`project refresh` is the explicit network operation for a stable Project checkout. It fetches the
configured stable branch directly from the Project remote URL and advances only through a clean,
verified fast-forward. Refresh requires matching stable and development branches, treats untracked
files as dirty, preserves ignored files, and refuses missing remotes or refs and diverged checkouts.
When the configured branch is `HEAD`, refresh resolves the remote's symbolic default branch for that
operation and requires the checkout to be on that branch; detached or mismatched checkouts fail.

Use `task context` as the first detailed read of an existing Task. It combines the Task, Brief, active Decisions, recent Milestones, Roles, current and recent WorkItems with their Runs, recent Messages, open and resolved InputRequests, and recent Events. Terminal output keeps histories and long text compact; `yui --json task context <task-id>` returns the complete records in the top-level `data` field.

Human-facing timestamps default to Beijing time (`Asia/Shanghai`) while durable
records and `--json` data remain UTC/RFC 3339. Inspect or change the IANA
timezone with:

```sh
yui config show
yui config set --time-zone Europe/London
```

WorkItem review is one global, optional rule that reuses an existing Global
Role's Agent, model, permissions, prompt, and Skills:

```sh
yui config review set --role reviewer --trigger always
yui config review show
yui config review clear
```

For Project-backed software delivery, use `--trigger final` to keep WorkItem
acceptance and Integration independent and run one fresh ReviewRound over the
complete frozen integrated Task candidate before completion:

```sh
yui config review set --role reviewer --trigger final
```

Every result entering Leader acceptance is one explicit candidate on its
existing WorkItem. The current global rule applies to the next candidate in
every existing or new Task; that candidate snapshots the rule, so later
`set`/`clear` changes do not rewrite an in-flight decision.
`always` starts a ReviewRound for every candidate, including a yielded Role Run
or a Leader-managed direct result; `leader` leaves the candidate awaiting
acceptance so the Leader can accept it directly or run
`yui task work review <task-id>/<work-item-id>`. A configured review rule therefore keeps
Leader-managed candidates awaiting a decision instead of marking them done.
`final` does not create WorkItem ReviewRounds; `task complete` queues one
Task-scoped ReviewRound after every bound Project has a committed Integration,
and re-queues a new round only when those frozen heads change. The final
Reviewer follows Project Policy/Knowledge and reports reachable, material,
actionable findings across the complete Task.
A ReviewRound freezes the Candidate's exact Git commit and creates a fresh,
ReviewRound-owned writable worktree on a unique branch. Its AgentRun may edit,
test, and optionally commit diagnostic evidence there, but never changes the
Candidate or Worker workspace and never creates another WorkItem, Candidate,
ChangeSet, or recursive review. The result wakes the Leader, who decides whether
to route evidence to the original Worker, accept, reject and redispatch that
Worker in its existing Session, review again, or request user input.
A failed review remains visible evidence and wakes the Leader, but does not
take that decision away from the Leader.
Candidate history, every ReviewRound, and the Leader decision remain grouped
under the original WorkItem. A rejected result creates a new Candidate on the
next dispatch while reusing the original execution Role, Session, and
workspace.

Yui Core supplies lifecycle and exact-scope safety; generic role Skills supply
portable collaboration behavior; Project Policy/Knowledge supplies
project-specific build, test, migration, release, and review rules; the Task
Contract supplies the current objective and acceptance. Project-backed Workers
commit and leave the Develop workspace clean before
yielding a Candidate. Yui freezes each writable Project's HEAD in the Candidate
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
  --base backend=develop --base frontend=main
yui task project add <task-id> shared-sdk --base main
```

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
after a Worker yields and reports that another repository is required; an
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
yui operator list
yui operator resume
yui operator resume --last
yui operator new
yui operator enter
```

When a Task Role's current native Session cannot continue, reset it by intent:

```sh
yui task role reset <task-id> <role> --reason "<why this generation cannot continue>"
```

Yui derives the current Run, Agent, launch, receipt, and native Session from its
own records. It fails only that exact active Run (and its execution WorkItem),
stores the current Session as broken history, and asks the Controller to stop
only the Role-owned runtime. The command never creates a Candidate, accepts
work, or completes the Task. While cleanup is pending, `task role status` and
`task context` block a fresh launch. Existing messages, reviews, and delivery
history remain durable.

Without `--task`, `operator submit` creates a new Draft. Drafts accept planning changes but must be activated before Agent execution.
Operator resolves every request against the Project catalog and existing Task
context. Follow-up requirements, fixes, reviews, and questions for the same
bounded outcome stay in that Task even when they involve multiple Projects.
A distinct outcome, ownership boundary, or lifecycle creates a separate Task.
Features, bugs, and questions use the same
Task/WorkItem model rather than separate workflow types.
`operator list` shows recent conversations in fixed most-recently-updated order using
their Agent and readable title or preview; native provider session IDs remain
internal. Until an adapter supplies that metadata, Yui shows the provider plus
a stable short Yui reference so untitled conversations remain distinguishable.
`operator resume` opens the same lightweight numbered list, while
`--last` resumes the newest entry directly. `operator new` starts a clean
conversation and preserves the previous one in history.

Create a Task-bound Worker instance from the configured global Worker, apply a
Profile, and dispatch a WorkItem:

```sh
yui role show worker
yui task role add <task-id> implementer --profile implementer
yui task role show <task-id> implementer

yui task work create <task-id> "Implement the exporter" \
  --project app --role implementer
yui task work isolate <task-id>/<work-item-id>
yui task work dispatch <task-id>/<work-item-id> --input "Implement and run focused tests"
```

Permission is one adapter-specific enum configuration on each Agent binding:
`default` follows the provider, `bypass` compiles the provider's supported
bypass flag, and `configured` retains whichever native options are explicitly
set. Codex options are `sandbox` and `approval`; Claude options are `mode`,
`allowedTools`, and `disallowedTools`. Provider permission is independent from
Profile behavior and Project write authority: only an exact WorkItem scope and
matching managed workspace grant normal Project writes. A ReviewRound is the only non-WorkItem write
purpose and must match its Run, reviewRoundId, frozen base, and
ReviewRound-owned workspace; every mismatch fails closed. Its diagnostic commit
is visible history but is
explicitly rejected by capture, ChangeSet, Integration, and acceptance paths.
Review yield keeps the same exact `--summary-file -` command, but its stdin is
the Reviewer's complete free-form Markdown or JSON report. If a JSON report
includes known `checks` or `evidenceCommit` fields, Yui records them as
structured evidence and verifies the reported commit against the managed
Review branch HEAD; unknown fields remain part of the report. Dirty uncommitted
diagnosis may yield without a commit; the worktree is retained and cleanup
refuses it until it is clean.

Every Role desired launch change increments its revision and applies only to a
future launch. Each AgentRun and native Role Session stores the complete actual
agent, adapter, model, effort, Profile access intent, exact writable Projects,
permission strategy and native options, workspace, context, and source desired revision. Updating,
switching, or clearing Role overrides never
hot-mutates an existing process. `task context`, Role views, Run history,
Events, and Web show desired/effective revisions, Profile intent, permission, and
pending next-launch drift.

Both Codex and Claude deliver a managed Run only through its exact injected
stdin-yield command. A final assistant message alone is not a durable handoff;
permission denial, a missing or wrong Run yield, and StopFailure fail closed.

The Worker delivers its current Run explicitly:

```sh
yui task run yield <task-id>/<run-id> --summary-file - <<'YUI_SUMMARY'
Implemented the exporter; focused tests pass
YUI_SUMMARY
```

Yield completes the AgentRun, submits the WorkItem for Leader review, appends
the result message, and queues the Leader. It does not accept the WorkItem. A
Leader never wakes itself; any pending Operator or Worker wake remains durable
until the Leader is idle.

If the outcome cannot be determined, label the handoff `uncertain`,
`incomplete`, `blocked`, or `requiring Leader judgment` and submit the most
complete truthful identities, actions, repository state, checks and errors,
lifecycle boundary, unfinished work, open decisions, risks, confidence, and
bounded next options. Yield records immutable Run/Candidate or Review evidence
only; it does not imply acceptance, WorkItem completion, ChangeSet capture,
Integration, or Task completion.

For bounded work, the Leader owns a roleless WorkItem and may execute it
directly or create a native subagent through the current Agent conversation:

```sh
yui task work create <task-id> "Review the implementation" \
  --objective "Return source-backed findings" \
  --accept "Every finding identifies an affected path"
yui task work update <task-id>/<work-item-id> running
yui profile show reviewer
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
AgentRun when work needs its own provider, credentials, interaction, or durable
Session.

For an isolated Task Role result, the Leader first reviews the yielded result.
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

Worker yield is not WorkItem completion. The Leader accepts only after reviewing
the result, validations, and the latest ChangeSet integration:

```sh
yui task work accept <task-id>/<work-item-id> --summary "Acceptance criteria met."
```

Use `task work reject` to return an awaiting result for repair and redispatch,
and `task work retire <task>/<work> --summary "..."` to retire obsolete work,
optionally naming a replacement. WorkItem and Integration
worktrees and check logs remain available as evidence until explicit cleanup.

For long-running Tasks, the Leader keeps Yui—not a native transcript—as the
recovery authority. The Task Brief owns the overall technical approach,
including how coordinated Project changes fit together. WorkItems own the
executable per-Project modifications and acceptance checks. The Leader updates
Brief focus and Leader summary before every yield, records material choices as
Decisions, adds phase outcomes as Milestones, and promotes only cross-Task
stable facts to Project Knowledge.

When an active Leader Run cannot continue without a user decision, it can create a durable InputRequest and yield its Run:

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

`task input list` is the authoritative global open-input Inbox; add a Task ID to scope it, or `--all` to include answered and cancelled requests. The Controller also makes one receipt-backed, best-effort delivery to an already-running Operator process. It never starts or interrupts an Operator for this notification; unavailable process state or a changed pane fence falls back to the durable Inbox and is reconsidered on a later Controller pass. It does not inspect or classify Agent terminal text. Answers may be submitted by the user or Operator. An open request prevents unrelated pending wakes and Task completion or archival. The originating Leader may instead run `yui task input cancel <task-id> <input-id> --reason "..."`; cancellation queues that fixed Leader session to resume.

Inspect the result:

```sh
yui task context <task-id>
```

Use the narrower `task work`, `task message`, `task run`, and Task Knowledge commands when you need one collection or record.

When the requested outcome is finished, complete the Task to stop automatic Leader wakes without deleting its sessions or Task main worktree:

```sh
yui task complete <task-id> --summary "CSV export shipped and verified"
yui task reopen <task-id>
```

Completed Tasks reject messages, dispatch, enter, retry, and late yields until explicitly reopened, while retaining Task main for inspection or integration. Every isolated WorkItem worktree must be explicitly cleaned as integrated or abandoned before archive; that cleanup also removes its managed branch. Archive requires `--integrated` or `--abandon` to state the Task main outcome and is allowed only after Task main is clean. It removes managed worktrees but retains Task and WorkItem records. The Task main branch is retained as a recovery artifact instead of being silently deleted.
Task lifecycle completion/selection only suggests valid source states: Draft for activate, active for complete, and completed for reopen.

## Sessions and tmux

tmux owns Agent process lifetimes and their observable output. Global Operator
and global Role sessions remain native interactive CLIs. A managed Task Claude
Run instead starts one finite Claude process with `--print`, stream-json input
and stream-json output. Yui writes the exact Run prompt as one newline-delimited
JSON user frame on stdin, drains output concurrently, and carries native
continuity with Claude's session ID. Startup and delivery therefore never
depend on a TUI composer, readiness glyph, paste delay, or a synthetic Enter
key. Codex keeps its adapter-native launch-prompt and structured callback path.

`task enter` and `task role enter` are pure attachments to an existing Task
Role pane. They do not start the Controller, prepare a workspace, create or
resume an Agent, wake a Role, or deliver input. Task attachments default to
`--read-only`; `--read-write` is explicit and is rejected while that Role owns
an active managed Run, a managed Claude process is still exiting, or another
writer owns the same pane. A read-write attach first publishes a Role-scoped
tmux writer lease and then revalidates durable Run state, closing the race with
Controller launch. While the lease exists, managed delivery for that Role is
paused without consuming its bounded delivery retries; detach releases the
lease and signals only already-durable Role work for reconsideration. Other
Roles in the same Task continue independently. Before any attach Yui closes
readline, leaves raw mode, pauses its stdin, and synchronously hands the terminal
to tmux. The attach uses the real outer terminal capabilities and a clean alternate
screen; mouse scrolling stays in the Agent pane's
100,000-line tmux history instead of mixing with earlier shell or IDE terminal
history. A read-write attachment exposes whatever native interaction the
existing pane supports, but it is never part of managed startup or delivery.

tmux fixes a pane's history capacity when that pane is created. Roles created
before this limit was configured keep their earlier capacity; Yui warns on
Terminal attach and in Web so the user can exit and re-enter that Role once to
create a 100,000-line pane while retaining the native Agent conversation.

Global interactive entry remains writable when no writer exists and
automatically downgrades to read-only when another writer is present; global
Web keeps one writer per tmux session. Task Web is always read-only. Task CLI
entry is read-only unless `--read-write` is requested, preventing observation
from changing Agent execution.

```sh
yui role enter <global-role>
yui task enter <task-id> [role] [--read-only | --read-write]
yui task role enter <task-id> <role> [--read-only | --read-write]
```

Each Role, including a Task-bound Worker instance, can bind multiple configured Agents, has one active Agent, and keeps
a separate native session per Agent binding. Operator narrows this to at most
one Agent per adapter—for example, one Codex and one Claude—so its bindings are
ready-to-switch configurations rather than parallel identities. Operator can
keep multiple conversations for each binding. `operator new` and
`operator resume` reuse the single Operator tmux pane: when a process is
running, Yui asks before stopping it and switching the conversation. On a
cross-Agent switch, the saved model and effort are reused unless the user
explicitly chooses to update them.

The Role's active binding is desired state for the next compatible launch. A
running AgentRun and its native Session continue under their immutable
effective snapshot even if the Role is edited or switched. Resume is allowed
only when the complete effective snapshot and workspace remain compatible;
otherwise Yui starts a new Session after the old process has stopped and keeps
the terminal Session's immutable effective snapshot in history. Until that
process terminates, exact control-plane wakes continue through its actual
snapshot instead of applying desired drift as a hot change.

Use `yui role unbind <global-role> <agent-id>` or `yui task role unbind <task-id> <role> <agent-id>` to retire a dormant binding. The active binding and any non-stopped native session are rejected; a stopped session record is removed atomically with the binding.

Claude session IDs are preallocated at launch. Every managed Task Claude Run
uses a new finite process; resume starts a new process against the fixed native
session instead of reusing an interactive pane. Codex discovers its native
thread identity from structured lifecycle events. Managed Task Runs use one
Agent Driver Hook ingress for both CLIs. Global interactive Codex sessions may
still use its structured `notify` callback for conversation presentation.

Automated lifecycle and delivery decisions use structured Hook payloads,
persisted identities, usage snapshots, tmux process state, receipts, and pane
fences. Yui never
parses prompt glyphs, progress text, trust dialogs, or other Agent terminal
output to infer readiness or success. `captureRole()` remains an explicit
human-facing transcript read and has no lifecycle authority.

The [Agent Runtime Driver architecture](docs/agent-runtime-drivers.md) keeps
native Codex/Claude event names at the edge. Core consumes exact-fenced
Session, Turn, operation, waiting, host, and activity observations. A positive
token delta is evidence of recent runtime activity; an unchanged counter is
not. A live tmux pane proves only that the host exists. Runtime activity and
durable workflow progress use independent clocks, so token/tool/resource
movement cannot conceal a workflow that is not advancing.

Stable Role context is also launch metadata, never a bootstrap turn. Yui passes Role policy and `systemPrompt` through the Agent's native system/developer-instruction channel. Task execution Runs receive the generic Leader or Worker Skill, while review Runs receive the generic Reviewer Skill based on durable Run purpose rather than a configured Role name. These Yui-owned Role Skills define portable orchestration only. Project Skills remain ordinary versioned files in the Project and are discovered, selected, and loaded by the Agent through its native project mechanism; Yui does not scan, parse, copy, or inject them.

Native Codex developer instructions carry compact absolute references only for Yui-owned Role Skills, which Codex reads on demand. Because `developer_instructions` is one scalar setting, Yui inspects every supported Linux Codex layer—`/etc/codex/config.toml`, the user config, the selected `$CODEX_HOME/<name>.config.toml`, project configs, and `/etc/codex/managed_config.toml`—and refuses to replace a value found in any of them. Codex sessions opened without a managed Run use Yui's structured `notify` callback for session presentation and therefore require exclusive ownership of that setting. Managed Runs instead use invocation-local Agent Driver Hooks as their sole lifecycle authority. `skills.config` is not misused because it only enables or disables already-discovered Skills. Claude receives the same Yui-owned Role Skill content from a private `0600` managed context file rather than a large or sensitive argv value; retries and resumes reuse the purpose-specific Role path. Non-Operator global Roles stay neutral and receive no Task orchestration Skill. Operator therefore opens at an empty native composer, so the user's text remains its first user message. Leader wakeups and Worker or Reviewer Run assignments remain real mailbox-delivered work messages. An adapter without a native instruction channel must reject this context rather than silently converting it into a first user prompt.

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

`controller restart` replaces the Controller process and its scheduler/socket services with the currently installed Yui version. It does not stop or restart managed tmux/Agent sessions.

Its recovery reconciliation runs every 120 seconds by default. Normal durable state changes enqueue a Task, Role, or Operator key and return immediately; keys received in the same fixed 100 ms window trigger one non-overlapping targeted pass. Operator presentation has an independent lane, so a blocked Task workspace operation cannot delay a user question. Periodic Git/worktree work is limited to Tasks with durable Task-mailbox work, while active Role liveness uses one tmux inventory. Agent Driver Hooks write exact-fenced observations to the durable runtime inbox without starting or waiting for the Controller. A terminal Turn observation gives a legal yield/input/completion two seconds to win before a forgotten Run fails its workflow contract. Durable mailboxes freeze the current batch while new signals merge into the next batch. Task-orchestration failures retain the exact Controller-owned processing batch for two bounded fast retries and later periodic recovery; a successful retry completes that batch before newer pending work is claimed. Recommended InputRequest and pending Turn deadlines share one nearest-deadline selector and therefore do not wait for the recovery interval. Explicit `task reconcile` still requests an immediate recovery pass. The retained loop is:

1. dispatch pending Leader wakes whose Task workspaces are already ready;
2. prepare active Project Task main worktrees with durable orchestration work;
3. deliver queued Worker Runs;
4. resolve due Turn completions and reconcile Role liveness;
5. dispatch Leader work created or unblocked by the later recovery phases.

Automated input is sent only through tmux. Each pass performs one non-blocking process-state readiness check; a busy startup is retried through a small bounded mailbox timer, while later busy sessions are woken by canonical Agent Driver terminal observations. A pane-local receipt prevents the same Run from being typed twice after a Controller retry.

If a Role process exits before yielding, the Controller fails that Run and running WorkItem and queues the Leader. Recovery failures are exposed through the small compatibility Jobs view:

```sh
yui jobs list
yui jobs retry leader-recovery:<task-id>
yui task reconcile <task-id>
yui task run retry <failed-run-id>
yui task run settle <obsolete-failed-review-run-id>
```

`jobs` is not a restored generic queue: it presents durable pending Leader wakes and Leader recovery failures only.

`task run settle` is a Leader-only repair for one exact failed Reviewer Run whose
matching Task-final ReviewRound was stranded running by an older lifecycle. It
closes only an obsolete frozen candidate, preserves the Run, Round, workspace,
and evidence, and never creates a retry Round.

Completion is the reversible execution fence. Archiving is terminal and is accepted only after active work is settled: it stops the Task's tmux session and removes clean managed worktrees. Dirty worktrees keep the Task completed and are preserved for deliberate resolution.

## Local web control room

Run the local control room on the default loopback address:

```sh
yui web
# Yui web control room: http://127.0.0.1:4173
```

Use `--port <port>` or `--host 127.0.0.1|::1|localhost` to change the
listener. Yui rejects non-loopback hosts because the control room exposes Task
metadata, Briefs, Roles, WorkItems, Runs, messages, Decisions, Milestones, and
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
currently active tasks. Selecting a task opens an anchored detail view
(Summary, Focus, Work items, Runs, Roles, History, Messages) with a sticky
tab bar that tracks the visible section.

The control room supports English and Simplified Chinese, selecting an initial locale from the browser and remembering manual changes. The theme selector switches between the dark Control Room, the light Paper Ledger, and the dark-blue Atlas themes. Both choices are stored only in browser `localStorage`; they do not modify `YUI_HOME`.

## Management commands

The restored management surface includes:

```sh
yui update
yui upgrade [--dry-run]
yui agent add|list|show|capabilities|update|remove
yui role add|list|show|update|remove|bind|enter
yui role session record|replace
yui project add|clone|refresh|update|discover|list|show|knowledge
```

`yui update` stages the newly published package **side by side** — it never
replaces the current global install first — then uses the staged binary to run an
internal path-specific read-only preflight against the Home. It classifies current
Homes, validates compatible-old sources into the current model in memory, and
checks the authoritative offline inventory for migration-required Homes. This
preflight does not create or validate a staged Home and is not
`upgrade --dry-run`; a full stage/validation/switch occurs only after the parent
stops the exact old Controller PID. Current and compatible-old Homes use the
no-Home-mutation fast path; migration-required Homes first require a clear
offline Run/Session/lifecycle inventory, then use the timestamped-backup switch.
Both paths promote the binary only after an exact PID-fenced old-Controller stop
and run a new-binary health check before the authenticated replacement starts.
Yui promotes the **same artifact it staged**
(binary activation pins the exact staged version, never a second bare `@latest`);
the staged version must be a **concrete semver** — a `latest`/dist-tag sentinel,
a malformed value, or a probe without a valid `{ ok:true }` envelope at exit 0 is
rejected and the stage **fails** rather than falling back to `@latest`. The health
check runs the **actually-activated** global binary and **requires** its version
to be concrete and equal to the staged one — a missing, unparseable, or mismatched
version fails closed (never skipped). Every spawned-child result must be a valid
`{ ok:true, data }` **success envelope** before its outcome is trusted (else
preflight blocks / activation is ambiguous), and a success-class outcome is
trusted **only when the process also exited 0**. The post-update health check
**parses and validates the machine-readable `yui --json doctor` envelope before
interpreting the exit status** — because `--json doctor` exits non-zero on
unhealthy storage — requires **every** expected storage check present-and-`ok`
(a missing/duplicated/malformed check fails closed), and rejects an unparseable or
self-contradictory envelope; only a valid success envelope with all storage checks
`ok` and exit 0 is healthy. On any failure it reports the exact phase and a
recovery action.

On the offline path, if storage activation cannot be resolved — the spawned staged binary was
killed or crashed after switching but before reporting — `yui update` reports a
distinct **ambiguous** result (a dedicated non-zero exit), never a false
"unchanged/recoverable". A durable completion receipt written the instant the
switch commits (a `<home>.upgrade-receipt.json` sibling, cleared on clean
success) lets it resolve the true state from receipt + backup + current schema
and print precise manual-verification steps. The receipt is trusted only when it
genuinely corresponds: it must carry this home's `homePath` and a `backupPath`
that is the expected `<home>.backup-*` real directory, so a **legacy receipt
without those fields, or one whose backup is unrelated / missing / not a
directory** is not trusted as proof of this attempt's switch — the
tool re-probes the real on-disk state instead.

Rollback boundary (precise): the managed Session launcher is an in-place
forwarder, not a versioned package pointer, so Yui does **not** claim binary+Home
dual-resource atomicity. It guarantees: (1) staging is isolated — a
stage/preflight failure leaves the old binary and Home byte-for-byte unchanged;
(2) the compatible fast path does not switch the Home; (3) the offline storage
switch is atomic with a timestamped backup and is recoverable by restoring that
backup until the new version resumes writes; (4) no auto-downgrade once the new
version has written. The offline path's non-atomic window — storage already
switched, binary promotion then fails — is reported with the exact
`mv <backup> <home>` recovery, and because the axes are version-gated the old
binary fail-closes on the new home rather than misreading it.

Agent environment bindings store process-environment variable names, never secret values. Adapter-owned lifecycle arguments cannot be overridden through raw arguments.

## Scope

Yui targets one trusted local user on one machine. Its Web/API surface is
loopback-only and intentionally omits remote or multi-user Web access,
distributed coordination, backup/import/export commands, trash/restore,
derived indexes, recovery journals, runtime leases, inactivity TTLs,
cooldowns, and recurring schedules. (The one internal exception is the
timestamped home backup `yui upgrade`/`yui update` takes immediately before an
atomic storage switch, purely to make that single switch recoverable — it is not
a general backup/restore facility.)

See [ARCHITECTURE.md](./ARCHITECTURE.md) for persistence and scheduling details.
The reusable, user-driven acceptance plan is documented in
[Operator routing and long-running Task E2E testing](./docs/testing/operator-routing-e2e-plan.md).

## Development

```sh
npm ci
npm run build
npm test
npm run lint
```

`npm test` (and `make test` / `make check`) runs the full **deterministic** test
suite: it never launches a real model and never touches the global `yui`
binary, a shared `YUI_HOME`, or a running production Session. It stays
deterministic even when launched from inside a managed Yui Session, because it
preloads `test/helpers/scrubSessionEnv.js` to strip every Yui-owned managed
runtime value from the test process, including shared `YUI_HOME`, exact Leader
action assertions, workspace projections, and Agent launch descriptors. Tests
that touch Home/CLI/Controller/tmux explicitly supply a test-created isolated
Home. The same preamble puts local refusal shims for bare `codex` and `claude`
ahead of the caller's `PATH`; Session fixtures install observable Mock Agents
inside their owned Home instead. Only a dedicated managed-identity child may
opt out. The Provider E2E tier is exempt from the shims only after its explicit
opt-in and mandatory isolation preflight path has been selected.

### Test tiers

Yui's tests are classified into five explicit, executable tiers so a reader
never has to guess what a test actually exercised. Each tier declares whether it
creates a Session, whether it calls a real model, and whether it stands up a
disposable real runtime. Agent workflow for applying these tiers while developing
Yui lives in [`.agents/skills/develop-yui/SKILL.md`](.agents/skills/develop-yui/SKILL.md); it is
not part of the generic Leader, Worker, or Reviewer workflow:

| Tier | Session | Real model | Disposable runtime | Preflight | Opt-in |
| --- | --- | --- | --- | --- | --- |
| Unit | no | no | no | no | — |
| Isolated Integration | yes | no | yes | no | — |
| Mock Agent Session | yes | no | yes | no | — |
| Provider E2E | yes | **yes** | yes | **required** | `YUI_ALLOW_PROVIDER_E2E=1` |
| Release E2E | **no** | **no** | yes | **required** | `YUI_ALLOW_RELEASE_E2E=1` |

```sh
make test-tier T=unit          # or: npm run test:tier -- unit
npm run test:tier -- unit -- --test-name-pattern "test name"
node scripts/run-test-tier.mjs list
```

The supported tier entrypoint always runs the canonical `npm run build` first.
It therefore works on a fresh checkout and cannot mistake a present but stale
`dist/cli.js` for current code. The raw `node --test dist/...` path remains an
unsupported bypass of that freshness boundary.

**Provider E2E is the only tier that calls a real model.** Release E2E, on its
normal path, creates no Session and calls no model — it exercises
binary/install/update/upgrade release flows against real npm/home/namespace
resources. Both tiers are **privileged and fail-closed**: they live only in
nested privileged manifests excluded from the default test glob, refuse to run
without their opt-in env var, and execute through one wrapper that registers
cleanup before observation and does not even evaluate the scenario module until
the blocking isolation preflight (`assertIsolationReady`) passes. Active-Session
observation is runner-owned and uses an all-scope Yui runtime inventory;
scenario code cannot replace it or manufacture an empty result. The preflight
requires an absolute
checkout-local launcher; a run root proven **temporary and creator-bound owned by
this run** — created via `createOwnedRunRoot` (mkdtemp + a random-token
ownership receipt) and re-proven by that exact token, with a symlink run root
refused and every path canonicalized so a symlink escape cannot pass a lexical
check; the disposable `YUI_HOME`, workspace, isolated npm prefix, and unique
runtime namespace all derived *inside that exact owned root* and **physically
fenced** against symlink escape; and an **explicit** observation that zero
production Sessions are active (missing evidence fails closed — it is never
assumed empty). No bare `yui`, `make link` symlink, shared home, arbitrary or
pre-existing foreign run root, symlinked path, or unproven Session state is
tolerated. Real-runtime teardown scans and cleans only the creator-owned Home,
uses Yui's exact process/pane/artifact identity fences, verifies the Home-derived
tmux server is absent, and refuses environment overrides that redirect
`YUI_HOME`. The reusable annotated-resource selector separately requires an
exact non-empty creator token plus matching `ephemeral-test` marker; a missing
token touches nothing and is a failed cleanup outcome. **Mock Agent Session
transport success does not prove
provider-native acceptance** — only the Provider E2E tier can record that. See
[docs/testing/test-tiers.md](./docs/testing/test-tiers.md) for the full contract.

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
checkout and defaults `YUI_HOME` to this checkout's `output/dev/home`, so every
instance identity that Yui derives from `YUI_HOME`—Controller socket, tmux
server, and state—stays separate from any other checkout or the global install.
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
