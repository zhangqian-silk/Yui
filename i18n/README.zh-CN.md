<p align="right"><a href="../README.md">English</a> | <strong>简体中文</strong></p>

# Yui

Yui 是一个用于长期 Codex/Claude 工作的本地编排器。控制状态、Project Catalog 和项目知识保存在可检查的 JSON 文件中，所有 Agent 终端完全由 tmux 主导，带 Project 的 Task 使用确定性的 Git worktree。

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

`setup` 是交互式的：检测已安装的 Agent CLI、选择要配置的 Agent、默认 Agent 和 Operator Agent，分别配置 Leader/Operator Role 的模型与思考强度，确认位于 Yui home 外部的 Project workspace，并询问 shell completion。模型或思考强度留空会保留当前值；输入 `default` 可恢复为原生 CLI 默认值。再次运行不会删除已有 Task/Role，也不会改变当前安装的 Project workspace，可用于安全地调整配置。

模型与思考强度属于 Role 设置，因此 Leader 与 Operator 即使使用同一个 Agent CLI，也可以采用不同配置。其他 Role 可通过 `role add`、`role update`、`task role add` 或 `task role update` 的 `--model` 和 `--effort` 配置。

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

home 中包含 `schema.json`、权威 `state.json`、Project Catalog、项目知识和 Controller 发现文件。稳定 Project checkout 与受管理 worktree 位于 home 外部的 workspace。当前存储版本严格匹配且 fresh-only；代码保留了未来版本的迁移注册表，但本版不迁移旧格式。

## 快速开始

```sh
yui project add app /absolute/workspace/app \
  --remote git@example.com:team/app.git --stable main --development develop
yui project update app --alias app-cli --development develop
yui project list

yui task create "交付 CSV 导出" --project app
yui task update <task-id> --priority high --tags release,csv --due-at 2026-08-01T00:00:00Z
yui task update <task-id> --clear-priority --clear-tags --clear-due-at
yui task show <task-id>
yui task context <task-id>
yui task activate <task-id>
```

面向用户的时间默认按北京时间（`Asia/Shanghai`）显示；持久化记录和
`--json` 数据仍使用 UTC/RFC 3339。可通过以下命令查看或修改 IANA 时区：

```sh
yui config show
yui config set --time-zone Europe/London
```

查看已有 Task 的详细状态时，优先使用 `task context`。它一次聚合 Task、Brief、Active Decision、最近的 Milestone、Role、当前及最近的 WorkItem 与关联 Run、最近的 Message、Open/Resolved InputRequest 和 Event。终端输出会精简历史和长文本；`yui --json task context <task-id>` 会在顶层 `data` 中返回完整记录。

带 Project 的新 Task 会立即在 `<workspace>/worktree/<project>/<task-id>/main` 创建主 worktree。所有 Role 默认共享 Task main；任务运行中，Leader 根据并发写入冲突风险直接执行 `yui task work isolate <work-item-id>` 创建 WorkItem 所有的隔离 worktree，无需审批。清理时必须明确标记为 `--integrated` 或 `--abandon`，结果保留在 WorkItem 记录中；dirty worktree 原地保留。

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

推荐项会明确展示给用户；如果截止时间前没有回答，独立的最近 deadline timer 会唤醒 Controller，原子采用这个确定选项，并排队恢复固定的 Leader session。自由文本和必须由用户回答的请求永远不会自动解决。

`task input list` 是权威的全局开放输入 Inbox；可附加 Task ID 限定范围，或使用 `--all` 查看已回答和已取消的请求。Controller 还会尝试向已经运行且处于输入状态的 Operator composer 投递一次带回执的提示；它不会为了通知而启动或打断 Operator。Operator 不在线或正忙时，请求仍保留在 Inbox，并在后续 Controller 定向处理中重新尝试。用户和 Operator 都可回答。存在开放请求时，无关的 pending wake 不会绕过等待，Task 也不能 complete 或 archive。原 Leader 也可执行 `yui task input cancel <task-id> <input-id> --reason "..."`，取消会排队恢复该固定 Leader session。

```sh
yui task context <task-id>
```

需要查看单个集合或记录时，再使用 `task work`、`task message`、`task run` 和 Task Knowledge 下的细分命令。

