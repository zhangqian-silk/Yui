<p align="right"><a href="../README.md">English</a> | <strong>简体中文</strong></p>

# Yui

Yui 是面向智能 Codex/Claude Agent 的本地控制平面。它持久保存用户意图、
Project Knowledge、Task、交接和结果，并提供上下文、消息、委派、工作区、
Session、审查和集成等小而原子的能力。Agent 组合这些能力，自主决定规划、
顺序、委派、重试和恢复。

Yui 不把 Agent 的判断固化成确定性的工作流引擎。核心只负责持久身份、用户
授权、工作区隔离和原子状态变更；Provider Session 与运行时观测用于执行和
连续性，但不是 Task 事实的另一套来源。用户只需和 Operator 对话，Operator
负责路由，Leader 负责目标拆解、执行选择、验收和集成。

当前实现保留实用的 Role/Agent/session 与 CLI 框架，不恢复后期膨胀的数据维护、租约、定时调度和恢复账本体系。

## 核心模型

- `WorkItem`：唯一的有界工作单元，保存目标、验收条件、依赖、状态和精简结果。
- `WorkerProfile`：可复用且与 provider 无关的行为模板，保存指令、Skill、访问要求及可选 model/effort hint。
- `TaskRole`：Task 内可修改的 Worker 实例，可绑定多个 Agent，并分别保存运行配置。
- `Turn`：Task Role 的一次受管派发与结果交付。
- `ChangeSet`：隔离 WorkItem 当前 HEAD 的不可变 Git 结果。
- Integration：候选集成、检查、冲突报告和 Leader 决策。

每个 WorkItem 只选择三条路径之一：Leader 直接执行、Leader 在当前
Agent 对话内创建 native subagent，或交给 Task Role Turn。Yui
不提供 subagent 启动命令，也不创建 child Session 记录。

内置 Profile：

```text
worker  explorer  implementer  reviewer
```

Profile 不绑定 Agent，也不持有 Session 或 workspace。把 Yui Agent Profile 应用到 Task Role 时，会把 instructions、Skills、访问意图以及可选 model/effort 复制到该 Role 的 active Agent binding；显式 Role 参数可以继续覆盖这些值。它与 Codex 通过 `--profile` 选择的原生 config profile 不是一回事。Operator、Leader
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

`setup` 被刻意缩减为最小流程：检查 tmux，复用或创建一个可用 Agent，在
Yui home 外创建默认 workspace，并配置 Operator 与 Leader，使用户可以启动
Yui 并执行 Task。它不会创建 Worker、Reviewer、Profile 或 review policy，
也不会询问 model/effort、permission 或 shell completion。Operator 与 Leader
的必需 binding 使用 Yui 的 adapter 默认 permission strategy（`bypass`）；
后续调整统一通过 `config role` 完成。再次运行会原样保留已经可用的 Operator
和 Leader；setup 成功返回前会启动当前 Home 的后台 Controller。

所有持久配置都位于 `yui config` 下。`config show` 展示完整有效状态，
`config --help` 介绍各配置域并给出示例。Operator 可通过结构化的
`config describe` 读取配置目录，向用户说明当前值、具体影响、可选值和生效
方式，并只执行用户确认的修改。

持久设置按职责分组：`config system` 管理 Home 默认值和展示方式，
`config runtime` 管理 Controller 健康阈值、并发、启动、投递和 Provider
重试，`config workflow` 管理 Leader、context 与 review policy，
`config resources` 管理隔离区和 GC，`config tools` 管理 tmux 与诊断
telemetry。Agent、全局 Role、Profile 和 shell completion 则继续位于同级的
`config agent|role|profile|completion` 域。每个持久设置域统一使用
`show`、`set`、`clear`。

运行时能力目录会在每次命令中刷新，并缓存在 Yui home。实时探测超时或失败时，Yui 会展示同一 Agent 启动上下文最近一次成功的缓存并明确提示数据可能过期；没有匹配缓存时，则提供 CLI 默认值和自定义入口。`yui config agent capabilities <id>` 可一次性读取同一份目录，包括模型、逐模型思考强度，以及权限、搜索可用性、profile、settings source、service tier 等其他运行时选项。

`completion` 无论是否指定 shell，都会进入确认流程：

```sh
yui config completion
yui config completion zsh
```

流程会确认生成脚本、安装路径和 shell 启动文件修改。补全脚本直接由命令目录生成，支持二级及更深层子命令。

默认 home 是 `~/.yui`。隔离环境可设置：

```sh
export YUI_HOME=/absolute/path/to/yui-home
yui setup
```

home 中包含 `schema.json`、权威 SQLite 数据库 `yui.db`、Project Catalog、项目知识和 Controller 发现文件。稳定 Project checkout 与受管理 worktree 位于 home 外部的 workspace。运行时只接受当前存储契约：不会回退读取 `state.json`、转换旧 schema 或猜测旧 ID。

