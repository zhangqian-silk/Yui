<p align="right"><strong>English</strong> | <a href="./provider-runtime.zh-CN.md">简体中文</a></p>

# Provider runtime

Native conversations belong to the user and Provider. Yui adds its Role Skill
and Session Manifest pointers, delivers scoped input through structured native
protocols, and records exact execution evidence. It does not mirror the complete
transcript or require every user interaction to pass through Yui.

## Component and connection

| Execution component | Connection plan | Managed transport |
| --- | --- | --- |
| `codex-cli` | `codex` | App Server WebSocket through a byte-forwarding proxy |
| `claude-code-cli` | `claude` | Persistent stream-json process |
| `claude-agent-sdk` | `acp` | ACP bridge over stdio |
| `unknown-acp-agent` | `acp` | ACP over stdio, with product identity unconfirmed |

An executable name does not prove its product identity. The component selects
one connection plan; the protocol does not infer which product is running.

## Host and Endpoint

Controller owns durable input selection and observation processing. AgentHost
owns its disposable connection and serializes requests. AgentEndpoint exposes
open/resume, submit/steer, inspect, events, cancel, detach and exit observation.
Driver maps protocol evidence into the common observation/error vocabulary.

Endpoint submission distinguishes accepted, pending, not-submitted and unknown.
Acceptance requires Provider evidence correlated to the exact owned input:
a native receipt, or a response on an exclusively owned serialized stream.
Neither bytes written, a PID nor a tmux pane proves acceptance.

Session, attachment and AgentRun identities are distinct. A Session can span
multiple explicit Runs and ordinary native chat. Goal is Session-level Provider
evidence, not a Yui Task completion state.

## Codex and Claude Code

Managed Codex connects to the shared native daemon. Host owns its proxy and
WebSocket, not that daemon or the native thread. Direct native clients may use
the same conversation; Yui waits for native availability and correlates its own
input rather than treating another client's terminal as its result.

Global Codex Roles retain the native TUI. The thin interactive Host observes
the TUI's exact thread start/resume identity and applies the reserved workspace,
Role settings, Manifest pointer and scoped CLI environment to that same native
startup request. Remote TUI flags alone are not authority for the server's
working directory; no second Thread or daemon-wide configuration is created.
A live pane alone does not establish
an authenticated Session; a dead pane is retained evidence until explicit action.

Managed Claude Code uses a persistent stream-json process, exact user-message
correlation and one local input in flight. Its first main assistant response
confirms acceptance before the final result; init, user echo and child responses
do not. Message UUIDs suppress duplicate observations, not identify native
Turns. Yui-owned generic Role context uses private files; Project Skills remain
native Project material discovered by the Agent.

Global Claude Code keeps its interactive interface and native authentication
selection. Yui forwards the configured environment and settings paths without
injecting an authentication helper or writing onboarding/key-approval records.
Native confirmation and policy remain enforced. See
[native authentication](roles-and-configuration.md#native-authentication).

Main-session tool start/result and model activity feed the same exact-input
observations for Runs and runless notifications. Tool failure ends that operation,
not the whole Agent execution. Missing activity evidence remains unobserved.
An owned Claude process exit without a result fails its current input; deliberate
cancellation records cancelled instead. Neither invents a native Turn ID.

Native observations are durably queued before asking the Controller to apply
them. Controller absence, timeout or transport loss leaves those exact facts
for normal inbox replay; it does not turn a healthy native result into a failed
Host. The eager Controller application hint has a short deadline, so an outage
does not accumulate a long synchronous wait for every native event.
Persistence or actual application-validation failures still surface as
errors. Terminal input evidence remains terminal as time passes, independently
of Task completion and later Runs.

Managed input uses structured protocols, not terminal keystrokes or prompt
glyph parsing. Terminal attachment is a presentation channel.

## ACP

ACP negotiates initialization and Session capabilities, opens or loads an exact
Session, sends prompts, observes updates and maps terminal/error responses.
Authentication requirements and unsupported operations remain explicit.
The codec must not implement another Task/Run Store or invent native Turn IDs.

Model, effort and permission requests are compiled against the peer's offered
configuration axes and checked after application. Setters can change other axes;
final observed values must still satisfy the requested launch before prompt.
New and loaded Sessions must report `configOptions` (an empty array is valid).
Configuration uses `session/set_config_option`; mode-only peers are unsupported.
An acknowledgement without current reported values cannot satisfy a requested change.
Unknown ACP products do not inherit a guessed bypass mode from another product.

Yui distinguishes three configuration layers:

1. desired Role/Agent binding;
2. frozen effective launch request;
3. live Agent-reported configuration, or `unknown` / `unsupported`.

Within observed configuration, an axis can remain `unobserved`. Inspection reads
current reports without configuring or prompting the Agent. Reported model names
are Provider evidence, not independent proof of backend model identity.

## Environments and replacement

Adopted execution environments retain their directory identity, access,
preparation and grants. Launch, resume and Yui-controlled submission recheck the
same boundary. Desired environment changes do not move a running Session or
silently fall back to managed cwd.

Read-only adoption requires actual adapter enforcement. Empty environments
cannot supply a native CLI cwd; scratch or an explicitly adopted directory can.
Trusted-local environments are not a general OS sandbox.

A Session pins the Endpoint implementation actually loaded by its Host.
New Sessions may select another implementation; existing references drain on
their own boundary. A drain deadline bounds waiting, not a guarantee that all
native descendants exit. Cleanup reports unresolved ownership honestly.

Stopping Yui's attachment does not cancel the Task, erase the native thread or
prove shared execution stopped. Unknown native effects must be resolved before
conflicting resource release. See [Session/Run](managed-turn-and-session-runtime.md)
and [Drivers](agent-runtime-drivers.md).

Task Session termination first cancels its exact unsettled input and requires
matching terminal evidence before signalling the Host or releasing occupancy.
Codex uses native interruption; Claude stops the owned execution process.
An interrupt acknowledgement alone is insufficient. If terminal evidence is
unavailable, cleanup is visibly blocked and retains the native input identity;
it does not kill the shared daemon or label unknown execution as stopped.

Dedicated Claude execution uses a small Linux child subreaper. If the CLI dies,
the kernel reparents its orphaned tools to that owner, including tools that
created another process session. The owner signals only its actual children,
reaps them, and exits only after none remain. Thus a killed CLI cannot leave a
foreground Bash tool writing while Yui reports its owned process ended.
Failure to drain remains a live ownership dependency, not false quiescence.
This is OS process custody, not a Task workflow or a claim about unrelated
external services.

The dedicated process's PID/start identity is retained as engineering control
data independently of AgentHost. Recovery never needs the old Host's in-memory
connection. For Codex, a separate metadata/control client can inspect and stop
the recorded native execution without submitting another prompt; unknown
acceptance can be abandoned after actual native quiescence without inventing a
native Turn ID or successful Run result.
Codex connection location and the account Home reported by its native handshake
are also retained without credentials. Recovery can use current executable code,
but verifies the actual native account before treating a missing Thread as
absence. An unproven connection must not turn “not found” into a stop receipt.
Control uses native runtime metadata and, when a receipt was lost, one
metadata-only Turn page rather than loading the entire conversation. Explicit
Session stop checks native Goals and background terminals even when Yui's cached
input is already terminal. It never starts another model Turn to recover.

## Verification boundary

Protocol fixtures can establish framing, configuration, correlation and scoped
persistence without calling a model. They do not prove a real peer's tool
permissions, cancellation, concurrency or long-running behavior. Real-peer
validation must name the component, connection, configuration and effects tested;
it does not imply all components support equivalent behavior.