完成目标后，可将 Task 标记为 completed，从而停止自动唤醒，同时保留 session 和 Task main worktree：

```sh
yui task complete <task-id> --summary "CSV 导出已交付并验证"
yui task reopen <task-id>
```

completed Task 在显式 reopen 前会拒绝消息、派发、进入 session、重试和迟到的 yield。每个隔离 WorkItem worktree 必须先显式清理，清理时也会删除其受管分支；archive 还必须通过 `--integrated` 或 `--abandon` 明确 Task main 的处理结果，之后才会停止 session 并清理干净的 Task main。Task 与 WorkItem 记录都会保留，Task main 分支作为恢复信息保留，不会被静默删除。
Task 生命周期的交互选择只展示有效来源状态：activate 只展示 Draft，complete 只展示 active，reopen 只展示 completed。

## Session 与 tmux

Yui 不代理交互式 Agent 终端。执行 `operator enter`、`role enter` 或 `task enter` 前，Yui 会关闭 readline、退出 raw mode、暂停自身 stdin，再同步把终端交给 tmux。因此 Codex 原生的 `/model`、斜杠命令提示、全屏渲染和按键处理都可正常工作。

```sh
yui role enter <global-role>
yui task enter <task-id> [role]
yui task role enter <task-id> <role>
```

每个 Role 可绑定多个 Agent，有一个 active Agent，并为每个 Agent binding 独立保存 native session。切换 Agent 会保留休眠 session；Role 有活动 Run 或 native process 时禁止切换。

使用 `yui role unbind <global-role> <agent-id>` 或 `yui task role unbind <task-id> <role> <agent-id>` 可移除休眠 binding。active binding 或任何未 stopped 的 native session 都会被拒绝；stopped session 记录会和 binding 在同一事务中删除。

Claude 的 session ID 在启动前分配。受管理的 Codex 启动使用 Codex 结构化 `notify` 回调，在 turn 完成后记录 thread ID，不再向模型对话注入 session-bind prompt。

稳定的 Role 上下文也属于启动元数据，而不是 bootstrap turn。Yui 通过 Agent 原生的 system/developer instruction 通道传入 Role 策略和 `systemPrompt`。原生 Codex CLI 没有按会话追加 Skill root 的参数，因此 developer instructions 只携带精简的 Skill 绝对路径，由 Codex 按需读取 `SKILL.md`。由于 `developer_instructions` 是单一标量配置，Yui 会检查当前支持的全部 Linux Codex 配置层：`/etc/codex/config.toml`、用户配置、选中的 `$CODEX_HOME/<name>.config.toml`、项目配置以及 `/etc/codex/managed_config.toml`；任意一层已经设置该值时都会明确拒绝覆盖。受管理的 Codex 会话还必须独占用于记录原生 Turn 完成状态的结构化 `notify` 回调；任意受检配置层已经定义 `notify` 时，Yui 都会拒绝启动，避免两个回调互相静默覆盖。`skills.config` 只负责启停已发现 Skill，Yui 不会误用它。Claude 从 Yui 管理的私有 `0600` context 文件读取同一份 Skill 内容，不再把大段或敏感文本放进 argv；重试和 resume 会复用该 Role 的稳定路径。非 Operator 的 global Role 保持中性，不会注入 Task Leader 或 Worker Skill。因此 Operator 会停在空白的原生 composer，用户输入仍是第一条 user message；Leader wake 和 Worker Run assignment 仍是邮箱投递的真实工作消息。不具备原生指令通道的 adapter 必须拒绝这类上下文，不能静默降级为首轮 user prompt。

## Controller 与失败处理

每个 `YUI_HOME` 有一个后台 Controller：

```sh
yui controller status
yui controller stop
yui controller restart
```

`controller restart` 会用当前安装的 Yui 版本替换 Controller 进程及其调度循环、socket 服务，不会停止或重启已受管的 tmux/Agent 会话。