所有 Task-owned 记录族都在各自 Task 内分配单调递增的本地 ID。因此，不同
Task 可以同时拥有 `work-item-1`、`turn-1` 或 `input-1`。受管 Task
session 可由 `YUI_TASK_ID` 提供作用域并使用本地短 ID；Task session 外必须
使用 `<task-id>/<local-id>`。Yui 不会拿裸 ID 扫描所有 Task。已经显式接收
Task 的命令（例如 `task work create`、`task integration start`）仍使用该
Task 内的本地子记录 ID。Candidate 只在所属 WorkItem 内递增，并同时保存
Task 与 WorkItem provenance。

Yui 只支持当前 aggregate-v14 / StoredTask-v13 schema。旧 home 不提供转换、
双读或历史记录推断；需要使用新版本时初始化全新的 `YUI_HOME`。当前引用契约见
[Task 本地 ID](../docs/task-local-identity.md)。

## 快速开始

```sh
yui project add app /absolute/workspace/app \
  --remote git@example.com:team/app.git --stable main --development develop
yui project update app --alias app-cli --development develop
yui project list

yui task create "修复 CSV 转义" --project app --type bugfix
yui task create "交付 CSV 导出" --project app --type feature
yui task update <task-id> --priority high --tags release,csv --due-at 2026-08-01T00:00:00Z
yui task update <task-id> --clear-priority --clear-tags --clear-due-at
yui task message update <task-id>/<message-id> --body-file updated-message.md --wake-policy none
yui task work edit <task-id>/<work-item-id> --objective "修订后的目标" \
  --accept "新的可观察验收标准"
yui task work retire <task-id>/<work-item-id> --summary "从当前 Draft 中移除"
yui task show <task-id>
yui task context <task-id>
yui task activate <task-id>
```

Draft 只保存规划记录和 Project 绑定，不采用可写 managed Workspace。Message
与 WorkItem 编辑只替换显式指定的可变字段，记录 ID 和审计历史保持不变；重复
选项表示整体替换，对应 `--clear-*` 显式表示空集合。retired 记录继续保留在历史
视图中，但退出当前 Draft。retired WorkItem 不满足依赖，也不会通过可选
replacement 自动重定向下游；激活前必须修正剩余 Draft。所有 Draft-only 编辑和
retire 都不创建、停止或清理运行时资源；`task activate` 会在采用任何 Workspace
之前校验当前依赖图、Role 和 Project scope。

Task type 描述需求意图，不选择执行协议。软件 Project 通常使用 `bugfix` 或
`feature`：bugfix 由 Leader 在 Task main 独立、快速完成；如果范围扩大到需要
独立 owner，应先改为 feature 再创建 WorkItem。feature 由 Leader 判断是自己直接
交付，还是拆成由不同 Worker 独立负责、可并行推进的较大
WorkItem。实现步骤、测试、review finding 和局部修复都不是 WorkItem。只有当一项
需求本身具有独立 owner 和可验收结果时才创建 WorkItem。只有当前 governing
Candidate 的 ChangeSet 是交付义务：它们必须通过 committed Integration 汇总回
Task main，或由 Leader 在队列中显式 supersede；旧 Candidate 和 ChangeSet 只保留为审计证据。

面向用户的时间默认按北京时间（`Asia/Shanghai`）显示；持久化记录和
`--json` 数据仍使用 UTC/RFC 3339。可通过以下命令查看或修改 IANA 时区：

```sh
yui config show
yui config system set time-zone Europe/London
```

WorkItem 审查只有一条可选的全局规则，并直接复用已有 Global Role 的
Agent、model、权限、prompt 和 Skills：

```sh
yui config workflow set review --role reviewer --trigger always
yui config show
yui config workflow clear review
```

对带 Project 的软件交付，可使用 `--trigger final` 提供默认 Reviewer Role；
是否需要独立的 Task-final Review 仍由 Leader 根据风险判断：

```sh
yui config workflow set review --role reviewer --trigger final
```

每个进入 Leader 验收阶段的结果，都会成为原 WorkItem 上一个明确的候选。
当前全局规则对所有新旧 Task 的下一个候选生效，并在候选提交时形成快照；
后续 `set`/`clear` 不会改变已经在途的判断。
`always` 会为每个候选启动 ReviewRound，包括已结束的 Role Turn 结果和 Leader 直接管理的
结果；`leader` 则让候选保持等待验收，由 Leader 直接 accept 或执行
`yui task work review <task-id>/<work-item-id>`。因此只要配置了审查规则，Leader
管理的候选也不会直接标记为完成。ReviewRound 引用不可变候选，审查
Turn 不创建新 WorkItem，也不会递归触发审查。审查以自然语言结果
唤醒 Leader；Leader 决定验收、reject 后在原 Role 与原 Session 中修复、
再次审查，或通过 InputRequest 询问用户。审查失败会保留为可见证据并
唤醒 Leader，但不会取代 Leader 的最终判断。
`final` 不为每个 WorkItem 创建完整 ReviewRound，也不决定 Task 拓扑。Leader
显式请求 Task 级 Review；不可变 Task contract 也可以强制要求。Task-final Round
直接冻结 Task main，不需要虚构 WorkItem/Candidate，因此没有 WorkItem 的小任务也能
review。冻结头变化时创建新的语义 Round；同一 Reviewer 的兼容原生 Session 可以在
稳定 workspace 中继续，而每个 Turn 仍严格绑定自己的 Round 和冻结头。旧报告保留为
证据。Reviewer 按 Project Policy/Knowledge 检查整个 Task，并只报告有直接证据的
可达、重要、可行动问题或有限验证缺口。
所有候选、ReviewRound 和 Leader 决策都集中在原 WorkItem 下；reject
后的下一轮会复用原执行 Role、Session 与 workspace，并追加新候选。

