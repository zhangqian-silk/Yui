<p align="right"><strong>English</strong> | <a href="./plugin-sdk.zh-CN.md">简体中文</a></p>

# Standalone plugin SDK

A standalone directory can contribute Task-local capabilities through the
existing `capability` ingress without modifying the Yui installation. The
currently authenticated Leader can manage its own Task's plugins, and the global
Operator can still manage a named Task's plugins; a Worker/Reviewer keeps call
and read access but gains no management or self-trust authority. This SDK does
not implement Endpoint registration or automatic upgrades.

The Store persists the user's enable/disable selection and the exact
validation-artifact reference it points to; the Host is the sole authority for
the live instances and reference lifecycle. After a Controller restart the
selection and reports are still readable, but activation must be explicit. There
is no separate writable `active=true` ledger, no automatic execution of author
code, and no marketplace, signing platform or recovery worker.

## Ingress and environment

All management operations reuse the original Controller, CapabilityRegistry,
InstanceHost and identity ingress. Use the capabilities below inside an
authenticated managed Leader/Operator Session; an ordinary terminal cannot gain
authority by declaring `scope:user`. A development checkout must use its absolute
`output/dev/bin/yui` and explicitly select its own isolated Home; the global
installation cannot validate it.

| Capability | Input (Task bound by `--task`) | Observable result |
| --- | --- | --- |
| `plugin.create` | `preparationId, id, kind` | New directory, manifest and sample; no author code runs |
| `plugin.scan` | `preparationId, directory` | Data-only scan: manifest, file names, SHA-256 |
| `plugin.validate` | `preparationId, directory` | Immutable validation ID, source/artifact digests, environment and executed checks |
| `plugin.validation` | `validationId` | Report summary without starting code; readable by a `task:read` caller in this Task |
| `plugin.inspect` | `id` | This Task's desired selection, actual selection, Host references and most recent management failure; loads no code |
| `plugin.list` | `{}` | Current view of every explicit selection in this Task, including disabled ones |
| `plugin.activate` | `validationId` | On admission, saves the enabled selection, prepares and publishes the instance, and returns the current view |
| `plugin.disable` | `id` | Saves the disabled selection, stops new calls, and waits for actual references to drain and dispose |

`directory` may be a relative path inside the environment or an absolute
canonical path, but not the environment root, an external path, or a directory
reached through a symlink. First adopt a writable environment explicitly through
`environment.prepare/adopt`. Scratch is independent directory ownership, **not an
OS sandbox**; a user directory still needs a specific Resource grant. Every new
action rechecks the adoption record, the Task's current status, the directory
identity, the resource intent and the current Resource grant. Environment
rechecks and mainline native execution share one `resolveExecutionEnvironment`,
which requires the current grant to include that preparation's adoption record.
Issuing a single new grant after revocation does not implicitly re-adopt an old
environment.

The SDK's actual build, candidate and live instance references block a public
`environment.release`. Disable and drain first; releasing an environment never
deletes a user directory and never force-removes a non-empty scratch. Disabling a
plugin does not delete source or validation evidence, and there is no automatic
uninstall/GC.

Example (replace `T`, `P` and `V` with the actual Task, adopted preparation and
validation IDs):

```text
<checkout>/output/dev/bin/yui capability call plugin.create --task T --request-id create-1 --input '{"preparationId":"P","id":"demo","kind":"declarative"}'
<checkout>/output/dev/bin/yui capability call plugin.validate --task T --request-id validate-1 --input '{"preparationId":"P","directory":"demo"}'
<checkout>/output/dev/bin/yui capability call plugin.activate --task T --request-id activate-1 --input '{"validationId":"V"}'
<checkout>/output/dev/bin/yui capability call demo.echo --task T --input '{"hello":"world"}'
<checkout>/output/dev/bin/yui capability call plugin.inspect --task T --input '{"id":"demo"}'
<checkout>/output/dev/bin/yui capability call plugin.disable --task T --request-id disable-1 --input '{"id":"demo"}'
```

`requestId` is required for capabilities with side effects, but the SDK builds no
general idempotency ledger. Re-validating produces a new report and re-activating
adopts a new generation; after a communication error, read the current facts
before deciding whether to retry.

## Self-extension inside the original Task

The Leader first reads the current catalog and contracts through the stable
`capability search/describe` to judge whether reuse, composition or an ad-hoc
script is enough; it is not forced to create a separate plugin-development Task or
to register every script. When it chooses a plugin, it creates, validates,
repairs and activates it through the ingress above. The next bridge call can
discover and invoke the new capability without hot-patching the native tool
schema, replacing its own Endpoint or restarting the Controller.

