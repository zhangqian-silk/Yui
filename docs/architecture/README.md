<p align="right"><strong>English</strong> | <a href="./README.zh-CN.md">简体中文</a></p>

# Architecture and documentation map

These documents describe the current source contracts. A capability boundary is
not a claim that every real Provider scenario has been validated.

## Start here

- [README](../../README.md): install, configure and everyday use.
- [Chinese README](../../i18n/README.zh-CN.md): the same product entry in
  Simplified Chinese.
- [Architecture overview](../../ARCHITECTURE.md): responsibilities, authority and
  the end-to-end flow.
- [Capabilities, resources and Surfaces](capabilities-and-resources.md): the
  extension ingress, instance ownership and resource effects.

## Domain contracts

| Question | Current document |
| --- | --- |
| How do Session, AgentRun, messages and activation fit together? | [Session and AgentRun runtime](../managed-turn-and-session-runtime.md) |
| What can Web control, and how do queue, steer and interrupt differ? | [Web permissions](capabilities-and-resources.md#cli-and-web) · [Input timing](../managed-turn-and-session-runtime.md#input-timing-queue-steer-and-interrupt) |
| Who consumes results, synthesis and review? | [Result consumption](../agent-result-consumption.md) |
| When is a WorkItem dependency satisfied? | [Task dependencies](../task-dag-semantics.md) |
| How are records referenced inside a Task? | [Task-local identity](../task-local-identity.md) |
| How do Roles, Profiles and run configuration take effect? | [Roles and configuration](../roles-and-configuration.md) |
| How do delivery, integration and archive work? | [Task delivery](../task-delivery.md) |
| How do Provider, ACP and configuration facts connect? | [Provider runtime](../provider-runtime.md) |
| Who interprets runtime observations and errors? | [Agent Drivers](../agent-runtime-drivers.md) |
| How are plugins created, validated and adopted? | [Plugin SDK](../plugin-sdk.md) |
| What are the data, upgrade and concurrency boundaries? | [SQLite control plane](../sqlite-control-plane-design.md) |
| How do authorized release operations run? | [Release workflow](../release-workflow.md) |
| How do I read current runtime evidence? | [Observability](../observability/README.md) |
| Which checks should be kept permanently? | [Verification policy](../testing/verification-levels.md) |

## Maintenance conventions

When behavior changes, update the owning contract and any entry-point text in the
same change. The exact CLI flags are defined by `src/cli/commandCatalog.ts` and
the command handlers; public domain types follow the running source. We do not
maintain a separate target model or a generated offline copy.

Each document is bilingual: `X.md` is the English version and `X.zh-CN.md` is the
Simplified Chinese one. When behavior changes, update both language versions
together so they stay in sync.

The Project Skill owns Yui's development and validation rules; the generic Role
Skills own how an Agent uses Yui. Repository documents do not replace the Project
Knowledge maintained under `YUI_HOME`, and they do not grant execution access to
shared environments, real models or external systems.
