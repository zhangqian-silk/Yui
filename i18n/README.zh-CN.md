<p align="right"><a href="../README.md">English</a> | <strong>简体中文</strong></p>

# Yui

Yui 是面向持久 Codex/Claude 工作的本地控制平面。用户只需和 Operator
对话；Operator 将不同 Project 的需求、Bug、审查和问题咨询路由到对应
Task，Leader 再负责拆解、执行选择、验收和安全集成。

当前实现保留实用的 Role/Agent/session 与 CLI 框架，不恢复后期膨胀的数据维护、租约、定时调度和恢复账本体系。

## 核心模型

- `WorkItem`：唯一的有界工作单元，保存目标、验收条件、依赖、状态和精简结果。
- `WorkerProfile`：可复用且与 provider 无关的行为模板，保存指令、Skill、访问要求及可选 model/effort hint。
- `TaskRole`：Task 内可修改的 Worker 实例，可绑定多个 Agent，并分别保存运行配置。
- `AgentRun`：Task Role 的一次受管派发与结果交付。
- `ChangeSet`：隔离 WorkItem 当前 HEAD 的不可变 Git 结果。
- Integration：候选集成、检查、冲突报告和 Leader 决策。

每个 WorkItem 只选择三条路径之一：Leader 直接执行、Leader 在当前
Agent 对话内创建 native subagent，或交给 Task Role AgentRun。Yui
不提供 subagent 启动命令，也不创建 child Session 记录。

内置 Profile：

```text
worker  explorer  implementer  reviewer
```

Profile 不绑定 Agent，也不持有 Session 或 workspace。Operator、Leader
与 Task Role 是运行时 Role。

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

`setup` 是交互式的：检测已安装的 Agent CLI，选择要配置的 Agent、默认
Agent 和 Operator Agent，并实时探测所选 CLI 当前支持的模型。它先配置
Leader 和 Operator，再说明全局 Worker 配置会复制到新建的 Task Role，
让用户选择 Worker 复用 Leader 配置还是单独配置。模型选择后只展示该模型
支持的思考强度。随后 setup 会确认位于 Yui home 外部的 Project workspace，
并询问 shell completion。选择器同时提供原生 CLI 默认值和自定义值入口。
再次运行不会删除已有 Task/Role，也不会改变当前安装的 Project workspace，
可用于安全地调整配置。

模型与思考强度属于 Agent binding 设置，因此 Operator、Leader 和全局
Worker 即使使用同一个 Agent CLI，也可以采用不同配置。Profile 中的
model/effort 只是 native child 的可移植 hint。

运行时能力目录会在每次命令中刷新，并缓存在 Yui home。实时探测超时或失败时，Yui 会展示同一 Agent 启动上下文最近一次成功的缓存并明确提示数据可能过期；没有匹配缓存时，则提供 CLI 默认值和自定义入口。`yui agent capabilities <id>` 可一次性读取同一份目录，包括模型、逐模型思考强度，以及权限、搜索可用性、profile、settings source、service tier 等其他运行时选项。

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

home 中包含 `schema.json`、权威 `state.json`、Project Catalog、项目知识和 Controller 发现文件。稳定 Project checkout 与受管理 worktree 位于 home 外部的 workspace。运行时存储严格匹配且 fresh-only：不会双读旧 schema，也不会猜测旧 ID。

所有 Task-owned 记录族都在各自 Task 内分配单调递增的本地 ID。因此，不同
Task 可以同时拥有 `work-item-1`、`agent-run-1` 或 `input-1`。受管 Task
session 可由 `YUI_TASK_ID` 提供作用域并使用本地短 ID；Task session 外必须
使用 `<task-id>/<local-id>`。Yui 不会拿裸 ID 扫描所有 Task。已经显式接收
Task 的命令（例如 `task work create`、`task integration start`）仍使用该
Task 内的本地子记录 ID。Candidate 只在所属 WorkItem 内递增，并同时保存
Task 与 WorkItem provenance。

对于紧邻本版本的 aggregate-v10 identity 布局，只提供一个离线转换器。先
停止源 Controller，保持源 home 不可变，并选择一个尚不存在的新路径：

```sh
yui storage convert-task-identity \
  --source /absolute/path/to/old-yui-home \
  --output /absolute/path/to/fresh-yui-home
```