Task-local management authority is not execution trust: an executable package
still checks the exact `plugin.execute` grant defined below phase by phase, and a
changed source does not inherit an old digest's authorization. The boundaries
around resources, network, global configuration and the core namespace are
unchanged; when existing authority is sufficient it is not re-approved, and when a
new permission is missing the specific gap is reported rather than impersonating
the Operator or self-issuing a grant.

On validation failure the Agent preserves the original error and judges the fix;
an unknown or partial effect must not be auto-rerun. After using a new capability
to obtain a real business result, save independent content as a file artifact
through `artifact.save` (it commits the `relativePath` into the Task's local Git
repository) and keep the returned `commit + relativePath` reference in the Task
result. `artifact.read` does not
depend on the plugin staying active. A successful load or a retained plugin source
is not evidence that the business loop is complete. Protocol fixtures can validate
the engineering boundary but cannot prove that a real Agent autonomously chose,
wrote and repaired it; real-scenario validation follows the project's
resource-authorization boundary.

## Desired selection and actual instance

`plugin.inspect/list` are `task:read`: they do not acquire, initialize or recover
a plugin, and they consume no grant and write no Store. In the current view:

- `desired` is the persistent selection — enabled, the pinned validationId, an
  internal revision, the selection time and an optional lastFailure. Version and
  digest are derived from the immutable validation report, not stored again.
- `actual` is the Host implementation the current Controller selects for new
  calls and its validation reference; it is null when there is no selection or it
  cannot be acquired. It is not a child-process health check and does not prove
  the current grant is still valid.
- `instances` come from the Host's observation of not-yet-released instances: the
  exact implementation, the actual reference count and whether it still accepts
  new acquires. After disable, `actual` can be null while a draining old
  reference is still listed here.
- `needsActivation` only compares the desired enabled selection with the actual
  selection; it is not an independent work state or an automatic task.

The first query of an unconfigured plugin returns `desired: null`. Disabling an
unknown plugin still saves an explicit disabled selection but with no
validationId; disabling a configured plugin keeps the original validation
reference. Every scope is the Task, and querying another Task never leaks this
Task's selection.

Activation first checks the input, the validation record's ownership, the current
source/environment, the contract/dependencies and permissions; a request that
fails admission neither creates nor changes intent. The executable grant's
consumption and the enabled selection commit in one transaction; if the
transaction fails, no author code runs, no instance is published, and the grant
consumption rolls back. If initialization or publication fails afterward, the
legally accepted desired B, the failure reason and the original actual A are
retained, letting the Agent decide to retry, replace or disable.

A failed activate/disable still returns `kind: failed` rather than faking
success; when state can be read, its `value` carries the current view above. The
most recent management failure is recorded against the intended revision, and a
late result cannot overwrite a newer selection. The revision is incremented by
the internal transaction, so the caller carries no expected token. Each new
explicit selection clears the previous management failure; existing
AgentRun/reports and business receipts are unaffected.

Disable commits `disabled` first, then synchronously removes the entry point for
new calls and waits for the original references to drain; a cleanup failure does
not reverse `disabled`. If the durable commit fails, the original instance stays
available and cannot be claimed as disabled. A diagnostic read that fails after a
successful publication also cannot unload the newly published instance. After an
error, query the current facts instead of retrying automatically. When a plugin
has concurrent management actions, the exact provider in an operation result
refers to that operation's instance, while the attached current view may already
reflect a later explicit selection.

A restart keeps only the selection and existing failure diagnosis: it does not
guess from an old report whether the plugin used to be enabled, does not replay
operations automatically, and does not pretend a historical actual instance is
still running. A case that desired B but ran A appears after restart as
desired=B, actual=null; activating B again must re-pass the current authorization
and environment checks.

## Package contract

A directory scan only parses data; it does not import author code. The current
package allows at most 256 UTF-8 files totaling 4 MiB; it rejects symlinks,
special files and binary dependencies. Every file, including dependencies, enters
the digest and validation artifact, so provide a small, self-contained,
non-secret directory rather than a tree that contains credentials, user data or a
whole development environment.

```json
{
  "id": "demo",
  "version": "1.0.0",
  "apiVersion": "1",
  "kind": "declarative",
  "entry": "entry.json",
  "capabilities": [{
    "name": "demo.echo",
    "contractVersion": "1",
    "summary": "Return JSON input.",
    "inputSchema": {},
    "outputSchema": {},
    "effect": "query",
    "requiredPermissions": []
  }],
  "required": [],
  "permissions": [],
  "reloadMode": "manual"
}
```