显式 WorkItem Candidate Review 与 Task-final Review 默认都直接创建一个 main
Reviewer Turn；只有 Leader 明确提供至少两个不同的 `--lane-role` 时才使用复制执行。
所有 Producer Lane 在隔离 workspace 中检查同一冻结 Assignment，全部 settle 且至少
两个成功后，才创建一个权威 main synthesis Turn。自动 policy 触发的 Candidate
Review 始终保持直接执行。

```sh
yui task work review <task-id>/<work-item-id>
yui task work review <task-id>/<work-item-id> \
  --lane-role security-reviewer --lane-role correctness-reviewer

yui task review request <task-id> --role reviewer
yui task review request <task-id> --role reviewer \
  --lane-role security-reviewer --lane-role correctness-reviewer
```

查看已有 Task 的详细状态时，优先使用 `task context`。它一次聚合 Task、Brief、Active Decision、最近的 Milestone、Role、当前及最近的 WorkItem 与关联 Turn、最近的 Message、Open/Resolved InputRequest 和 Event。终端输出会精简历史和长文本；`yui --json task context <task-id>` 会在顶层 `data` 中返回完整记录。

Task identity 由一个有界交付目标决定，而不是由涉及几个仓库决定。带仓库的
Task 可以绑定多个 Project，并为每个 Project 记录独立 base ref：

```text
<workspace>/tasks/<task-id>/main/
├── backend/
├── frontend/
└── shared-sdk/
```

`<workspace>/tasks/<task-id>/main` 是逻辑上的多 Project 容器，不是 Git 仓库。
每个 Project 子目录才是受支持的 Git cwd（例如
`<workspace>/tasks/<task-id>/main/yui`），并指向该 Project 的受管 worktree：
`<workspace>/worktree/<project>/<task-id>/main`。Git 命令必须在对应的
Project 子目录中运行。只绑定一个 Project 时，原生 Agent 直接从该 Project
的受管 worktree 启动，因此会按 Agent 自身机制发现项目配置和 Skills。
绑定多个 Project 时，Agent
从逻辑根目录启动，Yui 通过 Provider 原生的 additional-directory 机制声明
每个 Project worktree。创建时应一次绑定已知 Project；如果同一目标在执行中
确认还需要另一个仓库，只能由 active Task 的 Leader 追加：

```sh
yui task create "升级认证协议" \
  --project backend --project frontend \
  --base backend=develop --base frontend=main
yui task project add <task-id> shared-sdk --base main
```

实现型 WorkItem 必须声明允许修改的 Project。它保留与 Task main 一致的
相对目录布局，只为写入范围创建隔离 worktree，其他 Task Project 作为上下文
从 Task main 暴露。Yui 会在受管派发和 `yui-worker` Skill 中明确列出可写与
仅上下文 Project，由 Agent 严格遵守该边界。原生 Agent 权限作用于整个会话，
而 Profile `access` 只是行为意图，不是 provider sandbox 或写入授权。所有受管 Role binding（包括
`explorer`）默认使用 `permission.strategy=bypass`，避免 provider 权限提示阻塞
正常工作；Profile 与 Skill 负责约束行为，只有精确 WorkItem/ReviewRound 范围
和匹配的 managed workspace 才能授权修改 Project。Role 也可以显式选择
`default`，或用 `configured` 保留显式设置的任意 provider 原生权限选项子集。

写入范围只能扩大，不能缩小。Worker 报告还需要另一个仓库后，
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
yui operator status
yui operator list
yui operator resume
yui operator resume --last
yui operator new
yui operator enter
```

当 Task Role 当前的原生 Session 无法继续时，只需按意图重置：

```sh
yui task role reset <task-id> <role> --reason "<该 generation 无法继续的原因>"
```

Yui 从自己的记录中推导当前 Turn、Agent、launch、receipt 和 native Session。
它只失败化该精确 active Turn（以及对应 execution WorkItem），把当前 Session
保存为 broken history，并要求 Controller 只停止该 Role 拥有的 runtime。该命令
不会创建 Candidate、验收工作或完成 Task。cleanup pending 期间，`task role status`
和 `task context` 会阻止 fresh launch；已有 message、review 和交付历史都会保留。

不带 `--task` 时会创建新 Draft。Draft 可以继续规划，但激活前不会执行 Agent 工作。
Operator 会结合 Project Catalog 和现有 Task context 路由请求。同一有界
目标的追加需求、修复、审查和咨询继续进入原 Task，即使它涉及多个 Project。
目标、所有权边界或生命周期独立时才创建新 Task。需求、Bug 和咨询共用同一
Task/WorkItem 模型，不增加额外任务类型。
`operator status` 将 GlobalRole 选中的唯一 active writer 与保留的历史对话
分开展示。`operator list` 按固定的最近更新时间倒序展示历史对话，并显示 Agent
及可读的标题或摘要；底层 provider session ID 始终保持内部实现细节。
若 adapter 尚未提供这些元数据，Yui 会显示 provider 和稳定的 Yui
短引用，确保无标题会话仍可区分。`operator resume` 使用轻量历史编号列表，
`--last` 可直接恢复最近一条；新建会话不会伪装成 resume 选项，必须显式使用
`operator new`，并把原对话保留在历史中。

从已配置的全局 Worker 创建 Task Role，应用 Profile 并派发 WorkItem：

```sh
yui config role show worker
yui task role add <task-id> implementer --profile implementer
yui task role show <task-id> implementer

