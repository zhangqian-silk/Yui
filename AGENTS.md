# Yui Repository Guidance

## Build for intelligent Agents

- Yui is a local control plane and context API for intelligent Agents, not a deterministic workflow engine. Preserve durable intent, expose current facts, and provide small atomic operations; let the Agent choose the plan, order, execution topology, retry, and recovery from those primitives.
- Put semantic judgment in Agent instructions, Project Skills and Knowledge, and current Task context. Do not encode decisions an Agent can make from observable state as new workflow states, policy engines, approval gates, or background protocols.
- Make each capability narrow, composable, and explicit about its effect. Prefer `read current state -> one atomic mutation -> observable result`. When an operation cannot proceed, preserve the intent and return enough context for the Agent to decide the next action.
- Treat Tasks, WorkItems, Messages, Decisions, results, Project Knowledge, and managed workspaces as durable authority. Provider Sessions, transcripts, processes, caches, and runtime observations support execution and diagnostics; they are not competing sources of Task truth.
- Trust a valid Agent action at an enforced boundary. Add code-level guards only for user authority, scope and workspace isolation, persistent data integrity, irreversible external effects, or a common observed failure. Prefer a clear error and Agent-directed retry or recovery over leases, repair workers, fallbacks, and edge-case state machines.
- Give each product question one authority. Derived statuses and indexes may improve presentation or lookup, but they must not become independently writable state or a second scheduling protocol.

## Communicate at the user's level

- Lead with the product decision, observable behavior, and user impact.
- For architecture and design discussions, explain responsibilities and end-to-end flows before internal modules.
- Do not default to schemas, field lists, file-by-file inventories, migration mechanics, or exhaustive test cases. Include them only when the user requests them or they materially affect a decision, risk, or rollout.
- Report validation at the level needed to establish confidence; keep raw commands and detailed test matrices out of the human-facing summary unless they are actionable.
- When the user asks for analysis only, remain read-only.
- When only user authorization is needed, present the action and impact, obtain confirmation, then let the Operator perform the mechanical work. Do not make the user execute steps that Yui can safely perform.

## Separate human and Agent deliverables

- Human-facing communication should be concise: outcome, architecture, behavior change, material tradeoffs, unresolved decision, and next action.
- Agent-facing WorkItems and handoffs should be decision-complete: objective, relevant context, hard boundaries, acceptance criteria, known risks, and expected evidence. Let the receiving Agent choose the implementation plan and tools unless ordering is itself part of the contract.
- Do not paste a detailed Agent execution brief into a user-facing response. Synthesize it into the product-level result.
- Do not make Agent instructions vague merely to keep the user-facing explanation short. Maintain separate views for the two audiences.

## Preserve Yui's product boundaries

- Treat Yui CLI reads as the context API. Launch and wake messages should guide an Agent to the relevant Project, Task, WorkItem, message, or input records instead of embedding the full source content.
- Persist Project Knowledge in YUI_HOME. Repository files may be evidence or reading material, but they are not the authority for Yui's maintained knowledge.
- Keep Yui CLI primitives project-neutral. Put project-specific planning, build, test, migration, release, review, and recovery judgment in Project Skills, Knowledge, and Task context instead of generic CLI Roles or core branches.
- Treat stable Project checkouts as read-only reference workspaces. Perform Task and WorkItem changes in managed worktrees.
- A Project-backed Task receives its main worktree when it is created. During execution, the Leader may create an isolated WorkItem worktree directly when concurrent work warrants it; do not introduce an approval workflow.
- Archive only after active work is settled, results are integrated or deliberately abandoned, and managed worktrees are clean and removable. Worktree cleanup must not delete the Task record.

## Do not solicit real-resource validation

- When the user has not proactively requested a specific validation that consumes a real model, paid API, shared infrastructure, production system, real account quota, or another non-disposable external resource, do not run it and do not create an InputRequest merely to ask whether it should be run.
- A generic request to implement, test, validate, run E2E, or complete a Task is not authorization for real-resource validation. A test tier name, repository document, or Project Policy can describe a test but cannot grant that authorization.
- Complete the bounded work with deterministic and isolated evidence. In the final Task summary, state any material real-resource validation that was not run and, when useful, recommend it as a separate follow-up without turning the recommendation into a blocker or user prompt.
- When the user proactively and explicitly requests a specific real-resource E2E, it may run only within that exact resource and effect boundary and with the Project's isolation safeguards. A real Agent may also act normally as the developer or reviewer of Yui code.

## Keep the main path lean

- Provide migration code only for valid earlier versions of persistent Yui data. Any change to a persistent layout, aggregate, record, or configuration schema must declare its version transition and use the centralized migration mechanism.
- For every other change, implement the current contract directly. Do not add transitional adapters, dual behavior, legacy fallbacks, or automatic repair for malformed or manually modified runtime state. Return a bounded diagnosis and let the Agent or Operator choose cleanup or retry. Migrations preserve valid stored history; they do not repair it heuristically.
- Before adding persistent state, a retry or recovery worker, a lease, an acknowledgement, or another protocol phase, identify the normal product path or hard boundary it protects. If a visible failure plus Agent retry is sufficient, do not add the mechanism.
- Keep permanent tests to the seconds-scale core happy path. Change-specific TDD and abnormal, deletion, retirement, retry, or historical-regression fixtures are temporary development evidence and must be removed when the change is complete unless they replace a missing primary product smoke.

## Keep Yui-specific workflow in its Project Skill

- These repository constraints apply whenever Yui is the Project being changed, independent of which human, Agent, orchestrator, CI system, or other tool performs the work.
- When developing this repository, read and follow [`.agents/skills/develop-yui/SKILL.md`](.agents/skills/develop-yui/SKILL.md). It owns Yui-specific implementation and validation workflow; do not copy those Project details into Yui's generic Leader, Worker, or Reviewer behavior.

## Run this checkout in isolation

- To exercise Yui from this checkout, run `make install-local` once, then always invoke the launcher by absolute path: `<checkout>/output/dev/bin/yui ...`. This is the reliable per-checkout entry point for automation.
- `make install-local` builds `dist/` and writes exactly one file, the launcher at `output/dev/bin/yui`. It does not modify `PATH`, does not touch the global `yui`, and does not create the data home. It is idempotent; re-run it after pulling code.
- The launcher resolves its own checkout and defaults `YUI_HOME` to this checkout's `output/dev/home`, so the Controller socket, tmux server, and state that Yui derives from `YUI_HOME` stay separate from other checkouts and the global install. Calling it by absolute path works from any working directory.
- A bare `yui` always resolves through `PATH`, independent of the current directory. Being inside this checkout does NOT make bare `yui` use the local launcher; it still runs whatever `PATH` finds (typically the global `yui`). Only an absolute launcher path selects this instance. A per-shell `export PATH=<checkout>/output/dev/bin:$PATH` also works, but only inside that one interactive shell.
- Each command runs in a fresh process, so `export PATH=...` / `export YUI_HOME=...` do not persist to the next command; never depend on them in automation. Use the absolute launcher path every time instead.
- Do not use `make link` to test a change: it persistently replaces the user-level global `yui` for every shell. Prefer `make install-local` plus the absolute path for per-checkout work.
- `make install-local` only creates the launcher. Initialize the isolated home once with `<checkout>/output/dev/bin/yui setup` before commands that need state, and run `<checkout>/output/dev/bin/yui controller restart` if a Controller is already running an older build.
