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
