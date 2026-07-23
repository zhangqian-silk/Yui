<p align="right"><a href="../README.md">English</a> | <strong>简体中文</strong></p>

# Yui

Yui 是一个用于长期 Codex/Claude 工作的本地编排器。控制状态保存在可检查的 JSON 文件中，所有 Agent 终端完全由 tmux 主导，带 Repository 的 Task 使用确定性的 Git worktree。

当前实现恢复了实用的 Role/Agent/session 模型和 CLI 框架，但没有恢复后期膨胀的数据维护、租约、定时调度和恢复账本体系。

## 环境要求

- Node.js 20.17+、22.9+ 或 24.x
- Git
- tmux
- Codex CLI 或 Claude Code CLI

## 初始化

```sh
npm install -g @zq-silk/yui
yui setup
yui doctor
```

`setup` 是交互式的：检测已安装的 Agent CLI、选择要配置的 Agent、默认 Agent 和 Operator Agent、确认 Operator workspace，并询问 shell completion。再次运行不会删除已有 Task/Role，可用于调整配置。

`completion` 无论是否指定 shell，都会进入确认流程：

```sh
yui completion
yui completion zsh
```

流程会确认生成脚本、安装路径和 shell 启动文件修改。补全脚本直接由命令目录生成，支持二级及更深层子命令。

默认 home 是 `~/.yui`。隔离环境可设置：

```sh
export YUI_HOME=/absolute/path/to/yui-home
yui setup
```

home 中包含 `schema.json`、权威 `state.json`、Controller 发现文件和受管理 worktree。当前存储版本严格匹配且 fresh-only；代码保留了未来版本的迁移注册表，但本版不迁移旧格式。

## 快速开始

```sh
yui repository add app /absolute/path/to/app --base main
yui repository list

yui task create "交付 CSV 导出" --repository <repository-id> --base main
yui task update <task-id> --priority high --tags release,csv --due-at 2026-08-01T00:00:00Z
yui task update <task-id> --clear-priority --clear-tags --clear-due-at
yui task show <task-id>
yui task context <task-id>
yui task activate <task-id>
```

查看已有 Task 的详细状态时，优先使用 `task context`。它一次聚合 Task、Brief、Active Decision、最近的 Milestone、Role、当前及最近的 WorkItem 与关联 Run、最近的 Message、Open/Resolved InputRequest 和 Event。终端输出会精简历史和长文本；`yui --json task context <task-id>` 会在顶层 `data` 中返回完整记录。

新 Task 是 Draft，并已创建 Leader。激活时会排入第一次持久 Leader wake。带 Repository 的 Task 会先为每个 Role 创建 `<YUI_HOME>/worktrees/<task-id>/<role-name>`，对应分支为 `yui/<task-id>/<role-name>`，然后才启动 Leader；后续新增 Role 也会在执行前获得独立 worktree。

通过 Operator 提交消息：

```sh
yui operator submit "比较 CSV 与 JSON 的兼容性" --task <task-id>
yui operator submit "研究更小的缓存设计"
yui operator enter
```

不带 `--task` 时会创建新 Draft。Draft 可以继续规划，但激活前不会执行 Agent 工作。

添加 Worker 并派发 WorkItem：

```sh
yui task role add <task-id> implementer --agent codex
yui task role list <task-id>

yui task work create <task-id> "实现导出器" --role implementer
yui task work dispatch <work-item-id> --input "完成实现并运行聚焦测试"
```

Worker 显式结束当前 Run：

```sh
yui task run yield <run-id> --summary "导出器已完成，聚焦测试通过"
```

yield 会原子完成 Run 和 WorkItem、追加结果消息并唤醒 Leader。Leader 不会自唤醒；Leader 忙碌时，Operator/Worker 的 pending wake 会一直保留到 Leader 空闲。

当活动 Leader Run 必须获得用户决定才能继续时，可以创建持久 InputRequest，并 yield 当前 Run：

```sh
yui task input request <task-id> --question "默认使用哪种格式？" \
  --choice csv="CSV" --choice json="JSON" --blocks work-item:<work-item-id>
yui task input list
yui task input show <input-id>
yui task input answer <input-id> --choice csv
```

请求默认必须由用户回答，并保持开放直到回答或取消。当 Agent 存在安全的推荐方案时，可以为选项设置明确的超时回退：

```sh
yui task input request <task-id> --question "默认使用哪种格式？" \
  --choice csv="CSV" --choice json="JSON" \
  --recommend csv --timeout-seconds 300
```

推荐项会明确展示给用户；如果截止时间前没有回答，第一轮到期后的 Controller 扫描会原子采用这个确定选项，并排队恢复固定的 Leader session。自由文本和必须由用户回答的请求永远不会自动解决。

