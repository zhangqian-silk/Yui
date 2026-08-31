# Managed Provider Runtime

Yui treats a provider conversation as the user's conversation. It adds the
Role's Yui Skill and a pointer to the Session Manifest, then uses provider-native
requests to deliver durable Task work. Yui does not own the transcript or
require every user interaction to pass through Yui.

Task state and conversation state have different responsibilities:

- Codex or Claude owns messages, turns, tool activity, and native history.
- Yui owns Tasks, WorkItems, AgentRuns, workspaces, durable messages, and
  delivery receipts. The active AgentRun is the only durable answer to whether
  a Role has workflow work in progress.
- A Provider binding owns Conversation, Activation, authority, and Turn facts.
  A Turn carries its Run id only as correlation evidence; the Conversation does
  not expose or maintain a second "current Run" state.
- The Role Skill tells the Agent when and how to read or update Yui through the
  Session Manifest's exact `YUI_SESSION_CLI` entry point.

## Components

| Component | Responsibility |
| --- | --- |
| Controller | Schedule durable Task work and retain exact delivery intent |
| Agent Host | Keep one Yui client attachment alive and relay structured requests |
| Provider Adapter | Start/resume a native conversation and submit or inspect Turns |
| Provider conversation | Hold the user-visible transcript and native execution history |

The normal delivery path is:

```text
Task/Message -> Yui Run + delivery intent -> ordinary provider Turn
                                             |
                                             +-> exact native Turn receipt
```

Yui's internal authority epoch fences only Yui's own submissions.
It is not a claim that Yui is the only client allowed to use the conversation.

## Codex: ordinary shared-daemon threads

Managed Codex establishes the App Server WebSocket protocol through the
byte-forwarding `codex app-server proxy` and reaches the same native daemon used
by interactive Codex clients. The daemon owns the thread and its writer state.
The Agent Host owns only its disposable proxy process and WebSocket attachment.

The shared daemon must already be available through the installed Codex client.
Yui never starts, restarts, or stops it in response to a Task, thread, or proxy
error; daemon/CLI repair remains outside Task lifecycle recovery.

For a new Role conversation Yui calls `thread/start` with:

- the Role workspace and configured model/effort/permission settings;
- the Role's runtime workspace roots; and
- the small config overrides already selected for that Role.

The ordinary Task message carries the Session Manifest pointer. The manifest
points to `yui-runtime` and the matching Role Skill such as `yui-leader`,
`yui-worker`, or `yui-reviewer`. This keeps the user's native developer
instructions intact. No Yui-specific hook configuration is written to the
user's global Codex config.

The returned `threadId` is the Role's native Session identity already retained
by the Task Role Session Set. It remains an ordinary Codex thread that is
visible and directly usable in Desktop. Yui does not require a takeover to use
it from another native Codex client.

If an already-running native Turn is observed while Yui resumes a thread, Yui
classifies its attempted delivery as `busy`. The Run and mailbox batch stay
pending until that native Turn settles.

An Agent may declare a Yui Run outcome before the native Provider reports its
Turn terminal. Yui accepts that semantic outcome immediately, but keeps the
next mailbox intent pending until the old native Turn settles. It then claims
the next AgentRun and submits it through the same Session. No Provider state is
rebound while the old Turn is active, and no mailbox intent is rolled back.

If a proxy disconnects, the Agent Host may attach a bounded replacement client
and resume the same thread from exact native history. Task execution stop
terminates the Agent Host and proxy, but leaves the shared daemon and native
thread untouched. Start creates a new proxy attachment. A failed fresh
attachment is stopped and its launch reservation is released; it cannot leave
`runtimeCleanupPending` as a prerequisite for the next attempt.

A Codex native config profile is rejected for Managed Codex because it cannot
be scoped to one shared-daemon thread. Role model, effort, permissions,
workspace, and shell settings remain thread-scoped. Yui never mutates the
underlying Codex config.

## Claude Code: independent structured process

Managed Claude continues to use a persistent `--input-format stream-json` and
`--output-format stream-json` process. Yui preallocates the native Session ID,
and Agent Host is that process's sole input writer. A completed pipe write
accepts the Turn; the later Claude `result` event settles it. Provider Turn IDs
are opaque correlation values rather than path-safe Yui identities.

The tmux view/takeover gateway remains the human-control boundary for providers
with an independent managed process, such as Claude. Codex users operate the
ordinary shared thread directly in Desktop.

## Delivery outcomes

Before Yui writes a Task-owned input, it records the delivery intent. The
provider result is one of:

- `accepted`: the provider returned an exact native Turn identity;
- `busy`: another ordinary client has an active Turn, so Yui keeps the work
  pending;
- `rejected`: the provider definitively rejected the input before creating a
  Turn; or
- `delivery-unknown`: the write may have happened but no exact receipt was
  observed.

`delivery-unknown` is never retried automatically. `busy` is safe to retry
because the provider proved that Yui's requested Turn was not created.

## Recovery

Conversation recovery uses provider-native evidence:

| Observation | Available Agent choice |
| --- | --- |
| Thread has Yui's exact persisted active Turn | Reattach and continue observing it |
| Thread has another client's active Turn | Wait; retain pending Yui work |
| Yui's persisted Turn is terminal in native history | Fold the recovered terminal exactly once |
| Thread exists and is idle | Resume and deliver the pending input |
| Driver proves the thread is missing, ended, expired, or out of context | Settle the current Run, explicitly stop the exact Session/Host, then dispatch a new Run on a new Session; the complete prior error and identities remain readable |
| Availability, capacity, or `429`; input was accepted and Session is recoverable | Submit a new Turn in the same Session when useful |
| Delivery is unknown | Inspect native history and preserve identity; do not blindly duplicate the input |

A dead pane, process exit, timeout, or App Server disconnect is not proof that
a thread is missing. Yui may replace its owned process, but it replaces a
thread only after exact Driver evidence that the native conversation is dead
or cannot continue because its context is exhausted.

## Required invariants

1. A Yui delivery intent exists before its provider write.
2. Provider acceptance carries an exact native Turn identity.
3. Ambiguous delivery is never automatically duplicated.
4. A busy ordinary thread keeps Yui work pending instead of failing the Run.
5. A replacement conversation is created only after the responsible Agent
   explicitly ends the old Session; Core never replaces it as error policy.
6. Yui Skill/config does not mutate global Codex config.
7. Task stop owns and terminates every Yui Agent Host and proxy without treating
   the shared Codex daemon or native conversation as Task cleanup.
8. Provider runtime state never decides whether a Role may own an AgentRun.
9. TaskRole carries desired configuration only; displayed activity is derived
   from AgentRun and cannot become another writable scheduling state.
