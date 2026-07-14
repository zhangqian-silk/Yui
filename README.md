<p align="right"><strong>English</strong> | <a href="https://github.com/zhangqian-silk/TaskMux/blob/master/i18n/README.zh-CN.md">简体中文</a></p>

# TaskMux

TaskMux is a local control plane for long-running native agent CLI sessions. It combines a durable task model, a single local controller, and tmux-backed Agent sessions so work can continue, recover, and delegate without hiding state in a remote service.

[![npm version](https://img.shields.io/npm/v/@zq-silk/taskmux.svg)](https://www.npmjs.com/package/@zq-silk/taskmux)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-20.17%2B%20%2820.x%29%20%7C%2022.9%2B%20%2822.x%29%20%7C%2024.x-brightgreen.svg)](package.json)

## Why TaskMux?

- **Long-running Tasks** — keep one durable mission instead of turning every Agent round into a ticket.
- **Native Agent sessions** — run Codex, Claude, or another configured CLI in real tmux windows.
- **Clear responsibilities** — Operator administers, Leader directs, Workers execute finite WorkItems.
- **Reliable local state** — serialize mutations, recover staged transactions, and rebuild derived indexes.
- **Inspectable by default** — Task context, decisions, milestones, events, and role output remain local.

## Requirements

- Node.js 20.17+ (20.x), 22.9+ (22.x), or 24.x
- Linux x64 or arm64 with glibc and an upstream Linux kernel 5.6 or newer, or a compatible vendor backport; the doctor command is the authoritative runtime probe
- A filesystem for `TASKMUX_HOME` and each external output destination that supports `statx(..., STATX_BTIME)` birth-time identity, `O_TMPFILE`, and linking that anonymous inode, with mounted and accessible `/proc/self/fd`
- A dedicated, owned real `TASKMUX_HOME` directory with exact mode `0700`. It must not be the filesystem root or your account home directory. `taskmux setup` creates missing path components at `0700`, never changes an existing directory automatically, and requires explicit confirmation from a real TTY before repairing an existing owned directory.
- tmux
- At least one native Agent CLI, such as Codex CLI or Claude Code

TaskMux ships an N-API 8 storage authority prebuild for each supported architecture. That storage authority is never compiled or downloaded during installation, and TaskMux fails early if the exact prebuild for the current platform is unavailable. Native storage and external-output publication require capability support from an upstream Linux kernel 5.6 or newer or a compatible vendor backport: `openat2(2)`, filesystem `statx(..., STATX_BTIME)` birth-time identity, `O_TMPFILE`, and linking that anonymous inode through mounted and accessible `/proc/self/fd` with `linkat(..., AT_SYMLINK_FOLLOW)` on the relevant storage or output filesystem. `taskmux doctor` is the authoritative capability probe. TaskMux does not emulate weaker primitives: native syscall `ENOSYS` and `EOPNOTSUPP` failures are normalized to `ENOTSUP`; missing or inaccessible procfd descriptor traversal is unsupported with actual `ENOENT` or `EACCES`, while only an absent raw `TASKMUX_HOME` is classified as setup missing. Runtime dependencies may still run their own platform installation steps. Musl-based distributions and non-Linux hosts are not currently supported.

## Install

```sh
npm install -g @zq-silk/taskmux
taskmux setup
```

Run `taskmux doctor` after installation: it checks the exact Node LTS line and probes `openat2`, `statx(..., STATX_BTIME)`, `O_TMPFILE`, and anonymous-inode linking through `/proc/self/fd` on an owned, real, exact-`0700` dedicated `TASKMUX_HOME`. Runtime commands fail closed without changing an unsafe home. It cannot preflight arbitrary future output filesystems; each publication checks its own destination and fails closed if unsupported. `setup` initializes `~/.taskmux`, checks tmux, and configures the default Agent and workspace. Run `taskmux` afterward to open the interactive dashboard.

## Quick start

```sh
# Create a long-running Task with its dedicated Leader.
taskmux task create "Ship the export workflow" --template feature

# Inspect current Tasks and durable context.
taskmux task board --with-roles
taskmux task context task-1 --format json

# Enter the fixed Leader session.
taskmux task enter task-1 leader
```

## How it works

![TaskMux architecture: User and Scheduler connect through the local Controller to durable files, a derived index, and tmux Agent sessions.](https://raw.githubusercontent.com/zhangqian-silk/TaskMux/master/assets/taskmux-architecture.png)

The Controller is the single mutation boundary. It starts on demand, listens only on loopback, and coordinates persistence, scheduling, Agent dispatch, and tmux state.

![TaskMux workflow: a long-running Task advances through input, Leader planning, finite WorkItems, Worker execution, durable yield, and the next Cycle.](https://raw.githubusercontent.com/zhangqian-silk/TaskMux/master/assets/taskmux-workflow.png)

## Core concepts

| Concept | Purpose |
| --- | --- |
| **Task** | A long-lived mission. It remains active until explicitly archived. |
| **Cycle** | One bounded period of Task advancement caused by input, a schedule, a role result, or inactivity. |
| **WorkItem** | A finite unit of execution with an assignee and terminal outcome. |
| **AgentRun** | One dispatched round in a native Agent session. |
| **Operator** | The persistent foreground global administrative role that translates user intent into TaskMux commands. |
| **Leader** | The fixed Task-local session that owns direction, delegation, and synthesis. |
| **Input request** | A Task-owned decision request created by the exact active Leader origin. |
| **Global Inbox** | A cross-Task query of open Task-owned input requests, not a second store. |
| **Independent role** | A Worker with its own Agent session, tmux window, and optional Git worktree. |
| **Child role** | Descriptive constraints injected into a parent role; it has no TaskMux-managed runtime. |

Each multi-Agent Role keeps independent configuration and a native session for every Agent binding, with one active Agent at a time. The foreground Operator is the active binding and running session recorded in its `GlobalRoleSessionSet`.

## Core workflows

### Request and answer a user decision

The only public input-request commands are `taskmux task input request`, `taskmux task input list`, `taskmux task input show`, `taskmux task input answer`, and `taskmux task input cancel`. The Global Inbox is the cross-Task result of `list`, not a separate record or command.

From the exact active Leader session, create a Task-owned request:

```sh
taskmux task input request task-1 \
  --question "Prioritize CSV compatibility?" \
  --choice csv="Keep CSV first" \
  --choice json="Prioritize JSON" \
  --blocks task:task-1
```

The foreground Operator can inspect the global query and record the user's decision; the originating Leader can cancel its still-open request:

```sh
taskmux task input list
taskmux task input show input-1 --task task-1
taskmux task input answer input-1 --task task-1 --choice csv
taskmux task input cancel task-1 input-1 --reason "Decision is no longer needed"
```

The request is owned by its Task and carries the exact Leader origin tuple, so only that Leader can create or cancel it. Operator delivery contains only Task/request pointers; its receipt confirms transport acceptance, not a user response. A `user-required` request never times out. An `offline-recommended` request can persist its recommendation only after the foreground Operator has remained confirmed offline for the configured interval; online or unknown presence never advances that interval.

### Delegate isolated work

```sh
taskmux task assign task-1 reviewer \
  --agent codex \
  --workspace ~/projects/app

taskmux task worktree create task-1 reviewer \
  --path ../task-1-reviewer \
  --branch taskmux/task-1-reviewer

taskmux task work-item create task-1 \
  --title "Review export edge cases" \
  --assignee reviewer \
  --topic testing

taskmux task dispatch task-1 reviewer \
  --mode new \
  --work-item work-item-1 \
  --input "Review the implementation and report blocking issues."
```

Inside the role session, finish the round with a durable result:

```sh
taskmux task yield --summary "Review complete; two edge cases need fixes."
```

### Schedule continued progress

```sh
taskmux task schedule set task-1 \
  --inactivity-minutes 60 \
  --cooldown-minutes 15 \
  --every-minutes 1440 \
  --next-at 2030-01-01T09:00:00Z
```

### Curate and archive

```sh
taskmux task milestone add task-1 \
  --title "Canary passed" \
  --summary "Export flow passed production canary checks."

taskmux task decision record task-1 \
  --title "Keep CSV as the default" \
  --rationale "It preserves compatibility for existing users."

taskmux task archive task-1 \
  --reason "Delivery complete" \
  --summary "Export workflow shipped and canary passed."
```

## Useful commands

```sh
taskmux                         # Run doctor, then open the dashboard
taskmux operator                # Enter the persistent Operator session
taskmux task board --with-roles # Inspect Tasks and role state
taskmux task context task-1     # Render durable Task context
taskmux task timeline task-1    # Read chronological Task activity
taskmux task enter task-1 leader
taskmux controller status
taskmux doctor
taskmux help task role          # Show help for one command scope
taskmux version                 # Print the installed package version
```

Append `--json` to ordinary commands for a stable success or error envelope. Inside a TaskMux-launched role session, scoped commands can omit Task and role IDs when the environment already identifies them.

## Help, completion, and updates

Use the single canonical form `taskmux help [command ...]` to inspect any command scope, for example `taskmux help task role` or `taskmux help task role rename`. Bare command groups and unknown commands print an error first, then the nearest scoped help, and exit with status 2. With `--json`, the same error remains one JSON envelope without appended help. Help groups commands by their catalog-defined purpose and preserves catalog order.

Generate path-aware completion without reading or changing TaskMux state:

```sh
taskmux completion bash > ~/.local/share/bash-completion/completions/taskmux
taskmux completion zsh > ~/.zfunc/_taskmux
taskmux completion fish > ~/.config/fish/completions/taskmux.fish
```

For a guided, persistent installation, run `taskmux completion install`. The installer always shows Bash, Zsh, and Fish. `$SHELL` only marks the recommended row; it never changes a saved path. Choose one shell per run, review its full script and activation paths, then answer `[Y/n/customize]`. Only `customize` asks for replacement paths, and TaskMux asks again before changing `.bashrc`, `.zshrc`, or a custom Fish activation file. Rerun the command to add another shell, Refresh a current script, or Repair a damaged managed installation. `taskmux completion uninstall` safely removes one selected TaskMux-managed installation.

Completion scripts and activation blocks use ownership markers, atomic replacement, and refuse symlinks or unmanaged collisions. `Installed` means those managed artifacts and any required startup block are complete on disk; a shell that was already running has not loaded a newly written startup block. After a successful managed-block install, refresh, or repair, TaskMux gives activation guidance for the selected shell. When the block is in that shell's environment-derived default startup file, it prints the corresponding `exec bash`, `exec zsh`, or `exec fish` command and distinguishes restarting the current shell from switching shell types. For a custom activation file, it instead shows a safely quoted `source` command to run from a session of the selected shell. Default Fish installation is discovered automatically and does not require this guidance. `taskmux setup` reuses the same one-shell wizard and accepts `skip`. Interactive setup/install/uninstall require a terminal and do not support `--json`; the three stdout generator commands above remain pipeline-safe and storage-independent.

`taskmux-dev` generates and installs completion for `taskmux-dev` with separate filenames, markers, and its isolated config. Completion paths are host-local: `backup` includes them, while logical `export` omits them and `import` preserves the target machine's existing records.

Use the single canonical form `taskmux version` to print the installed version. Run `taskmux update` to directly execute `npm install --global @zq-silk/taskmux@latest` with npm's normal interactive output. Update does not support `--json`.

## Local state

TaskMux stores authoritative state under `~/.taskmux` by default. Set `TASKMUX_HOME` to isolate tests or automation.

The SQLite index is derived and disposable. TaskMux refreshes derived state only at explicit Controller boundaries: startup, successful command transactions, and Scheduler scans. It does **not** watch or poll storage files. Use the CLI instead of editing TaskMux files directly when a change must take effect predictably.

Read-only semantic commands capture one callback-bounded Native snapshot. The snapshot uses the same stable-ancestor authority as writers, pins the storage root for the synchronous callback, and cannot be retained or awaited after that callback returns. Task, configuration, role, runtime, and input records fail closed when malformed; only derived text may use a last-valid rendering.

Scheduler wakeup preparation is likewise a coherent read, not a claim on a Role, session, or run. A later Role-runtime change must claim/CAS the exact prepared Role/session/run authority before any external launch or other side effect, and revalidate it afterward; the snapshot alone must not be described as dispatch ownership.

### Storage concurrency integration

`src/storage/domainTransaction.ts` is shared by the A1 writer-transaction work and the A2 read-snapshot work. A2 owns the exported `executeDomainReadSnapshot` boundary, its Native pinned-root/path-witness checks, and the outer `withNativeRootBarrier(..., "exclusive", ...)` around `executeDomainTransaction`; A1 may change recovery, staging, authoritative-path, or workspace details only inside that outer callback. Keep the Native barrier imports and release ordering intact, and do not reintroduce a SQLite-only semantic-read lock or a second independent lock around the transaction body. Read consumers must use `TaskStore.runReadSnapshot`.

The A2 barrier alone does **not** pin A1's current string-path copy, stage, and apply operations if an external actor renames the storage root while a writer is running. The combined A1/A2 change must either perform every authoritative writer effect through pinned root/parent capabilities or prove the exact storage-path identity before each effect and at transaction exit; add that combined rename/swap RED test when the writer implementation is integrated. Do not describe the outer exclusive barrier alone as complete writer rename fencing.

See [ARCHITECTURE.md](https://github.com/zhangqian-silk/TaskMux/blob/master/ARCHITECTURE.md) for the system model, persistence rules, and runtime boundaries.

## Development

```sh
npm ci
make check
```

For command-by-command testing of the current checkout without touching `~/.taskmux`:

```sh
make link
taskmux-dev help
```

`taskmux-dev` always uses `output/taskmux-cli-dev` as its isolated home and is not included in the npm package. `taskmux-dev update` updates the globally installed published `taskmux` package; it does not update this checkout, rebuild it, change the managed wrapper, or modify the isolated development data. A global npm install may replace an existing `npm link` for `taskmux`. Remove the managed launcher with `make unlink`.

## License

[MIT](LICENSE)