yui task work create <task-id> "实现导出器" \
  --project app --role implementer
yui task work isolate <task-id>/<work-item-id>
yui task work dispatch <task-id>/<work-item-id> --input "完成实现并运行聚焦测试"
```

不传 `--lane-role` 时，assignee 直接在 WorkItem 主工作区执行。若要让多个生产者
基于完全相同的冻结 Assignment 独立执行，必须传入至少两个不同的 Task Role；
单个 Role、重复 Role 或 assignee 本身都会被拒绝：

```sh
yui task work dispatch <task-id>/<work-item-id> \
  --input "完成实现并运行聚焦测试" \
  --lane-role producer-a --lane-role producer-b
```

Lane 是可恢复的逻辑槽。成功 Lane 指向不可变的 Producer Turn 结果；Turn 失败时
Lane 仍保持 open，并显示为 `needs-attention`。Leader 对精确失败 Turn 执行重试或
显式结算：

```sh
yui task turn retry <task-id>/<failed-turn-id>
yui task turn settle <task-id>/<failed-turn-id>
```

Yui 会等待所有 Lane 结算。至少两个 Producer 成功结果才会为 WorkItem assignee
幂等创建一个主 Turn；成功数不足时本次 WorkItem 尝试失败，不会降级使用单个结果。
主 Turn 重试继续引用同一来源 Group，也不会重跑成功 Lane。只有成功的主 Turn 能
形成 Review 与 Integration 使用的 Candidate。`task work show`、`task work list`、
Task context 和 Web 控制室从相同持久事实推导执行形态、恢复目标、综合资格、主 Turn、
Candidate 溯源、下一步及责任人。缺失事实保持 `unknown` 或 `unobserved`；token、
耗时和工具调用只读展示，不参与调度、恢复或生命周期决策。

每个 Agent binding 只有一套 adapter-specific 权限枚举配置：`default` 遵循
provider 默认行为；`bypass` 编译 provider 支持的 bypass flag；`configured`
保留其中显式设置的原生选项。Codex 选项是 `sandbox` 和 `approval`；Claude 选项是
`mode`、`allowedTools` 与 `disallowedTools`。provider 权限与 Profile 行为意图、
Project 写入授权彼此独立：普通写入只由精确 WorkItem 范围和匹配的 managed
workspace 授权。任意非 Leader
Task Role 在创建时不传 `--agent`，都会复制全局 Worker Role 的完整 Agent
bindings，Leader 无需重新拼接 model、effort 和权限。创建回执与
`task context` 分别记录 Profile intent、精确可写 Project 与实际 permission strategy。显式
`--agent` 属于 Task 专用覆盖，必须在派发前补全并回读配置。

ReviewRound 从冻结 Candidate SHA 创建独立的可写 worktree。只有 exact
ReviewRound owner、reviewRoundId、冻结 base 与 workspace 全部匹配时，才获得
该 workspace 的写入授权；Skill 仍禁止 push、Integration、Task state、其他
workspace 与真实 YUI_HOME 变更。Reviewer 以最终 Provider 回复交付当前 Turn，
Yui 自动保存其完整的自由格式 Markdown 或 JSON 报告。如果 JSON 含已知的 `checks` 或
`evidenceCommit` 字段，Yui 会把它们记录为结构化证据，并核验 commit 是否等于
managed Review branch HEAD；未知字段仍保留在完整报告中。

Reviewer 可以修改文件并在不提交的情况下结束 Turn；脏字节不会被推断为 evidence。
该 Round 仍会精确终结且不产生 Candidate/ChangeSet，workspace 会为 Leader 判断而
保留，cleanup 会在其重新变干净前拒绝删除。

Provider 原生 Turn 终态会结束 Turn，Yui 保存最终回复，将 WorkItem 提交给 Leader 审查，并追加结果消息和
唤醒 Leader；它不会验收或完成 WorkItem。Leader 不会自唤醒，pending wake
会保留到 Leader 空闲。

如果无法最终判断结果，交接必须明确标为 `uncertain`、`incomplete`、
`blocked` 或 `requiring Leader judgment`，并提交最完整且真实的身份、已执行
动作、仓库状态、检查与错误、最后生命周期边界、未完成工作、待决事项、风险、
置信度及有界下一选项。Turn 结果只是不可变的执行证据；
它不表示验收、WorkItem 完成、ChangeSet capture、Integration 或 Task 完成。

对于有界工作，Leader 可以直接执行 roleless WorkItem，也可以在当前
Agent 对话中创建 native subagent：

```sh
yui task work create <task-id> "审查实现" \
  --objective "返回有源码依据的问题" \
  --accept "每个问题都标明受影响路径"
