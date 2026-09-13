# Record external delivery

Use this after creating, updating, closing, reopening or merging a PR/MR
within existing user authorization. This procedure does not grant permission
to push, publish, merge, query an external provider or archive.

Immediately record the confirmed operation with `yui task publication upsert`.
Supply only facts already known from the operation; do not defer recording to
another Role or depend on provider-specific discovery.

Track PR/MR identity, state, commits, URL, merge time and evidence, not CI or
deployment status. After merge, use `yui task publication verify` only when
current authorization covers that external provider read. Otherwise retain
reported evidence and state the verification gap.

Keep the completion head as the original acceptance evidence. If an authorized
post-completion integration produced a different publication candidate, record
its exact local commit, then read `task publication diff <task>/<publication>`.
Inspect the complete delta against the original acceptance, including removals,
conflict resolutions and additional changes. Only when that candidate still
satisfies the result and its relevant increments are accepted, record
`task publication adopt <task>/<publication> --reviewed-diff <sha256> --acceptance <text>`.
Explain the semantic judgment and verification/review evidence in the acceptance.
When an existing Task Integration produced that exact candidate, include
`--integration <id>` in diff and adopt to bind its committed evidence.
Ancestry or Integration success alone is not acceptance; do not reopen the Task,
rewrite completion, or mark a merge verified to bridge an evidence gap.

Adoption records a fixed decision, not remote verification or publication
authority. The verify operation observes the exact Publication candidate through
its provider and records contrary head/state facts as reported successors,
invalidating previous verification. Metadata and verification updates may retain
adoption while the candidate is unchanged; a changed candidate needs a new
decision. Archived history is read-only to these adopt/verify operations.

Use `yui task remote-delivery <task>` to explain external delivery. Publication
is not Candidate acceptance, Review, Integration or Task completion.

Completion does not authorize archive. The Operator obtains authorization for
the exact Task, checks archive eligibility, then uses `--integrated` for verified
merged delivery or `--abandon` for deliberate non-delivery. General archive
approval never implies `--force` authority. Preserve the Task record.

With explicit force authorization for a completed or cancelled (retired) Task, use
`yui task archive <task> (--integrated|--abandon) --force`. Force commits the
archive and stops new Task scheduling before attempting safe foreground cleanup.
Missing/stale delivery evidence, unresolved execution and cleanup errors become
warnings with retained resource references; they do not block that commit.
Authority, lifecycle, identity and mandatory audit persistence still fail closed.

Force does not verify a merge, accept work, stop unknown execution, discard dirty
data or imply abandonment. Keep the requested disposition and original
Publication/completion evidence. Unverified local commits and resources that
cannot be safely released stay owned and traceable. Late runtime events remain
source evidence, not authority to resume or settle unknown input.

Read `task show <task> --json` for `data.archive.warnings`,
`data.archive.retainedResources` and `data.archive.cleanupEvents`;
`task context` also retains the original records/events. A successful archive
exit means `archived=true`, not that cleanup fully succeeded. `cleanupFinished`
means the foreground pass finished, not that every resource was removed.
If cleanup was interrupted, the Task stays archived. Repeating archive only
reports current facts; use explicit, exact-owner resource operations after
inspection instead of re-running broad cleanup. No background retry is implied.
