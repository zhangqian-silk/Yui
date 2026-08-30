# Managed Provider Runtime

Yui treats a provider conversation as the user's conversation. It adds the
Role's Yui Skill and a pointer to the Session Manifest, then uses provider-native
requests to deliver durable Task work. Yui does not own the transcript and does
not require the user to route every interaction through Yui.

Task state and conversation state have different responsibilities:

- Codex or Claude owns messages, turns, tool activity, and native history.
- Yui owns Tasks, WorkItems, Runs, workspaces, durable messages, and delivery
  receipts.
- The Role Skill tells the Agent when and how to read or update Yui through the
  ordinary `yui` CLI.

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

Yui's internal authority epoch fences only Yui's own submissions and retries.
It is not a claim that Yui is the only client allowed to use the conversation.

## Codex: ordinary shared-daemon threads

Managed Codex connects through `codex app-server proxy` to the same App Server
daemon used by normal Codex clients. It never starts a per-Role
`codex app-server --stdio` writer.

Before opening a proxy, Yui may call the idempotent `app-server daemon start`
with Task-specific environment removed. It never calls daemon restart/stop in
response to a thread or Turn error.

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
by the Task Role Session Set. It is a normal App Server thread, so Desktop may
list, open, resume, and interact with it directly.

If Desktop or another client already has an active Turn on that thread, Yui
classifies its own attempted delivery as `busy`. The Run and mailbox batch stay
pending and are retried after the native Turn settles. Direct user activity is
not recorded as a failed Yui Run and never causes Yui to restart the shared
daemon.

Disconnecting or terminating Yui's proxy ends only that client attachment. It
does not stop the shared daemon or delete/archive the thread.

The daemon-sharing boundary is `CODEX_HOME`. Agent bindings that require a
different account or process-level Codex configuration must use a distinct
`CODEX_HOME`; Yui does not pretend those settings can be isolated per thread.
A Yui Agent Profile is thread-compatible because its Skills/instructions are
referenced by the Task message and its model/effort are copied into Role thread
settings. A Codex native config profile is process configuration, so Managed
Codex rejects it instead of silently applying it to the proxy or leaking it to
other threads. Interactive and non-Yui Codex sessions keep their normal profile
behavior.

## Claude Code: independent structured process

Managed Claude continues to use a persistent `--input-format stream-json` and
`--output-format stream-json` process with replayed user messages. Yui
preallocates the native Session ID and accepts a submitted Turn only after
Claude replays the exact user message for that Session.

The tmux view/takeover gateway remains useful for providers whose managed
conversation is attached to an independent process. Codex users normally open
the shared thread in Desktop instead; no Yui takeover is required.

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

| Observation | Decision |
| --- | --- |
| Thread has Yui's exact persisted active Turn | Reattach and continue observing it |
| Thread has another client's active Turn | Wait; retain pending Yui work |
| Yui's persisted Turn is terminal in native history | Fold the recovered terminal exactly once |
| Thread exists and is idle | Resume and deliver the pending input |
| Thread is exactly missing | Require an explicit conversation replacement decision |
| Availability or delivery is unknown | Preserve identity and require bounded retry/attention |

A missing proxy, dead pane, timeout, or daemon disconnect is not proof that a
thread is missing. Yui reconnects through the normal proxy path and never uses
a business-request failure as a reason to restart or stop the shared daemon.

## Required invariants

1. A Yui delivery intent exists before its provider write.
2. Provider acceptance carries an exact native Turn identity.
3. Ambiguous delivery is never automatically duplicated.
4. A busy ordinary thread keeps Yui work pending instead of failing the Run.
5. Exact missing evidence is required before replacing a conversation.
6. Yui Skill/config is thread-scoped and does not mutate global Codex config.
7. Yui may end its own proxy attachment but never stops or restarts the shared
   Codex daemon as a response to a thread error.