转换器会重映射全部 Task-owned 记录与引用，使用当前 runtime 验证新输出，
生成 `identity-conversion.json`，并核对源文件字节未改变。悬空或歧义旧引用
会令转换失败；转换器绝不原地修改源 home。切换 `YUI_HOME` 前，应检查报告
和 fresh home 中的 Task context。完整边界见
[Task 本地 ID 与离线转换](../docs/task-local-identity.md)。

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

WorkItem 审查只有一条可选的全局规则，并直接复用已有 Global Role 的
Agent、model、权限、prompt 和 Skills：

```sh
yui config review set --role reviewer --trigger always
yui config review show
yui config review clear
```

每个进入 Leader 验收阶段的结果，都会成为原 WorkItem 上一个明确的候选。
当前全局规则对所有新旧 Task 的下一个候选生效，并在候选提交时形成快照；
后续 `set`/`clear` 不会改变已经在途的判断。
`always` 会为每个候选启动 ReviewRound，包括 Role yield 的结果和 Leader 直接管理的
结果；`leader` 则让候选保持等待验收，由 Leader 直接 accept 或执行
`yui task work review <task-id>/<work-item-id>`。因此只要配置了审查规则，Leader
管理的候选也不会直接标记为完成。ReviewRound 引用不可变候选，审查
AgentRun 不创建新 WorkItem，也不会递归触发审查。审查以自然语言结果
唤醒 Leader；Leader 决定验收、reject 后在原 Role 与原 Session 中修复、
再次审查，或通过 InputRequest 询问用户。审查失败会保留为可见证据并
唤醒 Leader，但不会取代 Leader 的最终判断。
所有候选、ReviewRound 和 Leader 决策都集中在原 WorkItem 下；reject
后的下一轮会复用原执行 Role、Session 与 workspace，并追加新候选。

查看已有 Task 的详细状态时，优先使用 `task context`。它一次聚合 Task、Brief、Active Decision、最近的 Milestone、Role、当前及最近的 WorkItem 与关联 Run、最近的 Message、Open/Resolved InputRequest 和 Event。终端输出会精简历史和长文本；`yui --json task context <task-id>` 会在顶层 `data` 中返回完整记录。

Task identity 由一个有界交付目标决定，而不是由涉及几个仓库决定。带仓库的
Task 可以绑定多个 Project，并为每个 Project 记录独立 base ref。Leader 从
同一个 Task workspace 根目录工作：

```text
<workspace>/tasks/<task-id>/main/
├── backend/
├── frontend/
└── shared-sdk/
```

每个目录背后都是该 Project 独立的受管 Git worktree。创建时应一次绑定已知
Project；如果同一目标在执行中确认还需要另一个仓库，只能由 active Task 的
Leader 追加：

```sh
yui task create "升级认证协议" \
  --project backend --project frontend \
  --base backend=develop --base frontend=main
yui task project add <task-id> shared-sdk --base main
```

实现型 WorkItem 必须声明允许修改的 Project。它保留与 Task main 一致的
相对目录布局，只为写入范围创建隔离 worktree，其他 Task Project 作为上下文
从 Task main 暴露。Yui 会在受管派发和 `yui-worker` Skill 中明确列出可写与
仅上下文 Project，由 Agent 严格遵守该边界。原生 Agent 权限作用于整个会话：
实现 Role 使用可写会话，explorer 和 reviewer Role 使用原生只读会话（Codex
`read-only`，或带最小 allow list 的 Claude `dontAsk`）。

写入范围只能扩大，不能缩小。Worker yield 并报告还需要另一个仓库后，
Leader 使用完整的“旧范围 + 新范围”更新并重新派发：

```sh
yui task work create <task-id> "升级协议与客户端" \
  --project backend --project frontend --role implementer
yui task work scope <task-id>/<work-item-id> \
  --project backend --project frontend --project shared-sdk
yui task work isolate <task-id>/<work-item-id>
yui task work reject <task-id>/<work-item-id> \
  --summary "已扩大写入范围，请在刷新后的 workspace 继续。"
yui task work dispatch <task-id>/<work-item-id>
yui task work capture <task-id>/<work-item-id>
yui task integration start <task-id> --project backend \
  --change-set <backend-change-set-id> --check "<validation command>"
yui task integration cleanup <task-id>/<integration-id>
yui task work cleanup <task-id>/<work-item-id> --integrated
```

