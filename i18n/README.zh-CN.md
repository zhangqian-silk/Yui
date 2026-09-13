<p align="right"><a href="../README.md">English</a> | <strong>简体中文</strong></p>

# Yui

[![Core CI](https://github.com/zhangqian-silk/yui/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/zhangqian-silk/yui/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](../LICENSE)
![Node](https://img.shields.io/badge/node-20%20%7C%2022%20%7C%2024-brightgreen.svg)
![Platform](https://img.shields.io/badge/platform-Linux%20x64%20%28glibc%29-blue.svg)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](#参与开发)

让 Agent 持续推进你的任务，而不只是回答一轮对话。

Yui 是面向编程 Agent 的本地控制面。你只需用自然语言把目标告诉 Operator：它
识别相关 Project，区分新任务与已有任务的补充，并把每个请求整理成一个 Task，
由一个 Leader 负责规划、委派，并把结果与决策带回来。意图、进展和结果都保存
在单次对话之外，因此继续工作从 Task 开始——而不是靠你在多个终端之间搬运
上下文或凭记忆。

**亮点**

- **天生持久** —— Task、决策与结果都保存在本地的单一 SQLite 存储里，进程
  崩溃或重启都不丢，继续工作从 Task 开始，而不是从聊天记录开始。
- **一处对话，多个 Task** —— Operator 把自然语言请求变成新 Task 或已有
  Task 的补充，无需记 Task ID，也不用在多个终端之间搬运上下文。
- **每个结果都有 Leader 负责** —— 规划、拆成 WorkItem、委派给 Worker 与
  Reviewer 并闭环；你也可以随时直接和它沟通。
- **自带 Agent** —— Codex CLI、Claude Code CLI 和 ACP 通过统一边界接入，
  可替换而不丢失 Task。
- **本地优先、私有** —— 一切运行在你自己的机器上，面向单个受信任用户；
  Web 仅本地回环，包含只读视图和经认证的用户控制。
- **默认隔离** —— 仓库改动发生在受管 Git worktree 中，稳定 checkout 保持只读。

> **状态：** 尚未发布 1.0（0.15.x）。CLI 与配置在版本之间仍可能变化；每次升级
> 都会迁移有效的既有 Home。

[快速开始](#快速开始) · [通过对话管理工作](#通过对话管理工作) · [架构](#架构) · [设计原则](#设计原则)

## 快速开始

需要 Linux x64 / glibc、Git、tmux，以及 Node.js `^20.17.0`、`^22.9.0` 或
`^24.0.0`。最简单的方式是先安装 Codex CLI 或 Claude Code CLI，并确保它
已经可以使用你自己的账号正常工作。Yui 负责协调 Agent，不提供模型访问额度。

Yui 传递 Claude 的认证环境并保留原生配置目录，由 Claude 自身按本地配置
选择 API key 或登录方式。更换 Session 不会重置登录或初始化记录。首次运行时，
Claude 自身的 key 确认、目录信任等交互仍可能需要你完成。

### 1. 安装

```sh
npm install -g @zq-silk/yui
```

### 2. 自己初始化，或交给 Agent

在终端中运行交互式初始化：

```sh
yui setup
```

也可以直接告诉你正在使用的编程 Agent：

> 我已经安装了 Yui。请在交互式终端中帮我执行 `yui setup`，选择可用的
> Agent，并用 `yui doctor` 检查结果。遇到账号或需要我决定的配置时问我。

Setup 会配置与你对话的 Operator 和默认任务 Leader，并启动本地 Controller。
先用这两个角色即可开始，Worker、Reviewer 可以之后再配置。如果 Agent
没有操作交互式终端的能力，就自己运行 setup；它只负责初始配置。

### 3. 开始对话

```sh
yui operator enter
```

告诉 Operator 你想做什么：

> 我的项目在 `/absolute/path/to/app`。帮我增加 CSV 导出，先明确范围，
> 然后实现并验证。不要发布。

Operator 可以帮你登记 Project、把请求整理成 Task，再由该 Task 的 Leader
在你的要求范围内规划和执行。之后可以继续提问、修改需求，或把另一个请求
交给同一个 Operator，不必先学习 Task ID 和内部命令。

## 通过对话管理工作

### 让 Agent 识别和整理任务

新需求、补充说明和问题可以像平常一样表达：

> CSV 导出还要保留账号开头的零。另外，单独排查一下登录慢的问题，
> 优先把导出做好。

Operator 会结合已有任务判断哪些属于同一个结果，哪些应该独立成 Task，
并按 Project、类型、优先级和标签组织工作。补充需求不必另起任务，
实现中的每一步也不需要拆成 WorkItem。

Leader 负责交付：小任务可以自己完成；有独立交付价值的需求可以安排给已配置
的 Worker；需要审查时再安排 Reviewer。Agent 决定计划与分工，Controller
负责自动投递已安排的工作、观察执行、把结果送回负责人，你不必在会话之间
充当传话人。

### 用对话修改配置

继续在 Operator 对话里提出你的偏好：

> 看看我有哪些可用的 Agent 和模型，给我一套规划、实现、审查的配置建议，
> 确认后帮我应用。

Operator 会先读取实际配置和受支持的选项，再执行修改。你可以让它切换模型、
绑定另一个 Agent、调整审查偏好，或解释某个设置。它应说明改了什么、影响
后续启动还是当前 Session，以及哪些选择需要你确认，不要求你手动编辑配置文件。

### 离开后，接着做

> 现在有哪些任务还在进行？哪些需要我决定？从保存的状态继续 CSV 任务，
> 告诉我还剩什么。

需求、决策和结果独立于原生聊天记录保存。Yui 将持久更新送给 Operator，
Agent 可以重新读取任务上下文，继续兼容的 Session，或在必要时选择新的执行。
进程失败不会抹掉任务，结果不确定的投递也不会被静默重复。

想直观看进展，可以在另一个终端运行 `yui web`。本地 Web 展示同一份任务与
待回答问题，也允许发送消息、回答问题，以及显式 queue、steer 或 interrupt Task 输入。
这些经认证的 Task 控制复用 CLI 的相同操作，不是另一套需要同步的任务系统。
详见 [Web 权限](../docs/architecture/capabilities-and-resources.zh-CN.md#cli-与-web)
和[输入时机](../docs/managed-turn-and-session-runtime.zh-CN.md#输入时机queuesteer-与-interrupt)。

## 架构

在底层，Yui 把每一条持久事实都保存在同一个本地 SQLite 存储里，并让 Agent
通过小而明确的操作来读写它。下面从几个不同角度看同一套系统：

- [产品结构](#产品结构) —— 你面对的持久对象
- [工作如何流转](#工作如何流转) —— 围绕 Task 的闭环
- [用户消息流转](#用户消息流转) —— 你发一条消息时发生了什么
- [核心模块](#核心模块) —— 长期运行的运行时组件
- [分层设计](#分层设计) —— 自上而下的职责划分
- [生命周期](#生命周期) —— Task 与 WorkItem 经历的状态

### 产品结构

Yui 为你组织的东西 —— 是持久对象，而不是进程：

```text
  全局
   ├─ Operator ── 与你对话的 Agent；横跨所有 Project 与 Task
   └─ Projects
       └─ Project ── 受管的代码库 + 它的 Project Knowledge
           └─ Task ── 你要的一个明确结果
               ├─ Brief ......... 目标 · 边界 · 方法
               ├─ Roles ......... Leader（负责）· Workers · Reviewers
               ├─ WorkItem ...... 可独立验收的需求
               │     └─ AgentRun .. 一次明确请求的执行 ─▶ Result
               ├─ 消息 .......... 持久对话 + Decision
               └─ 审查 / 集成 ─▶ 验收交付
```

### 工作如何流转

```text
  你
   │  用自然语言描述工作 · 回答问题 · 细化范围
   ▼
  Operator ── 读取你的意图，然后：
   │            • 新建一个 Task，或
   │            • 把补充追加到已有 Task（follow-up）
   ▼
  Task ── 由一个 Leader 负责，闭环推进：
   │
   │   规划 ─▶ 拆解为多个 WorkItem ─▶ 交付 ─▶ 审查 ─▶ 关闭
   │
   │   每个 WorkItem 由 Leader 自己推进，或委派出去：
   │     ├──▶ Worker     另一个 Agent 来实现
   │     └──▶ Reviewer   在验收前检查结果
   │
   ▼
  结果与决策回到你这里 —— 你也可以随时直接和 Leader 沟通某个任务的细节。
```

### 用户消息流转

你发一条消息时会发生什么 —— Controller 只负责唤醒 Agent，持久记录始终在存储里：

```text
  ── 入站 ────────────────────────────────────────────────────────────────────
  你 ─▶ Operator ─▶ 记录一个 Task（新建或 follow-up）+ 一条 Message ─▶ yui.db
                                                                        │
                                                        Controller 唤醒 Leader
                                                                        ▼
  ── 处理 ────────────────────────────────────────────────────────────────────
  Leader 读取 Context ─▶ 自己动手，或委派给 Worker / Reviewer
                      ─▶ 把结果 · 决策 · 消息写回 ─▶ yui.db
                                                                        │
                                                       Controller 唤醒 Operator
                                                                        ▼
  ── 出站 ────────────────────────────────────────────────────────────────────
  yui.db ─▶ Operator 读取更新 ─▶ 回复你
```

### 核心模块

长期运行的运行时组件。你始终只和 Operator 对话，真正读写存储的是 Agent
与 Controller：

```text
  你
   │  你用自然语言和 Operator 对话
   │  （你不直接驱动 Controller 或存储）
   ▼
  Agent 会话 · 在 tmux 中
   │  Operator ── 与你对话的 Agent；把请求归入 Task
   │  Leader · Workers · Reviewers ── 规划、交付、审查
   │  每个角色通过 AgentHost / AgentEndpoint / Driver 驱动一个原生 Agent：
   │    Codex CLI（App Server）· Claude Code CLI（stream-json）· ACP
   │
   │  Agent 读取 Context 并做原子修改（yui 操作）
   ▼
  ┌─ yui.db — SQLite (WAL) · 唯一事实来源 · 每次修改一个事务
  │  Task · WorkItem · AgentRun · 消息 · 决策 · 结果
  └─ Project Knowledge · 配置
   ▲
   │  读取并记录运行事实；唤醒会话并投递工作
   │
  Controller · 每个 Home 一个
     投递 · Scheduler · Job · 能力宿主 · Web 监听
     它负责搬运工作、记录事实——但从不判断回答好坏

  Agent 在 Project 中工作：只读 checkout + 隔离 worktree。
  Web（yui web）：本地回环视图 + 经认证的用户控制。
```

### 分层设计

每一层只负责一件事，并暴露小而明确的能力，而不是固定流程：

```text
  体验层 Experience   —  你如何交互
    CLI（Operator）· Web（本地回环、经认证）· 原生 Agent 会话
    采集输入 · 展示事实 · 确认操作 · 调用能力
        ▼
  决策层 Intelligence —  谁来决定
    Operator：识别请求、划分 Task
    Leader：  规划 · 委派 · 判断 · 完成一个 Task
    Workers · Reviewers（行为来自 Role 与 Skill）
        ▼
  能力层 Capability   —  Yui 暴露的原子操作
    交付：  Task · WorkItem · Decision · Candidate · Review
    上下文：Context · Message · InputRequest · Project Knowledge
    配置：  Role · Agent 配置 · Project · Plugin
    执行：  dispatch · inspect · stop · 资源操作 · Artifact
        ▼
  执行层 Execution    —  工作实际如何运行
    AgentHost / AgentEndpoint / Driver，各自运行在 tmux 会话中
    Codex CLI（App Server）· Claude Code CLI（stream-json）· ACP
    受管 Git worktree · 采用的环境
        ▼
  内核 Kernel         —  持久权威：yui.db（SQLite，WAL）
    存储 · 身份 · 权限 · 操作事实 · 实例宿主

  ▲ 插件通过 Capability Registry 扩展能力层
```

### 生命周期

每个对象的状态只有一个权威；执行与等待是运行事实，不是额外状态：

```text
  Task      draft ─▶ active ─▶ completed ─▶ archived
                        └────▶ cancelled ─▶ archived

  WorkItem  open ─▶ accepted ─▶ retired

  Draft 只保存规划；激活后才采用交付工作区。
  普通归档需要工作已了结、worktree 干净，且不可重新打开。
```

明确授权的 force 归档可以保留未解决证据与不安全资源；它不证明交付，也不授权删除
这些资源。详见[归档合同](../docs/task-delivery.zh-CN.md#归档)。

## 设计原则

### Agent 做判断，Yui 保存工作事实

Yui 是本地控制面与上下文 API，不是固定流程引擎。Operator 识别和分流请求，
每个 Task 的 Leader 对结果负责，决定计划、委派、审查与恢复。Controller
处理投递和运行事实，不代替 Agent 判断一份回答是否足够好。

Task、消息、决策、原始执行结果和 Project Knowledge 构成持久上下文。
Agent 通过范围明确的小型 CLI 操作读取和更新它们。Session 和进程状态服务于
执行，但不替代“用户要求了什么、工作做到哪里”的任务记录。

### 把任务与对话分开

Task 表示目标，WorkItem 表示可独立验收的需求，Session 表示原生对话，
AgentRun 表示明确请求的一次执行。分开这些概念，你就能先讨论而不启动交付、
跨多次执行延续同一需求，并查看原始结果，而不把“Agent 说完了”当成“工作已验收”。

Draft 可以先保存规划，之后再采用交付工作区。涉及仓库时，修改发生在受管
worktree 中，而不是稳定的 Project checkout。Leader 对照实际范围判断结果，
组织审查和集成。

### 执行可以替换，权限保持明确

Codex CLI、Claude Code CLI 和 ACP 连接（包括 Claude Agent SDK 桥接）
通过统一执行边界接入，同时保留各自的原生能力与会话。配置里期望的值和
运行 Agent 实际回报的值分开记录，不假设不同接入方式完全等价。

Task 缺少某项能力时，Leader 可以在现有权限范围内创建、验证并显式激活
Task-local 插件。可执行插件仍需要具体执行授权；业务结果可以独立保存，
不依赖产生它的插件或 Session 一直存活。

Yui 面向一个受信任本地用户，不是 OS 沙箱，也不是远程多用户服务。发布、
授予新权限等外部效果仍需相应授权。

## 对比

|  | 只聊天的 Agent | 手动 Agent CLI + tmux | Yui |
| --- | --- | --- | --- |
| 工作能否跨会话留存 | 否 | 靠你自己记 | 持久 Task，集中存储 |
| 新请求还是补充 | 你判断 | 你判断 | Operator 自动分流 |
| 多步委派 | 手动 | 手动 | Leader → WorkItem → Worker/Reviewer |
| 中途换模型/Agent | 上下文丢失 | 手动重配 | 统一边界下可替换 |
| 并行工作隔离 | —— | 自己管分支 | 受管 Git worktree |
| 事实存放在哪 | 聊天记录 | 分散各处 | 单一 SQLite 事实来源 |

## 深入了解

[总体架构](../ARCHITECTURE.zh-CN.md)介绍端到端设计，
[文档导航](../docs/architecture/README.zh-CN.md)提供配置、执行、交付、存储和插件的
当前合同。想直接操作 CLI 时，使用 `yui --help` 查看命令。

Yui 默认将控制面数据保存在 `~/.yui`，通过 `YUI_HOME` 选择另一个实例。
切换构建或更新已有 Home 前，请查看[存储与升级](../docs/sqlite-control-plane-design.md)。

## 参与开发

完整流程见 [CONTRIBUTING.md](../CONTRIBUTING.md)，并请遵守
[行为准则](../CODE_OF_CONDUCT.md)。简而言之：源码 checkout 中从
`npm ci` 和 `npm test` 开始，阅读
`.agents/skills/develop-yui/SKILL.md` 与[验证策略](../docs/testing/verification-levels.md)。
源码构建还需要 Linux C 编译器和静态 libc 开发库，用于构建 Claude 子进程
监督器；发布的 npm 包已包含该可执行文件，安装使用时无需编译。

验证当前 checkout 时，先执行 `make install-local`，之后使用绝对路径
`<checkout>/output/dev/bin/yui`。它默认使用 checkout 内的隔离 Home，首次使用
状态命令前执行该 launcher 的 `setup`。不要用全局 `yui` 或 `make link`
验证本地修改。真实模型、付费或共享资源测试需要用户明确请求这些资源。

## 社区与支持

- 问题、缺陷与功能建议：提交
  [GitHub issue](https://github.com/zhangqian-silk/yui/issues)。
- 安全：见[安全策略](../SECURITY.md)。Yui 面向单个受信任的本地用户，不是
  OS 沙箱，也不是远程服务；涉及安全的问题请私下报告，不要公开提交 issue。

## 许可证

[MIT](../LICENSE)
