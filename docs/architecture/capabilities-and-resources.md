<p align="right"><strong>English</strong> | <a href="./capabilities-and-resources.zh-CN.md">简体中文</a></p>

# Capabilities, resources and Surfaces

## One ingress, original facts

The Controller hosts the CapabilityRegistry and InstanceHost. `capability
search`, `describe` and `call` use one authenticated ingress: it first resolves
the current Session identity and Task scope, then checks capability and resource
permissions. An actor supplied in the input, or a self-declared user scope,
cannot grant permission.

A descriptor carries its name, contract version, Provider, scope, input/output
schema, effect and requiredPermissions. A query shows only the authorized
catalog; when a Provider or version is ambiguous, the caller selects explicitly
rather than relying on load order. The schema is a bounded dialect, and unknown
keywords are rejected.

The current catalog covers context, message, artifact, environment, resource,
project, plugin and selected task/job operations. Task lifecycle and some CLI/Web
writes share domain commands directly; these are not a second business state and
do not pretend to have run through the Registry.

## Effects and operation facts

A capability's return value is separate from its real effect. A call can produce
a confirmed sub-operation even when its output validation fails, so the returned
result must preserve the original owner's operationRef and receipt. Unknown must
not be read as "did not run," and there is no automatic fallback.

A nested call rechecks current permissions and cannot widen the permissions or
effect the parent call declared. A requestId identifies the call; it does not
supply universal idempotency for every downstream operation — an owner such as a
Job runs its own exact idempotency contract. After an error, read the original
operation facts before deciding the next step.

## Implementation instances

InstanceHost manages attach, acquire, release, detach and the actual references.
After a replacement is published, new calls select the new implementation while
existing references stay bound to the original one and can be disposed only once
drained. A query is an observation; it does not start or recover code. A cleanup
failure keeps its diagnosis, does not reverse a new publication into a failure,
and does not fake a drain.

A Session's long-lived reference is pinned by the actual AgentHost to the
implementation it loaded. The Controller carries an existing pin forward and does
not silently move a live Session onto different code. Ending a client and the
shared Provider's physical quiescence are judged separately.

## Projects and workspaces

A Project stores its reference checkout, Knowledge and resource references. The
stable checkout is read-only; Task delivery happens in a managed worktree. A
multi-Project Task uses independent Git roots and explicit write scopes. A
workspace owner is a Task, WorkItem, ReviewRound or IntegrationAttempt. A Role
only selects execution configuration; it does not independently own a separate
workspace state.

Git integration captures an exact ChangeSet and advances the target by
compare-and-swap after its checks pass in a candidate worktree. A conflict,
failed check, moved target or rejection never advances the target, and the Agent
chooses the next action.

## Artifacts and environments

- `artifact.save/read/list` maintains file/directory deliverables — complete
  plans, prototypes, charts, reports — in the Task's own local-only Git
  repository. `save` writes a `relativePath` and commits exactly that path,
  returning a self-certifying `commit + relativePath` reference; `read` resolves
  HEAD or a pinned commit for frozen evidence; `list` is an ordinary current
  read. A reference is not a fixed delivery result; a final result cannot select
  a missing or cross-Task artifact.
- `environment.prepare` prepares an empty, scratch or authorized local directory
  without adopting it automatically.
- `environment.adopt` rechecks identity, resource intent, permissions and
  conflicts, then records ownership.
- `environment.bind` selects a Role's next native execution environment; `null`
  returns to the managed workspace.
- `environment.release` checks the real references and quiescence evidence and
  never deletes a user directory.

An adopted native launch retains the directory's identity, access, isolation and
preparation reference, and rechecks them at launch, resume and the Yui input
boundary. Revoking a grant cannot silently re-adopt an old environment on the
strength of a new grant. Read-only environment support depends on the adapter; a
directory access label is not a general OS sandbox.

## Plugins and self-extension

A Task Leader or the global Operator can manage that Task's plugins; a
Worker/Reviewer cannot self-manage or self-trust them. A declarative plugin runs
no arbitrary code; executing a trusted-local plugin additionally requires a grant
scoped to the exact source or artifact digest, environment and phase.

The Store keeps the enabled intent and validation artifacts, and the Host keeps
the actual instances. After a restart the enabled selection is still readable,
the actual instance can be empty, and activation must be explicit. The original
Task can discover and call the new capability without rewriting its own native
tool schema. A business result should be saved as an Artifact rather than
depending on the plugin staying alive.

See the [Plugin SDK](../plugin-sdk.md) for the full authoring, authorization and
failure contract.

## CLI and Web

A Surface contribution is derived from the Registry's currently authorized
catalog; there is no second catalog or Host. A CLI contribution uses the
capability's original name. A Web panel accepts only controlled text, an HTTP(S)
link or a JSON query description — not author scripts or arbitrary HTML.

The Web listener is started and stopped by the Controller and allows loopback
only (`127.0.0.1`, `::1` or `localhost`; default port 4173). `yui web` opens this
local surface, not a remote multi-user service or an OS sandbox.

The page supplies a token that authenticates all HTTP API reads and writes via
`x-yui-web-token`; the server also checks the loopback Host. These controls act
as the trusted local user, not a Role selected by the request body. They support
Task metadata edits, messages, InputRequest answers, and explicit
`queue / steer / interrupt` for Task or Global Roles. Managed Agent capability
RPC retains its own Session authentication and scope; a browser token is not
a way for an Agent or plugin to bypass those boundaries.

Read-only dashboard, Context and query-panel projections remain separate from
these mutations. A query panel cannot borrow the browser's user authority to
mutate state or manage plugins. Task controls share the public CLI's domain
commands; Global Role controls share the Global handler but currently lack a
registered top-level CLI path. Message submission intent
(`record / discuss / develop`, default `discuss`) is
separate from [input timing](../managed-turn-and-session-runtime.md#input-timing-queue-steer-and-interrupt).
Transport acceptance does not establish implementation or Task acceptance.

A browser write uses an existing domain transaction. Errors distinguish proven
`not-submitted` from `unknown`, which can include an already-committed Message
whose native delivery failed or is unconfirmed. Read the original Message,
control receipt and current Session before choosing recovery; do not blindly
resubmit under a new request ID or switch actions.

A terminal WebSocket checks the token and same-origin handshake. It attaches a
client without taking over durable conversation ownership, and respects the
connection's `readOnly` flag. A terminal attachment is not a grant to control a
different Session.