`capture` 为每个实际修改的 Project 记录一个不可变 ChangeSet；同一 HEAD
重复 capture 会复用记录，修复后的新 HEAD 会产生新候选。Integration 保持
单 Project Git 事务，所以 Leader 分别集成每个 Project。只有所有已修改
Project 的最新候选都完成集成，WorkItem 才能验收；仍有未集成结果时不能执行
`--integrated` 清理。`--abandon` 只用于明确放弃，dirty worktree 会原地保留。
原生 Agent Session 可能绑定启动目录，因此 Role 在 Task main 与隔离
WorkItem workspace 之间移动时，Yui 会退役已停止的旧 Session；下一次派发
在新目录创建 Session，持久 Yui 记录继续提供上下文。

通过 Operator 提交消息：

```sh
yui operator submit "比较 CSV 与 JSON 的兼容性" --task <task-id>
yui operator submit "研究更小的缓存设计"
yui operator list
yui operator resume
yui operator resume --last
yui operator new
yui operator enter
```

不带 `--task` 时会创建新 Draft。Draft 可以继续规划，但激活前不会执行 Agent 工作。
Operator 会结合 Project Catalog 和现有 Task context 路由请求。同一有界
目标的追加需求、修复、审查和咨询继续进入原 Task，即使它涉及多个 Project。
目标、所有权边界或生命周期独立时才创建新 Task。需求、Bug 和咨询共用同一
Task/WorkItem 模型，不增加额外任务类型。
`operator list` 按固定的最近更新时间倒序展示历史对话，并显示 Agent
及可读的标题或摘要；底层 provider session ID 始终保持内部实现细节。
若 adapter 尚未提供这些元数据，Yui 会显示 provider 和稳定的 Yui
短引用，确保无标题会话仍可区分。`operator resume` 使用同一个轻量编号列表，
`--last` 可直接恢复最近一条；
`operator new` 创建空白对话，并把原对话保留在历史中。

从已配置的全局 Worker 创建 Task Role，应用 Profile 并派发 WorkItem：

```sh
yui role show worker
yui task role add <task-id> implementer --profile implementer
yui task role show <task-id> implementer

yui task work create <task-id> "实现导出器" \
  --project app --role implementer
yui task work isolate <task-id>/<work-item-id>
yui task work dispatch <task-id>/<work-item-id> --input "完成实现并运行聚焦测试"
```

`--yolo true` 是 Role 的一等配置。Yui 会分别为 Codex 编译
`--dangerously-bypass-approvals-and-sandbox`，为 Claude 编译
`--dangerously-skip-permissions`；`--clear-yolo` 会恢复已保存的权限设置或
CLI 默认值。任意非 Leader Task Role 在创建时不传 `--agent`，都会复制全局
Worker Role 的完整 Agent bindings，Leader 无需重新拼接 model、effort 和
权限。创建回执和 `task context` 会记录配置来源及生效的
Agent/model/effort/YOLO。显式 `--agent` 属于 Task 专用覆盖，必须在派发前
补全并回读配置。

ReviewRound 从冻结 Candidate SHA 创建独立的可写 worktree。Codex/Claude 只在
该 exact ReviewRound owner、reviewRoundId 与 workspace 全部匹配时获得配置上限
内的正常 full capability；Skill 仍禁止 push、Integration、Task state、其他
workspace 与真实 YUI_HOME 变更。两种 provider 都必须直接执行当前 Run 的 exact
stdin yield；最终回复本身不是持久交付。

Worker 显式交付当前 Run：

```sh
yui task run yield <task-id>/<run-id> --summary-file - <<'YUI_SUMMARY'
导出器已完成，聚焦测试通过
YUI_SUMMARY
```

yield 会结束 AgentRun，将 WorkItem 提交给 Leader 审查，并追加结果消息和
唤醒 Leader；它不会验收或完成 WorkItem。Leader 不会自唤醒，pending wake
会保留到 Leader 空闲。

如果无法最终判断结果，交接必须明确标为 `uncertain`、`incomplete`、
`blocked` 或 `requiring Leader judgment`，并提交最完整且真实的身份、已执行
动作、仓库状态、检查与错误、最后生命周期边界、未完成工作、待决事项、风险、
置信度及有界下一选项。yield 只记录不可变的 Run/Candidate 或 Review 证据；
它不表示验收、WorkItem 完成、ChangeSet capture、Integration 或 Task 完成。

