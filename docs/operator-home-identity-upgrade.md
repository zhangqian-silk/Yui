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

   `yui update` replaces an already-running Controller only after the new
   binary passes its health checks, and starts one when the Home was idle. The
   new CLI refuses to run against an older storage schema until the Home is
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
both configured branches against the advertised remote SHAs, and copies local
Yui Task/archive refs (including their objects) before switching the catalog
record. The old external checkout is never touched during migration and stays
usable after the switch. A failed verification or ref import removes the
unfinished clone, leaves the catalog external, and can be retried.

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

### Controller identity model

The same durable `homeId` is the Controller's logical Home identity. On Linux
its Unix socket is always `/tmp/yui-<uid>/<homeId>.sock`; raw `YUI_HOME`
spelling, caller `TMPDIR`, symlink aliases, mount prefixes, and path length do
not participate in endpoint identity. Every Controller start additionally
generates a random `controllerInstanceId` and reads the physical Home
directory's runtime-only device/inode identity. Its discovery record carries
the current protocol version, logical and physical Home identities, instance
id, process identity, endpoint, and secret token. Clients verify the physical
directory before connecting, and every authenticated request repeats the
protocol/logical-Home/physical-Home/instance fence for server-side
verification. Reading the discovery therefore does not parse the complete
Home aggregate on every Controller request.

Path canonicalization is still required for storage containment and lifecycle
locks, but it is no longer the Controller's identity source. Copying a Home
also copies its `homeId` and therefore represents the same logical Home, while
the new directory receives a different physical identity. A copied discovery
cannot route requests back to the original Controller, and same-host concurrent
startup is refused by the shared logical endpoint. A copied backup remains a
replacement/restore of the original identity, not a new independent Home.

The explicit `yui controller restart` operation recognizes only the immediately
previous released Controller discovery shape (protocol v3), authenticates its
PID/start identity and physical Home, stops that exact owner, and then starts
the current Controller. If discovery was lost, explicit restart can recover
only an exact same-UID Controller process whose entrypoint, physical Home, PID,
and process-start identity all match. Ordinary requests never fall back to the
old protocol and never signal an unproven process.

The archive step is idempotent: re-running it is a no-op for already-archived
refs.

## 5. Rebuild eligible Tasks or replace terminal Tasks

### Active Tasks with no evidence

An active Task with no Run, WorkItem, ChangeSet, or IntegrationAttempt can be
rebuilt in place. A Draft owns no writable workspace; activate a clean Draft
through `yui task activate` so Workspace adoption and activation commit
together. The active-Task rebuild mints a canonical workspace identity and
re-creates the managed worktrees under the identity-derived branch
(`yui/task-N-<8hex>/main`), and archives the legacy refs:

```sh
yui task rebuild <task>
yui task rebuild <task> --latest   # explicitly re-pin every remote Project
```

The rebuild is resumable: a crash or failure leaves the old layout usable, and
re-running the command completes the remaining work. After a Project migration,
the exact clean legacy worktree is also retired from its former repository only
after its branch commit has been retained in the Home repository. A dirty or
mismatched legacy worktree, or any evidence record, blocks the rebuild.
`--latest` resolves each remote-backed Project's configured development branch
again and persists its advertised SHA; omit it to retain an explicit or
previously pinned Task base.

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
yui task list       # active Tasks use the identity-derived layout
```

## Failure handling

Every command in this sequence is safe to re-run after a failure:

- **Storage upgrade** — transactional with a backup; retry `yui upgrade`.
- **Project migration** — the unfinished managed clone is removed on failure;
  retry `yui project migrate <project>`.
- **History archive** — idempotent; already-archived refs are skipped.
- **Task rebuild** — active-Task only and resumable; the old layout stays usable
  until the rebuild completes. Draft activation adopts its first Workspace
  atomically instead.
- **Task replace** — creates a new Task; a failed attempt leaves no partial
  state.

No step leaves a half-migrated Home, a half-switched Project, or a deleted
legacy ref without an archive record.