yui task work update <task-id>/<work-item-id> running
yui config profile show reviewer
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
Turn。

隔离 Task Role 的结果按“Provider Turn 终态记录 Turn 结果 → Leader 语义审查 → capture 当前
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

Worker Turn 完成不等于 WorkItem 完成。Leader 审查结果、验证和最新
ChangeSet 集成后再显式验收：

```sh
yui task work accept <task-id>/<work-item-id> --summary "验收标准满足。"
```

使用 `task work reject` 退回待验收结果以便修复和重新派发，使用
`task work retire <task>/<work> --summary "..."` 退役过时工作，并可选指定
replacement。WorkItem、Integration
worktree 与检查日志会作为证据保留，直到显式清理。

错误的历史指令或执行记录可以从运行投影中废弃，而不删除审计证据：

```sh
yui task message retire <task>/<message> --reason "已被新指令替代"
yui task turn retire <task>/<turn> --reason "无效的启动记录"
```

这些命令追加 retirement 事实；列表和审计仍保留并标记原 Message、
WorkItem 或 Turn，而受管 Turn 上下文、actionability、恢复、Review 证据和调度会忽略
它。活动 Turn 会先按精确身份终态化；重复废弃是幂等操作。Message 与
Turn 只能由用户或全局 Operator 废弃，WorkItem 也可由所属 Task Leader
废弃。

长期 Task 不依赖 native transcript 恢复。Leader 每次结束 Provider Turn 前更新 Brief
的 focus 和 leader summary；材料性技术选择写入 Decision；可独立汇报的
阶段成果写入 Milestone；只有跨 Task 稳定有效的信息才进入 Project
Knowledge。

当活动 Leader Turn 必须获得用户决定才能继续时，可以创建持久 InputRequest，然后以真实的 blocked 结果结束当前 Provider Turn：

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

`task input list` 是权威的全局开放输入 Inbox；可附加 Task ID 限定范围，或使用 `--all` 查看已回答和已取消的请求。Task 完成、退役、Leader attention、stall 和开放输入只以不可变 TaskEvent 或 InputRequest 引用进入全局 Operator mailbox。Controller 把一个待处理 batch 合并成一条带回执的 `[Yui updates]` user message，仅投递给已有且 ready 的 Operator；Operator 再通过 CLI 读取引用记录，判断哪些信息值得呈现。Operator 正在运行或不可用时，Yui 不启动也不打断它，整批引用保持持久化，并在原生 turn 完成或后续 Controller 处理中重试。该路径是 user message，不是 tool call，也不会读取或分类 Agent 终端文本。用户和 Operator 都可回答。存在开放请求时，无关的 pending wake 不会绕过等待，Task 也不能 complete 或 archive。原 Leader 也可执行 `yui task input cancel <task-id> <input-id> --reason "..."`，取消会排队恢复该固定 Leader session。

```sh
yui task context <task-id>
```

需要查看单个集合或记录时，再使用 `task work`、`task message`、`task turn` 和 Task Knowledge 下的细分命令。

完成目标后，可将 Task 标记为 completed，从而停止自动唤醒，同时保留 session 和 Task main worktree：

```sh
yui task complete <task-id> --summary "CSV 导出已交付并验证"
yui task reopen <task-id>
```

completed Task 在显式 reopen 前会拒绝消息、派发、进入 session、重试和迟到的
Turn 交付。终态 WorkItem、Review、Integration 与 Lane worktree 会作为非阻塞的
completion advisory 返回，但必须在 archive 前处理。每个隔离 WorkItem worktree
仍需显式标记 integrated 或 abandoned，清理时也会删除其受管分支；archive 还必须
通过 `--integrated` 或 `--abandon` 明确 Task main 的处理结果，之后才会停止
session 并清理干净的 Task main。Task 与 WorkItem 记录都会保留，Task main 分支
作为恢复信息保留，不会被静默删除。
Task 生命周期的交互选择只展示有效来源状态：activate 只展示 Draft，complete 只展示 active，reopen 只展示 completed。

## Session 与 tmux

受管理的 Provider 会话仍然是普通用户会话。Yui 只添加对应的 Role Skill 与 Session Manifest 指针，并通过 Provider 原生结构化协议提交 Task 工作；Yui 不接管完整对话历史。受管理输入绝不会作为终端按键、粘贴文本或启动 argv 发送。Codex 在只转发字节的 `app-server proxy` 上完成 App Server WebSocket 握手，接入与 Desktop 相同的共享 daemon；原生 thread 可在 Desktop 中直接查看和操作。Task execution stop 只终止 Yui 的 Agent Host、WebSocket 与 proxy，保留共享 daemon、原生 thread、Task、WorkItem、代码与持久消息；start 创建新的 attachment。Claude 继续使用独立的持久 stream-json 进程，并以精确回放的 user message 作为接收确认。

