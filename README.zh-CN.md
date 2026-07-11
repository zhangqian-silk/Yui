<p align="right"><a href="README.md">English</a> | <strong>简体中文</strong></p>

# TaskMux

TaskMux 是面向长时间运行的原生 Agent CLI 会话的本地控制平面。它将持久化任务模型、单一 Controller 和 tmux Agent 会话组合在一起，使任务可以持续推进、故障恢复和并行委派，同时不把状态隐藏在远端服务中。

[![npm version](https://img.shields.io/npm/v/@zq-silk/taskmux.svg)](https://www.npmjs.com/package/@zq-silk/taskmux)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)

## 为什么使用 TaskMux？

- **长生命周期 Task**：一个持续目标对应一个持久任务，不必把每轮 Agent 执行拆成独立工单。
- **原生 Agent 会话**：在真实 tmux 窗口中运行 Codex、Claude 或其他已配置的 CLI。
- **清晰的职责边界**：Operator 负责管理，Leader 负责方向，Worker 执行有限 WorkItem。
- **可靠的本地状态**：串行化变更、恢复已暂存事务、重建派生索引。
- **默认可检查**：Task 上下文、决策、里程碑、事件和角色输出全部保留在本地。

## 环境要求

- Node.js 20 或更高版本
- tmux
- 至少一个原生 Agent CLI，例如 Codex CLI 或 Claude Code

## 安装

```sh
npm install -g @zq-silk/taskmux
taskmux setup
```

`setup` 会初始化 `~/.taskmux`、检查 tmux，并配置默认 Agent 和工作目录。之后运行 `taskmux` 即可打开交互式看板。

## 快速开始

```sh
# 创建一个长生命周期 Task，并启动其专属 Leader。
taskmux task create "交付导出功能" --template feature

# 查看当前 Task 和持久化上下文。
taskmux task board --with-roles
taskmux task context task-1 --format json

# 通过受控输入流程补充用户信息。
taskmux task input draft task-1 "优先保证 CSV 兼容性。"
taskmux task input submit task-1

# 进入固定的 Leader 会话。
taskmux task enter task-1 leader
```

## 工作原理

![TaskMux 架构：用户和 Scheduler 通过本地 Controller 连接持久化文件、派生索引与 tmux Agent 会话。](assets/taskmux-architecture.png)

Controller 是唯一的变更边界。它按需启动，仅监听 loopback，并统一协调持久化、调度、Agent 派发和 tmux 状态。

![TaskMux 工作流：长生命周期 Task 经过输入、Leader 规划、有限 WorkItem、Worker 执行、持久化 Yield 和下一轮 Cycle 持续推进。](assets/taskmux-workflow.png)

## 核心概念

| 概念 | 作用 |
| --- | --- |
| **Task** | 一个长生命周期目标，直到显式归档前都持续有效。 |
| **Cycle** | 由输入、定时、角色结果或不活跃检查触发的一段有限推进周期。 |
| **WorkItem** | 具有负责人和终态结果的有限执行单元。 |
| **AgentRun** | 原生 Agent 会话中的一次派发执行。 |
| **Operator** | 将用户意图转换为 TaskMux 命令的持久化管理角色。 |
| **Leader** | 负责方向、委派和结果综合的固定 Task 内会话。 |
| **独立角色** | 拥有独立 Agent 会话、tmux 窗口和可选 Git worktree 的 Worker。 |
| **子角色** | 注入父角色的描述性约束，不拥有 TaskMux 管理的运行时。 |

## 核心用例

### 委派隔离任务

```sh
taskmux task assign task-1 reviewer \
  --agent codex \
  --workspace ~/projects/app

taskmux task worktree create task-1 reviewer \
  --path ../task-1-reviewer \
  --branch taskmux/task-1-reviewer

taskmux task work-item create task-1 \
  --title "检查导出功能的边界情况" \
  --assignee reviewer \
  --topic testing

taskmux task dispatch task-1 reviewer \
  --mode resume \
  --work-item work-item-1 \
  --input "审查实现并报告阻塞问题。"
```

在角色会话中，以持久化结果结束当前执行轮次：

```sh
taskmux task yield --summary "审查完成；发现两个需要修复的边界问题。"
```

### 定时持续推进

```sh
taskmux task schedule set task-1 \
  --inactivity-minutes 60 \
  --cooldown-minutes 15 \
  --every-minutes 1440 \
  --next-at 2030-01-01T09:00:00Z
```

### 沉淀结果并归档

```sh
taskmux task milestone add task-1 \
  --title "灰度验证通过" \
  --summary "导出功能已通过生产灰度检查。"

taskmux task decision record task-1 \
  --title "继续使用 CSV 作为默认格式" \
  --rationale "保持现有用户的兼容性。"

taskmux task archive task-1 \
  --reason "交付完成" \
  --summary "导出功能已上线并通过灰度验证。"
```

## 常用命令

```sh
taskmux                         # 运行 doctor，然后打开看板
taskmux operator                # 进入持久化 Operator 会话
taskmux task board --with-roles # 查看 Task 和角色状态
taskmux task context task-1     # 渲染持久化 Task 上下文
taskmux task timeline task-1    # 查看按时间排列的 Task 活动
taskmux task enter task-1 leader
taskmux controller status
taskmux doctor
```

普通命令可追加 `--json`，获得稳定的成功或错误 envelope。在 TaskMux 启动的角色会话中，如果环境变量已经标识 Task 和角色，作用域命令可以省略对应 ID。

## 本地状态

TaskMux 默认将权威状态存储在 `~/.taskmux`。测试或自动化可通过 `TASKMUX_HOME` 使用隔离目录。

SQLite 索引只是可删除、可重建的派生数据。TaskMux 只在显式 Controller 边界刷新派生状态：启动、成功的命令事务和 Scheduler 扫描。它**不会**监听或轮询存储文件。需要可预测地生效时，应使用 CLI，而不是直接编辑 TaskMux 文件。

系统模型、持久化规则和运行时边界见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 本地开发

```sh
npm ci
make check
```

如需逐条测试当前 checkout，并避免写入 `~/.taskmux`：

```sh
make link
taskmux-dev --help
```

`taskmux-dev` 始终使用 `output/taskmux-cli-dev` 作为隔离数据目录，并且不会进入 npm 发布包。运行 `make unlink` 可移除受管理的 launcher。

## 许可证

[MIT](LICENSE)
