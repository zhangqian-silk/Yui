<p align="right"><a href="./README.md">English</a> | <strong>简体中文</strong></p>

# 当前架构与文档导航

以下文档描述当前源码合同。能力边界不等于所有真实 Provider 场景已经验证。

## 阅读入口

- [English README](../../README.md)：安装、配置和日常使用。
- [中文 README](../../i18n/README.zh-CN.md)：同一产品入口的中文说明。
- [总体架构](../../ARCHITECTURE.zh-CN.md)：职责、权威和端到端流程。
- [能力、资源与 Surface](capabilities-and-resources.zh-CN.md)：扩展入口、实例所有权和资源效果。

## 领域合同

| 问题 | 当前文档 |
| --- | --- |
| Session、AgentRun、消息和激活如何配合？ | [执行与会话](../managed-turn-and-session-runtime.zh-CN.md) |
| Web 可以控制什么，queue、steer 和 interrupt 有何区别？ | [Web 权限](capabilities-and-resources.zh-CN.md#cli-与-web) · [输入时机](../managed-turn-and-session-runtime.zh-CN.md#输入时机queuesteer-与-interrupt) |
| 谁消费结果、综合与审查？ | [结果消费](../agent-result-consumption.zh-CN.md) |
| WorkItem 依赖何时满足？ | [Task 依赖](../task-dag-semantics.zh-CN.md) |
| Task 内记录如何引用？ | [局部身份](../task-local-identity.zh-CN.md) |
| Role、Profile 与运行配置如何生效？ | [角色与配置](../roles-and-configuration.zh-CN.md) |
| 怎样交付、集成和归档？ | [交付生命周期](../task-delivery.zh-CN.md) |
| Provider、ACP 与配置事实如何接入？ | [Provider Runtime](../provider-runtime.zh-CN.md) |
| 运行观察和错误由谁解释？ | [Agent Drivers](../agent-runtime-drivers.zh-CN.md) |
| 如何创建、验证与采用插件？ | [插件 SDK](../plugin-sdk.zh-CN.md) |
| 数据、升级与并发的边界是什么？ | [SQLite Store](../sqlite-control-plane-design.zh-CN.md) |
| 如何执行获授权的发布操作？ | [发布流程](../release-workflow.zh-CN.md) |
| 如何查看当前运行证据？ | [可观察性](../observability/README.zh-CN.md) |
| 哪些验证应长期保留？ | [验证策略](../testing/verification-levels.zh-CN.md) |

## 维护约定

行为变更同步修改所属合同和必要的入口说明。具体 CLI 参数以
`src/cli/commandCatalog.ts` 和命令处理器为准；公开领域类型以运行源码为准，
不另外维护一套目标模型或生成的离线副本。

每篇文档保持中英双语：`X.md` 为英文，`X.zh-CN.md` 为对应中文。行为变更时
一并更新两种语言版本，保持内容一致。

Project Skill 管理 Yui 的开发与验证规则；通用 Role Skills 管理 Agent 使用
Yui 的职责。仓库文档不替代 `YUI_HOME` 中维护的 Project Knowledge，也不授予
共享环境、真实模型或外部系统的执行权限。