Session、Activation 与 Turn 是独立身份。Session 可以跨多个 Turn 和客户端连接；Activation 只代表 Yui 当前的连接，而不是对 Provider thread 的独占所有权。每次 Provider 执行对应一个持久 Turn；写入超时或结果不明确会进入 `delivery-unknown`，不会自动重发。Codex 已存在的 active Turn 只会让 Yui 暂时等待，不会导致待投递 Turn 失败；Claude 等独立进程 Provider 继续通过 Yui 的 view/takeover 边界进行人工控制。

Turn 是 Role 是否有工作正在执行的唯一持久调度状态，记录可见输入、来源/渠道与最终回复，不复制思考过程或工具调用。所有经 Yui 中转或生成的输入统一使用 `source: yui`；Provider UI 中直接输入的消息使用 `source: user`；显式 Goal continuation 使用 `source: provider`。Provider Turn 终态后 Yui 完成该 Turn，再把下一个 Turn 投递到同一 Session。TaskRole 本身只保存身份和期望启动配置，不再保存可写的运行状态；CLI/Web 展示的 Role 状态由活动 Turn 派生，并叠加 Session/Driver 生命周期事实用于诊断。

Goal 是 Session 级显式 Provider 事实，可以跨越多个 Turn。Codex 通过 Goal API/事件提供，Claude 通过 `active_goal` 提供；Yui 不用静默等待来猜测 Goal 是否完成。Turn 结束不等于 Goal、WorkItem 或 Task 完成，只有 Leader 更新 WorkItem 与 Task 的持久语义。

Task Role 使用以下显式入口：

```sh
yui session enter <global-role>
yui session stop --all
yui task role view <task-id> <role>
yui task role takeover <task-id> <role>
yui task role release <task-id> <role>
```

Codex Role thread 可在 Desktop 中直接查看和操作；Desktop 已有 active Turn 时，Yui 只保留待投递工作并等待，不会失败或重复投递。`view`、`takeover`、`release` 继续作为 Claude 等独立进程 Provider 的人工控制入口。Yui 不写入全局 Hook/config，也不启动、重启或停止共享 daemon；Codex CLI/daemon 故障由 Task 生命周期之外修复。Global Operator 与 global Role 继续使用原生交互式 CLI，不属于受管理 Task Provider 协议；Yui 在内部将 Codex 的 Global TUI 连接到同一个默认 App Server，用户不能通过 Agent 或 Role 参数覆盖该连接，Session Manifest 自带不依赖启动进程环境的 Global Context 命令，因此同一 thread 可直接切换到 Desktop 继续对话。

当新版本需要离线迁移 Home 时，应等待当前 Turn 完成，然后从普通 shell
执行 `yui session stop --all`，再重新执行 `yui update`。停止命令会先整体预检：
只要仍有 Session 正在运行或存在未决生命周期工作，就不会开始停止；全部空闲
时会先阻止新的 Leader 调度，停止并等待 Controller 完全退出，重新检查运行时
事实后再停止 Task Role 和 global Role Session。成功后 Controller 保持停止，
应紧接着执行 `yui update`。如果当前安装版本还没有这条命令，应手动退出提示中
列出的全部 managed Session；新的 staged CLI 不能写入尚待迁移的旧 Home。

tmux 会在 pane 创建时固定其历史容量。配置该限制之前创建的 Role 会保留原容量；Yui 会在 Terminal attach 和 Web 中提示用户退出并重新进入一次，从而创建具有 100,000 行历史的新 pane。

每个 Role（包括 Operator）可绑定多个 Agent，但任一时刻只有一个 active Agent，
并为每个 Agent binding 独立保存 native session。同一种 adapter 可以有多个
binding，用于不同账号、模型、profile 或环境来源；这些 binding 是预先保存、
可随时切换的配置，而不是并行 writer。Operator 可为
每个 binding 保留多条历史对话。`operator new` 与 `operator resume`
复用唯一的 Operator tmux pane；存在运行中进程时，Yui 会先确认再停止
并切换。跨 Agent 切换默认复用已保存的 model/effort，只有用户明确选择
更新时才进入现有配置选择流程。

受管理 Session 的普通工作流命令统一调用 PATH 中的 `yui`。Session Manifest
与持久 Role/Turn fence 负责身份认证，CLI 和 Controller 只需满足协议与存储兼容，
不会因包版本升级而使现有 Session 失效；Provider 回调等内部路径仍保留精确围栏。
`update` 会幂等刷新旧版本生成的精确 CLI wrapper，使历史 Session 也转为这一
兼容入口。

使用 `yui config role unbind <global-role> <agent-id>` 或 `yui task role unbind <task-id> <role> <agent-id>` 可移除休眠 binding。active binding 或任何未 stopped 的 native session 都会被拒绝；stopped session 记录会和 binding 在同一事务中删除。

Claude 的 session ID 在启动前分配，并由持久 stream-json Provider 进程承载多个 Turn；Codex 使用持久 App Server thread。两者都复用同一套 Conversation、Activation、Turn 与 authority fence，不再向模型对话注入 session-bind prompt。

