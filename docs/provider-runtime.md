# Managed Provider Runtime

Yui treats a provider conversation as the user's conversation. It adds the
Role's Yui Skill and a pointer to the Session Manifest, then uses provider-native
requests to deliver durable Task work. Yui does not own the transcript. Writes
to a live managed Role go through Yui's control boundary; after Task execution
stops, the native conversation remains available to its Provider clients.

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

## Codex: Yui-owned App Server processes

Managed Codex starts one direct `codex app-server` child for a live Role
runtime. The Agent Host owns that process group, so a Task execution stop ends
the complete Yui runtime without depending on or changing Codex's shared daemon.
Starting execution creates a new owned runtime process. Native thread history
remains in Codex and durable Task state remains in Yui.

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
by the Task Role Session Set. It remains a normal Codex thread and may be listed
or inspected by Codex clients, but concurrent outside writes to a live
Yui-managed Role are unsupported. Use Yui's view/takeover boundary or stop Task
execution before another client resumes the thread.

If an already-running native Turn is observed while Yui resumes a thread, Yui
classifies its attempted delivery as `busy`. The Run and mailbox batch stay
pending until that native Turn settles.

If the direct App Server disconnects, the Agent Host may start a bounded
replacement process and resume the same thread from exact native history.
Stopping Task execution instead terminates the Host and child process group;
it does not delete or archive the native thread.

Because each App Server is process-isolated, a Codex native config profile and
other process-level Role configuration can be applied without leaking to other
managed or interactive threads. Yui never mutates the underlying Codex config.

## Claude Code: independent structured process

Managed Claude continues to use a persistent `--input-format stream-json` and
`--output-format stream-json` process with replayed user messages. Yui
preallocates the native Session ID and accepts a submitted Turn only after
Claude replays the exact user message for that Session.

The tmux view/takeover gateway is the supported human-control boundary for a
live managed Provider process, including Codex and Claude.

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

A dead pane, timeout, or App Server disconnect is not proof that a thread is
missing. Yui may replace its owned process, but it never replaces a thread
without exact Provider-native missing evidence.

## Required invariants

1. A Yui delivery intent exists before its provider write.
2. Provider acceptance carries an exact native Turn identity.
3. Ambiguous delivery is never automatically duplicated.
4. A busy ordinary thread keeps Yui work pending instead of failing the Run.
5. Exact missing evidence is required before replacing a conversation.
6. Yui Skill/config does not mutate global Codex config.
7. The Agent Host owns every Provider child process used by its Role runtime;
   Task stop can terminate that runtime without a shared service dependency.