`id` is a single segment that starts with a lowercase letter and uses only
lowercase letters, digits and hyphens. A capability name uses the Registry's
dotted name; the core namespace (including `context`) and Provider identity
cannot be overridden. The Provider ID is produced by a trusted root from the Task
plus plugin ID. Same-named capabilities from different Providers keep the
Registry's ambiguity rule and are not overridden by load order; a call can
specify `--provider/--version` explicitly.

`required` is an exact `{name, contractVersion}` dependency list, not a version
solver. A missing, unavailable, ambiguous or cyclic dependency rejects
activation. The schema uses the Registry's existing bounded dialect, and unknown
keywords are rejected. Every `requiredPermissions` entry must belong to the
manifest `permissions`; scope is only visibility, and permission still comes from
the current caller. A Task-local plugin cannot declare `plugin:manage`.

A declarative `entry.json` must be complete and contain only the capabilities the
manifest declares:

```json
{ "demo.echo": { "type": "echo" } }
```

It supports `echo`, `constant + value`, and
`call + name + contractVersion + optional providerId`. `call` hands the original
input and requestId to one explicit dependency, returns its value, and preserves
the original operations/effect; it is not a multi-step flow engine. A declarative
package cannot declare a build and never runs arbitrary JavaScript.

## Executable contract and trust

A `kind: trusted-local`, `entry: entry.mjs` package runs in a separate Node child
process, not inside the Controller. The child process uses the explicitly adopted
environment directory as cwd, reconstructs a minimal set of environment
variables, and does not inherit the Yui Session, credentials, `NODE_OPTIONS` or
`NODE_PATH`.

The running module is loaded from the captured bytes through `SourceTextModule`;
it supports only in-package relative module dependencies, not bare package names,
`node:` or dynamic import — a needed pure-JS dependency must be bundled first.
This loader bounds where the code comes from; it is **not a malicious-code
security sandbox**. It cannot promise the host filesystem, network, processes or
secrets are unreachable. Auto-generated code without specific trust should use the
declarative path or a genuinely restricted environment instead; this SDK does not
provide that environment.

The author entry exports:

```javascript
const echo = input => input;
export function initialize() {
  return {
    handlers: { "demo.echo": async (input, api) => echo(input) },
    dispose() {}
  };
}
export function selfTest() {
  return echo("probe") === "probe";
}
```

### The author module's runtime environment

The Node child process is the host; that does not mean the author module runs in
a full Node global environment. The current module uses a separate vm context and
relies only on ECMAScript built-ins and the SDK ports below:

| Category | Current availability |
| --- | --- |
| ECMAScript built-ins such as `Promise`, `JSON`, `Math`, `Date` | Available; `async/await` and `Promise.resolve()` work |
| `console` | Visible, but not an SDK log or receipt port; child stdout/stderr is not forwarded to the caller |
| `setTimeout`, `setInterval`, `queueMicrotask` | Not provided; do not use ordinary Node timers to drive async flow |
| `structuredClone`, `process`, `Buffer` | Not provided |
| `fetch`, `URL`, `TextEncoder`, `AbortController`, `crypto` | Not provided |
| Business I/O and downstream tools | Use the handler's `api.call`, bounded by the original caller's permissions and effect |

So `await Promise.resolve()` works while `await new Promise(r => setTimeout(r, 50))`
does not. A handler that never settles triggers the 30-second child request
timeout below. The table describes the normal author API, not a security-isolation
claim; the absence of some global does not prove malicious trusted-local code
cannot reach the host. A build script is another trusted Node execution path and
is not bound by this author-module global table.

Initialization may only prepare the complete registration; it must not send,
publish or modify business data or start a background service. It receives no
business call port, and a failed initialization only closes the candidate child
process. A trusted-local author must still honor this contract, and a missing
port is not an isolation guarantee against arbitrary malicious code with direct
host access. `selfTest()` actually runs during validation and must return `true`;
the report does not treat an author test as a security certification.

The handler's `api` contains only the original `context`'s credential-free
identity, its `requestId`, and
`call({name,input,contractVersion?,providerId?,requestId?})`. There is no Store,
Host, Registry, authorizer, optional actor or `observe` port. Every nested call
rechecks the original caller and the current execution grant; permission cannot
exceed the parent descriptor's declaration, and effect cannot exceed the parent
effect. For a completed sub-action, even if the parent output schema is wrong,
throws, or cannot be JSON-serialized, the original operations, effect and receipt
locator are preserved; the real evidence still belongs to the original business
owner, such as a Job.

