# Yui Repository Guidance

## Communicate at the user's level

- Lead with the product decision, observable behavior, and user impact.
- For architecture and design discussions, explain responsibilities and end-to-end flows before internal modules.
- Do not default to schemas, field lists, file-by-file inventories, migration mechanics, or exhaustive test cases. Include them only when the user requests them or they materially affect a decision, risk, or rollout.
- Report validation at the level needed to establish confidence; keep raw commands and detailed test matrices out of the human-facing summary unless they are actionable.
- When the user asks for analysis only, remain read-only.
- When only user authorization is needed, present the action and impact, obtain confirmation, then let the Operator perform the mechanical work. Do not make the user execute steps that Yui can safely perform.

## Separate human and Agent deliverables

- Human-facing communication should be concise: outcome, architecture, behavior change, material tradeoffs, unresolved decision, and next action.
- Agent-facing WorkItems and handoffs should be executable: relevant components, constraints and contracts, ordered implementation path, failure cases, acceptance criteria, test cases, and expected evidence.
- Do not paste a detailed Agent execution brief into a user-facing response. Synthesize it into the product-level result.
- Do not make Agent instructions vague merely to keep the user-facing explanation short. Maintain separate views for the two audiences.

## Preserve Yui's product boundaries

- Treat Yui CLI reads as the context API. Launch and wake messages should guide an Agent to the relevant Project, Task, WorkItem, message, or input records instead of embedding the full source content.
- Persist Project Knowledge in YUI_HOME. Repository files may be evidence or reading material, but they are not the authority for Yui's maintained knowledge.
- Treat stable Project checkouts as read-only reference workspaces. Perform Task and WorkItem changes in managed worktrees.
- A Project-backed Task receives its main worktree when it is created. During execution, the Leader may create an isolated WorkItem worktree directly when concurrent work warrants it; do not introduce an approval workflow.
- Archive only after active work is settled, results are integrated or deliberately abandoned, and managed worktrees are clean and removable. Worktree cleanup must not delete the Task record.

## Keep the main path lean

- Do not add legacy storage or workspace compatibility unless the user explicitly requests it.
- Prefer the smallest workflow that satisfies the current product commitment. Avoid speculative states, background protocols, and duplicate sources of truth.

## Keep Yui-specific workflow in its Project Skill

- When developing this repository, read and follow [`.agents/skills/develop-yui/SKILL.md`](.agents/skills/develop-yui/SKILL.md). It owns Yui-specific implementation and validation workflow; do not copy those Project details into Yui's generic Leader, Worker, or Reviewer behavior.

## Run this checkout in isolation

- To exercise Yui from this checkout, run `make install-local` once, then always invoke the launcher by absolute path: `<checkout>/output/dev/bin/yui ...`. This is the reliable per-checkout entry point for automation.
- `make install-local` builds `dist/` and writes exactly one file, the launcher at `output/dev/bin/yui`. It does not modify `PATH`, does not touch the global `yui`, and does not create the data home. It is idempotent; re-run it after pulling code.
- The launcher resolves its own checkout and defaults `YUI_HOME` to this checkout's `output/dev/home`, so the Controller socket, tmux server, and state that Yui derives from `YUI_HOME` stay separate from other checkouts and the global install. Calling it by absolute path works from any working directory.
- A bare `yui` always resolves through `PATH`, independent of the current directory. Being inside this checkout does NOT make bare `yui` use the local launcher; it still runs whatever `PATH` finds (typically the global `yui`). Only an absolute launcher path selects this instance. A per-shell `export PATH=<checkout>/output/dev/bin:$PATH` also works, but only inside that one interactive shell.
- Each command runs in a fresh process, so `export PATH=...` / `export YUI_HOME=...` do not persist to the next command; never depend on them in automation. Use the absolute launcher path every time instead.
- Do not use `make link` to test a change: it persistently replaces the user-level global `yui` for every shell. Prefer `make install-local` plus the absolute path for per-checkout work.
- `make install-local` only creates the launcher. Initialize the isolated home once with `<checkout>/output/dev/bin/yui setup` before commands that need state, and run `<checkout>/output/dev/bin/yui controller restart` if a Controller is already running an older build.