对于有界工作，Leader 可以直接执行 roleless WorkItem，也可以在当前
Agent 对话中创建 native subagent：

```sh
yui task work create <task-id> "审查实现" \
  --objective "返回有源码依据的问题" \
  --accept "每个问题都标明受影响路径"
yui task work update <task-id>/<work-item-id> running
yui profile show reviewer
```

subagent 的创建与结果返回完全由 Leader 当前 Agent 的 native child 能力
完成，没有 `yui ... subagent` 命令。Leader 必须选择并读取一个显式
Worker Profile；没有合适的专用 Profile 时使用 `worker`。child brief
需要包含 Profile revision、instructions、Skills、访问边界、验证要求及
当前 runtime 支持的 model/effort hint。

native subagent 继承 Leader Agent、凭据和对话上下文，忽略 Task Role 的
Agent bindings。Leader 审查返回结果后，在 WorkItem summary 中登记真实
执行信息：

```sh
yui task work update <task-id>/<work-item-id> done \
  --summary "executor=subagent; profile=reviewer@3; model=inherited; round=1; result=reviewed; checks=npm test passed"
```

无法确认实际 model/effort 时使用 `inherited` 或 `unknown`，不能猜测。
需要独立 provider、凭据、交互 Session 或持久生命周期时，使用 Task Role
AgentRun。

隔离 Task Role 的结果按“Worker yield → Leader 语义审查 → capture 当前
HEAD → candidate 集成和检查 → Leader accept”的顺序处理。审查不通过时，
Leader reject 并在同一 workspace 重新派发。相同 HEAD 重复 capture 复用
原 ChangeSet；修复后的新 HEAD 形成新候选：

```sh
yui task work reject <task-id>/<work-item-id> --summary "需要修复的具体问题"
yui task work dispatch <task-id>/<work-item-id> --input "结合上一轮结果修复"
yui task work capture <task-id>/<work-item-id>
yui task integration start <task-id> \
  --change-set <latest-change-set-id> --check "npm test"
```

Integration 只保存紧凑检查结果和失败诊断。完整 stdout/stderr 流式写入
`YUI_HOME/artifacts/integration-checks/...`；`task integration show`
展示相对日志路径，cleanup 同时清理候选 worktree 和日志。

代码或语义冲突会保持 blocked，直到该 Task 的 Leader 记录决策：

```sh
yui task integration resolve <task-id>/<integration-id> \
  --option manual-resolution \
  --rationale "保留公开契约并组合两边实现"
yui task integration continue <task-id>/<integration-id>
```

Worker yield 不等于 WorkItem 完成。Leader 审查结果、验证和最新
ChangeSet 集成后再显式验收：

```sh
yui task work accept <task-id>/<work-item-id> --summary "验收标准满足。"
```

使用 `task work reject` 退回待验收结果以便修复和重新派发，使用
`task work dispose` 显式记录终态处置。WorkItem、Integration
worktree 与检查日志会作为证据保留，直到显式清理。

长期 Task 不依赖 native transcript 恢复。Leader 每次 yield 前更新 Brief
的 focus 和 leader summary；材料性技术选择写入 Decision；可独立汇报的
阶段成果写入 Milestone；只有跨 Task 稳定有效的信息才进入 Project
Knowledge。

当活动 Leader Run 必须获得用户决定才能继续时，可以创建持久 InputRequest，并 yield 当前 Run：