自动生命周期与投递判断只使用 Provider 原生事件或受支持 Hook 的结构化 payload、持久身份、tmux process
state、receipt 与 pane fence。Yui 不会解析 prompt glyph、进度文本、trust dialog
或其他 Agent 终端输出来推断 ready 或 success。`captureRole()` 只用于显式的人类
transcript 查看，不具备生命周期权威。

稳定的 Role 上下文不会创建额外的 bootstrap Turn。Task execution Turn 按角色使用通用 Leader 或 Worker Skill，review Turn 则按持久 Turn purpose 使用通用 Reviewer Skill；Provider 可以通过安全的追加式原生上下文通道携带 Skill，也可以在普通 Task 投递中指向它。这些都只是 Yui 自己拥有的可移植编排规则。Project Skills 始终是 Project 中正常版本化的文件，由 Agent 通过自身项目机制发现、选择并按需加载；Yui 不扫描、不解析、不复制，也不注入 Project Skills。Managed Codex 保留用户原有的 developer instructions；普通 Task 消息会携带精简的 Session Manifest 绝对路径，Manifest 再指向对应的 Yui Role Skill，供 Codex 按需读取。model、effort、permission、workspace 与 shell 设置作为共享 daemon 上的线程级 `thread/start` 或 `thread/resume` 配置传入；Codex 原生 config profile 因无法隔离到单条共享 thread 而被拒绝，Yui 不修改底层 Codex 配置文件。App Server 原生通知是 Managed Codex 线程的生命周期权威；Yui 不为它安装 Hook，也不占用 `notify`。交互式 Codex Session 仍可使用 Yui 的结构化 `notify` callback，Doctor 会报告最终生效的配置冲突。`skills.config` 只负责启停已发现 Skill，Yui 不会误用它。Claude 从 Yui 管理的私有 `0600` context 文件读取同一份 Yui Role Skill 内容，不再把大段或敏感文本放进 argv；重试和 resume 会复用按 purpose 区分的稳定路径。非 Operator 的 global Role 保持中性，不会注入 Task 编排 Skill。因此 Operator 会停在空白的原生 composer，用户输入仍是第一条 user message；Leader wake、Worker 和 Reviewer Turn assignment 仍是邮箱投递的真实工作消息。

## Controller 与失败处理

每个 `YUI_HOME` 有一个后台 Controller：

```sh
yui controller status
yui controller stop
yui controller restart
```

`controller restart` 会用当前安装的 Yui 版本替换 Controller 进程及其调度循环、socket 服务，不会停止或重启已受管的 tmux/Agent 会话；普通 Session 命令按协议与存储身份兼容，不要求 Controller 与 CLI 包版本完全相同。

成功的 `setup`、`upgrade` 和 `update` 都会确保当前 Home 有一个运行中的
Controller；如果之前没有运行，会在完成后启动。只读命令和
`upgrade --dry-run` 不会启动 Controller。`update` 只有在新二进制健康检查通过后，
才会替换或启动 Controller。

恢复 reconciliation 默认每 120 秒执行一次。普通持久状态变化只会将 Task、Role 或 Operator key 放入队列并立即返回；固定 100ms 窗口内到达的 key 会合并触发一次不重叠的定向处理。Operator 呈现使用独立 lane，不会被 Task 的 Git/worktree 操作阻塞；周期 Git/worktree 处理只覆盖仍有持久 Task mailbox 工作的 Task，活动 Role 的存活检查合并为一次 tmux inventory。来自 Provider 原生事件或受支持 Hook 的结构化 Agent Driver observation，会经过精确 fence 后进入持久 runtime inbox。终态 Turn observation 会原子记录精确的 Turn 结果。持久 WorkMailbox 会冻结当前 processing 批次，期间的新事件合并到下一 pending 批次；失败会释放当前批次供恢复。推荐输入与 pending Turn 共用最近 deadline 选择器，不依赖恢复扫描间隔；显式 `task reconcile` 仍会立即请求恢复扫描。保留的闭环为：

1. 准备 active Project Task 的主 worktree；
2. 停止 archived Task 的 tmux，并只清理干净 worktree；
3. 投递排队的 Worker Turn；
4. 检测活动 Role 进程退出；
5. Leader 空闲时投递 pending wake。

自动输入只通过 tmux 投递。每次处理只做一次非阻塞的 process-state readiness 检查；启动阶段忙碌时通过小型有界 mailbox timer 重试，后续忙碌会话通常由 Codex turn-complete 事件再次唤醒。pane 内 receipt 可避免 Controller 重试时重复输入同一 Turn。

Role 进程未产生 Provider 终态结果就退出时，Controller 会失败对应 Turn 和 running WorkItem，并唤醒 Leader。恢复状态通过精简的 Jobs 视图呈现：

```sh
yui jobs list
yui jobs retry leader-recovery:<task-id>
yui task reconcile <task-id>
yui task turn retry <failed-turn-id>
```

`jobs` 不是旧版通用队列，只展示持久 Leader wake 和 Leader recovery failure。