Trusted code should produce business effects only through these controlled ports.
A trusted-local host operation that bypasses the ports directly cannot have its
real receipt or effect scope derived by the SDK and is not covered by the
evidence guarantees above. The default single child request limit is 30 seconds;
a timeout or abnormal exit returns a failure and closes the owned child process
without retry. `dispose` must release only its own resources and not manage a
shared daemon. Any author-spawned process or host residue after a crash is not
falsely claimed as reclaimed, and this SDK provides no cross-Controller-process
recovery/sweep protocol.

### Execution authorization

An adopted directory does not grant execution of author code. Every actual
`build`, `validate`, `activate` or `call` attempt additionally requires a current
`plugin.execute` grant that pins all five parameters:

| Parameter | Value |
| --- | --- |
| `pluginId` | manifest id |
| `digest` | build/validate use the `plugin.scan` source digest; activate/call use the report's artifact digest |
| `environmentRef` | `Task/preparation` |
| `trust` | `trusted-local` |
| `phase` | an explicitly chosen subset of `build, validate, activate, call` |

Use Task scope; a home scope with an exact environment path may be added, but a
Project/repository/package scope is not accepted as a resource-trust substitute.
Because trusted-local does not bound direct host effects, this grant must allow
`irreversibilityCeiling: irreversible`: that is the capability ceiling, not a
statement that every call actually produces an irreversible effect. `none` or
`reversible` must not be read as unlimited local execution authority.

An Operator explicitly authorized by the user uses the original grant ingress,
for example to allow a single validation:

```text
<checkout>/output/dev/bin/yui task grant issue T --action plugin.execute --param pluginId=demo --param digest=SOURCE_SHA256 --param environmentRef=T/P --param trust=trusted-local --param phase=validate --max-uses 1 --irreversibility-ceiling irreversible
```

A grant is not self-issued by the SDK. Uses are consumed per real execution
attempt and are not refunded on failure; one validate includes
initialize/selfTest/dispose. A build is another execution. `call` is a short
invocation that cannot resume from a persistent step; it only increments usesUsed
and adds no permanent reservation. Its admission is held by the current call's
bound closure and cannot be exported, forged or used to continue execution after a
process restart. build/validate/activate use a persistent reservation; an
existing key is not truncated or cleaned up. A current call that has already
consumed its quota can keep rechecking, but revocation/expiry still blocks
subsequent controlled actions, and an exhausted quota allows no new call.
Long-term use does not add a new permanent key per call. A not-yet-committed
enable-intent transaction that fails is not a completed execution attempt, and
its consumption rolls back with the transaction. An ordinary disable does not
revoke an original call already executing, and revocation erases neither the
intent nor an effect that already happened.

### Build and artifacts

An executable manifest may add `"build": ["build.mjs", "arg"]`. This is an
explicit Node script and arguments, not a shell string. The build script must
live inside the captured source package; it runs in its own new temporary copy
inside the adopted environment and may use Node APIs, so it likewise requires
trusted-local trust. The builder must not depend on undeclared user secrets or
leave a background process behind.

Validation saves all bytes and the digest of the actual build artifact and
records the source digest, the Node version, the environment identity, the actual
build cwd/argv and the executed checks. A build cannot change the
manifest/permissions; with no build, the first captured bytes execute directly,
without a second read before execution. A build does not overwrite the author
source. Validation rechecks the source directory at the end and refuses to save a
success report if it has changed.

Activation rechecks the source-directory digest, the environment and the current
authorization, then initializes only from the artifact bytes in the report; it
does not rebuild or switch to another directory of the same version. A post-build
validation authorization applies to the artifact produced from the explicitly
trusted source, while a formal activate/call is authorized separately against that
actual artifact digest.

Publication rechecks the complete contribution, dependencies and permissions
again. A failure does not change the existing directory; a competing
activate/disable makes a late candidate refuse to publish. After a successful
publication, the old generation only serves existing references and is disposed
once drained. A cleanup failure is retained on that plugin's diagnostic channel
with the old generation identity, even if another replacement has already
published. It is not a Task Artifact, does not roll back the new Provider, and
does not pretend the current instance is still unpublished.

## Storage and other ingress

Validation artifacts and enable intent belong to the single Home storage
contract, and a persistent structural change follows the explicit upgrade/update
and backup mechanism. Reading a report does not infer or recover an instance, and
adopting new source does not authorize upgrading the shared Home, restarting the
Controller or executing the plugin.

One Registry projects capabilities into commands and controlled query panels
without duplicating the SDK Host; a Web query identity does not gain
`plugin:manage`. A native Session and a plugin share the environment owner, and
both native execution references and plugin references are checked before release.
A plugin provides no Project/global scope elevation and no native Endpoint
registration.