`task input list` 是权威的全局开放输入 Inbox；可附加 Task ID 限定范围，或使用 `--all` 查看已回答和已取消的请求。Controller 还会尝试向已经运行且处于输入状态的 Operator composer 投递一次带回执的提示；它不会为了通知而启动或打断 Operator。Operator 不在线或正忙时，请求仍保留在 Inbox，并在后续 Controller 扫描时重新尝试。用户和 Operator 都可回答。存在开放请求时，无关的 pending wake 不会绕过等待，Task 也不能 complete 或 archive。原 Leader 也可执行 `yui task input cancel <task-id> <input-id> --reason "..."`，取消不会使 Leader 自唤醒。

```sh
yui task context <task-id>
```

需要查看单个集合或记录时，再使用 `task work`、`task message`、`task run` 和 Task Knowledge 下的细分命令。

完成目标后，可将 Task 标记为 completed，从而停止自动唤醒，同时保留 session 和各 Role worktree：

```sh
yui task complete <task-id> --summary "CSV 导出已交付并验证"
yui task reopen <task-id>
```

completed Task 在显式 reopen 前会拒绝消息、派发、进入 session、重试和迟到的 yield。archive 仍是终态，并负责 tmux/worktree 清理。
Task 生命周期的交互选择只展示有效来源状态：activate 只展示 Draft，complete 只展示 active，reopen 只展示 completed。

## Session 与 tmux

Yui 不代理交互式 Agent 终端。执行 `operator enter`、`role enter` 或 `task enter` 前，Yui 会关闭 readline、退出 raw mode、暂停自身 stdin，再同步把终端交给 tmux。因此 Codex 原生的 `/model`、斜杠命令提示、全屏渲染和按键处理都可正常工作。

```sh
yui role enter <global-role>
yui task enter <task-id> [role]
yui task role enter <task-id> <role>
```

每个 Role 可绑定多个 Agent，有一个 active Agent，并为每个 Agent binding 独立保存 native session。切换 Agent 会保留休眠 session；Role 有活动 Run 或 native process 时禁止切换。

Claude 的 session ID 在启动前分配。受管理的 Codex 启动使用 Codex 结构化 `notify` 回调，在 turn 完成后记录 thread ID，不再向模型对话注入 session-bind prompt。

## Controller 与失败处理

每个 `YUI_HOME` 有一个后台 Controller：

```sh
yui controller status
yui controller stop
yui controller restart
```

`controller restart` 会用当前安装的 Yui 版本替换 Controller 进程及其调度循环、socket 服务，不会停止或重启已受管的 tmux/Agent 会话。

## 本地 Web Dashboard

默认在 loopback 地址启动只读 dashboard：

```sh
yui web
# Yui web dashboard: http://127.0.0.1:4173
```

可用 `--port <port>` 或 `--host 127.0.0.1|::1|localhost` 修改监听参数。Yui 会拒绝非 loopback host；Web 界面无需认证，因此只允许本机访问，并且不会写入 Yui 状态。所有变更仍通过 CLI 或 Agent session 完成。

Dashboard 支持 English 与简体中文，首次打开时跟随浏览器语言，也可以手动切换并记住选择。主题选择器可在深色「控制室」和浅色「纸本台账」之间切换。语言与主题偏好只保存在浏览器 `localStorage`，不会修改 `YUI_HOME`。

完整 reconciliation 默认每 30 秒执行一次；持久状态变化仍会立即请求一次扫描。保留的闭环为：

1. 准备 active Task 的 repository workspace；
2. 停止 archived Task 的 tmux，并只清理干净 worktree；
3. 投递排队的 Worker Run；
4. 检测活动 Role 进程退出；
5. Leader 空闲时投递 pending wake。

自动输入只通过 tmux 投递，并先进行 Agent 专属 readiness 检查。pane 内 receipt 可避免 Controller 重试时重复输入同一 Run。

Role 在 yield 前退出时，Controller 会失败对应 Run 和 running WorkItem，并唤醒 Leader。恢复状态通过精简的 Jobs 兼容视图呈现：

```sh
yui jobs list
yui jobs retry leader-recovery:<task-id>
yui task reconcile <task-id>
yui task run retry <failed-run-id>
```

`jobs` 不是旧版通用队列，只展示持久 Leader wake 和 Leader recovery failure。

completion 是可逆的执行屏障。归档是终态：失败活动 Run、停止 Task 的 tmux session，并逐个移除干净的 Role worktree；脏 Role worktree 会保留，供人工确认处理。

## 管理命令

```sh
yui update
yui agent add|list|show|update|remove
yui role add|list|show|update|remove|bind|enter
yui role session record|replace
yui repository add|list
```

Agent 环境变量绑定只保存进程环境变量名，不保存 secret 值；raw args 不能覆盖 adapter 管理的生命周期参数。

## 范围

Yui 面向一台机器上的一个受信任本地用户。它的 Web/API 仅支持 loopback 只读访问，不包含远程或多用户 Web、分布式协调、backup/import/export、trash/restore、derived index、recovery journal、runtime lease、inactivity TTL、cooldown 或 recurring schedule。

持久化和调度细节见 [ARCHITECTURE.md](../ARCHITECTURE.md)。

## 本地开发

```sh
npm run build
npm test
npm run lint
```

## 许可证

[MIT](../LICENSE)