completion 是可逆的执行屏障。只有活动工作已处理且所有 worktree 干净时才能归档；归档停止 Task 的 tmux session 并移除托管 worktree，但保留 Task 记录。脏 worktree 会让 Task 保持 completed，供后续处理。

## 本地 Web 控制室

默认在 loopback 地址启动本地控制室：

```sh
yui web
# Yui web control room: http://127.0.0.1:4173
```

可用 `--port <port>` 或 `--host 127.0.0.1|::1|localhost` 修改监听参数。Yui 会拒绝非 loopback host，因为控制室会展示 Task、Role、WorkItem、Turn、Message、Decision、Milestone 和 InputRequest 等信息。服务启动时生成的随机 token 会嵌入页面，并保护写操作和终端连接。

Web 端可以通过与 Terminal 相同的持久化 CLI 路径回答 open InputRequest，也可以通过原生 xterm 客户端 attach 到已有 Operator、Leader 或 Worker tmux pane。关闭浏览器终端只会 detach 当前 tmux client，Agent 进程与对话继续保留；Web 不复制 transcript，也不维护第二套会话状态。

控制台默认打开概览驾驶舱：四个运营指标（进行中任务、等待你处理的输入、已完成任务、总数）、跨任务的关注收件箱（把所有 open InputRequest 连同问题和紧急程度集中展示，无需进入任务即可回答），以及当前进行中的任务列表。选中任务后进入带锚点的详情视图（摘要、焦点、工作项、运行、角色、历史、消息），顶部标签栏会跟随滚动高亮当前所在分区。

控制室支持 English 与简体中文，首次打开时跟随浏览器语言，也可以手动切换并记住选择。主题选择器可在深色「控制室」、浅色「纸本台账」和深蓝「Atlas 深空」之间切换。语言与主题偏好只保存在浏览器 `localStorage`，不会修改 `YUI_HOME`。

## 管理命令

```sh
yui update
yui config agent add|list|show|capabilities|update|remove
yui config role add|list|show|update|remove|bind|unbind
yui config profile add|list|show|update|remove|reset
yui config completion [bash|zsh|fish]
yui session enter|record|replace|reconcile
yui project add|clone|update|discover|list|show|knowledge
```

Agent 环境变量绑定只保存进程环境变量名，不保存 secret 值；raw args 不能覆盖 adapter 管理的生命周期参数。

## 范围

Yui 面向一台机器上的一个受信任本地用户。它的 Web/API 仅支持 loopback，不包含远程或多用户 Web、分布式协调、backup/import/export、trash/restore、derived index、recovery journal、runtime lease、inactivity TTL、cooldown 或 recurring schedule。

持久化和调度细节见 [ARCHITECTURE.md](../ARCHITECTURE.md)。

## 本地开发

```sh
npm ci
npm run build
npm test
npm run lint
```

`npm test` 只保留秒级核心 smoke：CLI 启动、正常 SQLite Task、受支持迁移和内置
Agent Driver。针对当前修改编写的 TDD、异常数据和故障复现仅作为开发期证据，需求完成后
删除，不累积为常驻回归测试。具体约束见
[验证策略](../docs/testing/verification-levels.md)。

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

若只想隔离运行当前 checkout、而不改动全局 `yui`，构建它的本地 launcher，而不是执行 `link`：

```sh
make install-local
./output/dev/bin/yui doctor
```

`make install-local` 会在 `output/dev/bin/yui` 写入一个自包含 launcher，并且完全不碰用户级 `yui` 命令。该 launcher 会自行解析所在 checkout，并把 `YUI_HOME` 默认指向本 checkout 的 `output/dev/home`；因此 Yui 从 `YUI_HOME` 派生的所有实例标识（Controller socket、tmux server、state）都会与其他 checkout 或全局安装保持隔离。该命令是幂等的，拉取新代码后可重复执行（若已有 Controller 在运行，再执行 `./output/dev/bin/yui controller restart`）。请以绝对路径调用该 launcher，作为每个 checkout 稳定的入口；把 `output/dev/bin` 加入 `PATH` 只是单个 shell 会话的便捷做法。

`make install-local` 会先 build 出 `dist/`，然后只写入一个文件——launcher 本身。它不会修改 `PATH`，也不会创建数据 home，因此在需要状态的命令之前先执行一次 `./output/dev/bin/yui setup`。注意：裸敲 `yui` 是按 `PATH` 解析的，**与当前所在目录无关**；即使人在本 checkout 目录里，裸 `yui` 也不会用到本地 launcher，仍然会执行 `PATH` 找到的那个（通常是全局 `yui`）。要选中本实例，请使用 launcher 的绝对路径；或仅针对某一个交互式 shell，把它前置到 `PATH`：

```sh
export PATH="$PWD/output/dev/bin:$PATH"   # 仅当前 shell 生效；不适用于自动化
```

这也是推荐给 agent 和脚本的入口：执行一次 `make install-local`，之后在任意工作目录下以绝对路径调用 `<checkout>/output/dev/bin/yui ...`。不要依赖 `export` 跨命令留存，因为每条命令都在全新进程中运行。

## 许可证

[MIT](../LICENSE)
