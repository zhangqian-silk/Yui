# Home identity and managed Project upgrade runbook

This runbook is the Operator sequence for upgrading a Yui Home to the canonical
Home identity, Home-owned managed Project binding, and identity-derived Task
workspace layout. It runs **after** the new Yui release is committed and
published. Every step is idempotent and retryable; a failure at any step leaves
the Home in a consistent, usable state.

## 1. Release the new Yui

1. Open the PR, review, and merge to `master`.
2. Publish the npm package (`npm publish`).
3. On each Operator machine, update the installed CLI:

   ```sh
   yui update
   ```

   If a Controller is running, replace it with the new binary:

   ```sh
   yui controller stop
   yui controller start
   ```

   The new CLI refuses to run against an older storage schema until the Home is
   migrated; the next step performs that migration.

## 2. Migrate the storage schema

The new aggregate schema mints the persistent Home identity and upgrades every
record family. This is an offline migration:

```sh
yui doctor          # confirms the Home is migratable
yui upgrade         # performs the migration, writes a backup first
```

The upgrade is transactional and writes a full backup (`*.upgrade-backup`)
before switching. A failed upgrade leaves the original Home untouched and can be
retried.

## 3. Migrate external Projects to Home-managed

For each Project bound by a user-controlled checkout path with a remote URL:

```sh
yui project migrate <project> --preflight   # read-only verification
yui project migrate <project>               # clone + verify + atomic switch
```

The migration clones the remote into `$YUI_HOME/projects/<projectId>`, verifies
both configured branches against the advertised remote SHAs, and switches the
catalog record only after verification succeeds. The old external checkout is
never touched and stays usable until the switch commits. A failed migration
removes the unfinished clone and can be retried.

Projects already Home-managed (a remote URL-only `project clone`) need no
action. Projects without a remote URL cannot be migrated; keep them as external
checkouts.

## 4. Clean up the legacy Task ref namespace

Legacy Task branches (`refs/heads/yui/task-N/...`) are archived into a
Home-scoped, non-colliding namespace before they are deleted:

```sh
yui task history list              # inspect legacy refs and their live owners
yui task history archive           # archive refs without a live Task owner
yui task history archive <task>    # archive a specific Task's legacy refs
```

The archive ref is `refs/yui/archive/<homeId>/heads/yui/task-N/...`. Two Homes
archiving the same legacy ref in a shared repository never collide because the
Home identity is part of the archive path. A ref owned by an open (draft or
active) Task is refused; complete or retire the Task first.

The archive step is idempotent: re-running it is a no-op for already-archived
refs.

## 5. Rebuild eligible Tasks or replace terminal Tasks

### Draft or active Tasks with no evidence

A Task with no Run, WorkItem, ChangeSet, or IntegrationAttempt can be rebuilt
in place. The rebuild mints a canonical workspace identity, re-creates the
managed worktrees under the identity-derived branch
(`yui/task-N-<8hex>/main`), and archives the legacy refs:

```sh
yui task rebuild <task>
```

The rebuild is resumable: a crash or failure leaves the old layout usable, and
re-running the command completes the remaining work. A dirty legacy worktree or
any evidence record blocks the rebuild.

### Terminal Tasks (completed, retired, or archived)

A terminal Task is never rewritten in place. Instead, create a draft successor
with the same Project bindings and a milestone recording the relationship:

```sh
yui task replace <task>
```

The successor is a fresh draft Task; the original terminal Task is untouched.

## 6. Verify

```sh
yui doctor          # storage and schema health
yui project list    # every Project shows the expected ownership
yui task list       # Tasks prepare under the identity-derived layout
```

## Failure handling

Every command in this sequence is safe to re-run after a failure:

- **Storage upgrade** — transactional with a backup; retry `yui upgrade`.
- **Project migration** — the unfinished managed clone is removed on failure;
  retry `yui project migrate <project>`.
- **History archive** — idempotent; already-archived refs are skipped.
- **Task rebuild** — resumable; the old layout stays usable until the rebuild
  completes.
- **Task replace** — creates a new Task; a failed attempt leaves no partial
  state.

No step leaves a half-migrated Home, a half-switched Project, or a deleted
legacy ref without an archive record.
