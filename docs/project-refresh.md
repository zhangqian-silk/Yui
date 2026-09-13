<p align="right"><strong>English</strong> | <a href="./project-refresh.zh-CN.md">简体中文</a></p>

# Project refresh

`yui project refresh <project>` refreshes the canonical Project checkout from
the Project's configured remote and stable branch. Stable and development
branches must match. The per-Project maintenance fence covers the operation;
Task workspaces and their recorded bases are not refreshed by this command.

## Two separate facts

The checkout HEAD and a local remote-tracking ref are distinct observations.
Refresh fetches the exact branch into a unique temporary ref, compares its
commit with the remote's advertised commit, and permits only a clean
fast-forward from the original HEAD on the stable branch. Configured `HEAD`
is resolved through the remote's symbolic HEAD, never a guessed default branch.

When exactly one existing Git remote and fetch mapping manages a safe tracking
destination, refresh also updates that destination to the verified commit.
This runs even when HEAD is already current, repairing stale tracking refs
that would otherwise make ordinary Git show a false `ahead` count.

The mapping uses Git's effective fetch URL, including `insteadOf` resolution,
and full-ref exact or one-star fetch refspecs with negative exclusions. It
does not assume `origin` or `refs/remotes/<remote>/<branch>`. A configured
destination under `refs/remotes/` can be created if absent. Multiple matching
remotes/URLs, multiple destinations, another source managing the same target,
unsupported refspecs, local-branch/tag destinations and symbolic destinations
are explicitly unmanaged. Push URLs never establish fetch identity.

Only the unique mapped ref can change. Fetch does not opportunistically update
other tracking refs, fetch/prune tags, recurse into submodules, or write
`FETCH_HEAD`. Remote/upstream configuration is never rewritten. Read-only
tracking observations use the same mapping proof and return no tracking match
when it is not uniquely established.

## Results and concurrent changes

- `fromCommit`, `toCommit` and `changed` describe HEAD; `changed: false` does
  not imply that no tracking repair occurred.
- `tracking.status` is `updated` or `current` for a synchronized target,
  with its exact ref and old/new object IDs.
- `tracking.status: unmanaged` includes a reason. HEAD can still refresh
  successfully, but this is not a claim of tracking consistency.
- Once work has started, a failed refresh uses the existing nonzero
  `RUNTIME_ERROR` channel. JSON `details.refresh` retains observed HEAD,
  the verified commit when available, and the tracking result (`failed` for
  a managed target). Missing/unreadable observations are nullable. Text
  errors also state the actual partial result. Preconditions can fail
  before any mutation without a partial-result record.

Refresh rechecks the mapping, cleanliness, branch and HEAD around the update.
A Git ref transaction verifies the stable branch and compares the tracking
target against its captured old value (or absence) before writing it. A local
ref race, changed mapping, divergent checkout or fetched/advertised mismatch
fails visibly. After a fast-forward, a failed tracking update leaves HEAD at
its actual new commit; it never rolls back or overwrites a competing ref.
There is no automatic retry, replay or background synchronizer.

Temporary-ref cleanup compares the known fetched object before deletion.
An unsuccessful cleanup reports the retained ref; an interrupted/failed fetch
can report the exact temporary namespace to inspect. These are Git diagnostics,
not durable Task progress or a new recovery protocol.

The maintenance fence serializes Yui maintenance, not arbitrary external Git
commands or user edits. Checks and Git locks bound the observed operation;
they do not promise that local or remote state cannot change after observation.
Ordinary `git status` loses the false `ahead` count only when the current
branch's upstream is the tracking ref refreshed here. A different/missing
upstream is left untouched and carries no such promise.

## Scope of adoption

This operation adds no persistent Yui schema or migration. Installing code
that implements it does not itself refresh a real Project. A normal authorized
refresh applies the behavior; Task completion, integration, publication and
archive remain separate operations.