恢复 reconciliation 默认每 120 秒执行一次。普通持久状态变化只会将 Task、Role 或 Operator key 放入队列并立即返回；固定 100ms 窗口内到达的 key 会合并触发一次不重叠的定向处理。Operator 呈现使用独立 lane，不会被 Task 的 Git/worktree 操作阻塞；周期 Git/worktree 处理只覆盖仍有持久 Task mailbox 工作的 Task，活动 Role 的存活检查合并为一次 tmux inventory。Codex turn-complete Hook 直接写入存储，不启动或等待 Controller，并给合法的 yield、输入请求或完成动作保留 2 秒竞争窗口；到期后才关闭被 Agent 遗忘的活动 Role Run。持久 WorkMailbox 会冻结当前 processing 批次，期间的新事件合并到下一 pending 批次；失败会释放当前批次供恢复。推荐输入与 pending Turn 共用最近 deadline 选择器，不依赖恢复扫描间隔；显式 `task reconcile` 仍会立即请求恢复扫描。保留的闭环为：

1. 准备 active Project Task 的主 worktree；
2. 停止 archived Task 的 tmux，并只清理干净 worktree；
3. 投递排队的 Worker Run；
4. 检测活动 Role 进程退出；
5. Leader 空闲时投递 pending wake。

自动输入只通过 tmux 投递。每次处理只做一次非阻塞的 Agent 专属 readiness 检查；启动阶段忙碌时通过小型有界 mailbox timer 重试，后续忙碌会话通常由 Codex turn-complete 事件再次唤醒。pane 内 receipt 可避免 Controller 重试时重复输入同一 Run。

Role 在 yield 前退出时，Controller 会失败对应 Run 和 running WorkItem，并唤醒 Leader。恢复状态通过精简的 Jobs 兼容视图呈现：

```sh
yui jobs list
yui jobs retry leader-recovery:<task-id>
yui task reconcile <task-id>
yui task run retry <failed-run-id>
```

`jobs` 不是旧版通用队列，只展示持久 Leader wake 和 Leader recovery failure。

completion 是可逆的执行屏障。只有活动工作已处理且所有 worktree 干净时才能归档；归档停止 Task 的 tmux session 并移除托管 worktree，但保留 Task 记录。脏 worktree 会让 Task 保持 completed，供后续处理。

## 本地 Web Dashboard

默认在 loopback 地址启动只读 dashboard：

```sh
yui web
# Yui web dashboard: http://127.0.0.1:4173
```

可用 `--port <port>` 或 `--host 127.0.0.1|::1|localhost` 修改监听参数。Yui 会拒绝非 loopback host；Web 界面无需认证，因此只允许本机访问，并且不会写入 Yui 状态。所有变更仍通过 CLI 或 Agent session 完成。

Dashboard 支持 English 与简体中文，首次打开时跟随浏览器语言，也可以手动切换并记住选择。主题选择器可在深色「控制室」和浅色「纸本台账」之间切换。语言与主题偏好只保存在浏览器 `localStorage`，不会修改 `YUI_HOME`。

## 管理命令

```sh
yui update
yui agent add|list|show|update|remove
yui role add|list|show|update|remove|bind|enter
yui role session record|replace
yui project add|clone|update|discover|list|show|knowledge
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

如需让所有终端及受管 Agent 会话使用当前 checkout，可逆地接管用户级 `yui` 命令：

```sh
make link
command -v yui
yui doctor
```

第一次执行 `make link` 会把最初的 `yui` 入口保存在同一个用户级 bin 目录，再用指向当前 checkout 的受管符号链接接管命令。之后在其他 checkout 执行 `make link` 只会移动这个受管链接：最后执行者生效，开发环境之间不会形成备份链。请串行执行 `make link` 和 `make unlink`，不要从多个环境或 checkout 并发调用。launcher 默认使用当前生效 checkout 的 `output/dev/home` 作为 `YUI_HOME`；显式设置的 `YUI_HOME` 仍然优先。因为替换的是命令入口，其他终端和之后创建的 Codex/Claude 会话无需 source 也会使用同一个开发版本。若已有 Controller 也需要加载新代码，请执行 `yui controller restart`。任意采用本实现的 checkout 都可以执行 `make unlink`；它会校验共享受管状态并恢复唯一一份最初 `yui` 入口。

```sh
make unlink
```

## 许可证

[MIT](../LICENSE)