```sh
yui task input request <task-id> --question "默认使用哪种格式？" \
  --choice csv="CSV" --choice json="JSON" --blocks work-item:<work-item-id>
yui task input list
yui task input show <task-id>/<input-id>
yui task input answer <task-id>/<input-id> --choice csv
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

所有长时间运行的交互式 Agent 进程都由 tmux 承载。执行 `operator enter`、`role enter` 或 `task enter` 前，Yui 会关闭 readline、退出 raw mode、暂停自身 stdin，再同步把终端交给 tmux。attach 会继承外层终端的真实能力并进入干净的 alternate screen；鼠标滚动只查看 Agent pane 的 100,000 行 tmux 历史，不再混入 attach 之前的 shell 或 IDE Terminal 历史。因此 Agent 原生的 `/model`、斜杠命令提示、全屏渲染和按键处理都可正常工作。

tmux 会在 pane 创建时固定其历史容量。配置该限制之前创建的 Role 会保留原容量；Yui 会在 Terminal attach 和 Web 中提示用户退出并重新进入一次，从而在保留 Agent 原生对话的同时创建具有 100,000 行历史的新 pane。

同一个 Operator 或 Task tmux session 中，第一个 Terminal/Web 客户端可写，后续查看者自动只读，避免多个入口同时向同一个 Agent 输入。

```sh
yui role enter <global-role>
yui task enter <task-id> [role]
yui task role enter <task-id> <role>
```

每个 Role 可绑定多个 Agent，但任一时刻只有一个 active Agent，并为每个
Agent binding 独立保存 native session。Operator 进一步限制为同一种
adapter 最多绑定一个，例如可同时绑定一个 Codex 和一个 Claude；这些
binding 是预先保存、可随时切换的配置，而不是并行身份。Operator 可为
每个 binding 保留多条历史对话。`operator new` 与 `operator resume`
复用唯一的 Operator tmux pane；存在运行中进程时，Yui 会先确认再停止
并切换。跨 Agent 切换默认复用已保存的 model/effort，只有用户明确选择
更新时才进入现有配置选择流程。

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

## 本地 Web 控制室

默认在 loopback 地址启动本地控制室：

```sh
yui web
# Yui web control room: http://127.0.0.1:4173
```

可用 `--port <port>` 或 `--host 127.0.0.1|::1|localhost` 修改监听参数。Yui 会拒绝非 loopback host，因为控制室会展示 Task、Role、WorkItem、Run、Message、Decision、Milestone 和 InputRequest 等信息。服务启动时生成的随机 token 会嵌入页面，并保护写操作和终端连接。

Web 端可以通过与 Terminal 相同的持久化 CLI 路径回答 open InputRequest，也可以通过原生 xterm 客户端 attach 到已有 Operator、Leader 或 Worker tmux pane。关闭浏览器终端只会 detach 当前 tmux client，Agent 进程与对话继续保留；Web 不复制 transcript，也不维护第二套会话状态。

控制室支持 English 与简体中文，首次打开时跟随浏览器语言，也可以手动切换并记住选择。主题选择器可在深色「控制室」和浅色「纸本台账」之间切换。语言与主题偏好只保存在浏览器 `localStorage`，不会修改 `YUI_HOME`。

## 管理命令

```sh
yui update
yui agent add|list|show|capabilities|update|remove
yui role add|list|show|update|remove|bind|enter
yui role session record|replace
yui project add|clone|update|discover|list|show|knowledge
```

Agent 环境变量绑定只保存进程环境变量名，不保存 secret 值；raw args 不能覆盖 adapter 管理的生命周期参数。

## 范围

Yui 面向一台机器上的一个受信任本地用户。它的 Web/API 仅支持 loopback，不包含远程或多用户 Web、分布式协调、backup/import/export、trash/restore、derived index、recovery journal、runtime lease、inactivity TTL、cooldown 或 recurring schedule。

持久化和调度细节见 [ARCHITECTURE.md](../ARCHITECTURE.md)。
可复用的用户视角验收方案见
[Operator 路由与长期任务端到端测试方案](../docs/testing/operator-routing-e2e-plan.md)。

## 本地开发

```sh
npm ci
npm run build
npm test
npm run lint
```

如需让用户终端使用当前 checkout，可逆地接管用户级 `yui` 命令：

```sh
make link
command -v yui
yui doctor
```

第一次执行 `make link` 会把最初的 `yui` 入口保存在同一个用户级 bin 目录，再用指向当前 checkout 的受管符号链接接管命令。之后在其他 checkout 执行 `make link` 只会移动这个受管链接：最后执行者生效，开发环境之间不会形成备份链。请串行执行 `make link` 和 `make unlink`，不要从多个环境或 checkout 并发调用。launcher 默认使用当前生效 checkout 的 `output/dev/home` 作为 `YUI_HOME`；显式设置的 `YUI_HOME` 仍然优先。受管 Agent 不依赖这个全局链接：Controller 会把指向自身 Yui CLI 和 `YUI_HOME` 的私有 launcher 放到 PATH 最前面。若已有 Controller 也需要加载新代码，请执行 `yui controller restart`。任意采用本实现的 checkout 都可以执行 `make unlink`；它会校验共享受管状态并恢复唯一一份最初 `yui` 入口。

```sh
make unlink
```

## 许可证

[MIT](../LICENSE)
