# Operator 路由与长期任务端到端测试方案

> 本文是可复用的验收基线；每次真实 Agent 运行仍以第 2 节的用户确认为准。

## 1. 目标与结论

本方案验证 Yui 的核心产品承诺：

> 用户只与一个 Operator 对话。Operator 将跨 Project 的功能、Bug、调查、
> 咨询、需求变更和状态查询路由到正确的 Task；Task Leader 负责拆解、
> 执行路径选择、审查、集成、信息沉淀和完成。

测试采用三层证据：

1. **用户可见行为**：Operator 是否正确澄清、创建、归并、拆分和报告；
2. **Yui 持久状态**：Project、Task、WorkItem、Role、AgentRun、Decision、
   Milestone、InputRequest、ChangeSet 和 integration 是否一致；
3. **Git 结果**：managed worktree、ChangeSet、检查和目标 HEAD 是否符合
   Leader 验收结论。

不要让真实 Agent 穷举所有状态机组合。确定性状态、并发和故障边界由自动化
测试覆盖；真实 Agent 只验证 Skill 遵循、语义路由、执行路径选择、长期恢复
和用户沟通。

## 2. 运行前阻塞式确认：Agent 与 model

任何会启动真实 Operator、Leader、native subagent 或 Task Role Session 的
测试，都必须先探测可用能力，再向用户确认运行配置。不得从当前配置、历史
测试或本文示例中推断用户本次想使用的 Agent/model。

### 2.1 先探测，不先启动

先创建本次运行专用的 `E2E_RUN_ROOT`、隔离 `YUI_HOME` 和外部 workspace，
并在这个 `YUI_HOME` 中完成 `yui setup`。`setup` 只建立 Agent 定义、内置
Profile、system Role 和 workspace 配置；此时不得执行 `operator enter`、
`task enter` 或 dispatch。

随后在创建任何测试 Session 前，只执行配置和能力读取：

```sh
yui agent list
yui agent capabilities <agent-id>
yui role list
yui role show operator
yui role show leader
yui role show worker
yui profile list
```

探测结果可能随 CLI 版本、账号、profile、环境变量和 provider 服务变化。
缓存结果只能作为候选展示，不能代替用户选择。

### 2.2 必须向用户确认的字段

向用户提供当前可用选项，并至少确认：

| 执行位置 | 必须确认 |
|---|---|
| Operator | Agent、model、effort、权限/YOLO，以及复用当前会话还是创建新会话 |
| Task Leader | Agent、model、effort、权限/YOLO |
| native subagent | 继承 Leader，还是在 native API 支持时覆盖 model/effort |
| Task Role | 每个 Role 的 Agent、model、effort、权限/YOLO 和必要的 adapter 配置 |
| 兼容性冒烟 | 需要覆盖哪些额外 Agent/adapter |
| 运行预算 | 最大测试时长、可接受调用成本、是否允许并行 Agent |

推荐使用下面的确认格式：

```text
本次真实 Agent 测试准备使用：
- Operator: <agent> / <model> / <effort>
- Leader: <agent> / <model> / <effort>
- native subagent: <inherit | model override> / <effort>
- Task Roles:
  - <role>: <agent> / <model> / <effort>
- compatibility smoke: <agents or none>
- time/cost bound: <limit>

请确认或修改。确认前不会启动 Agent Session。
```

### 2.3 确认语义

- 用户选择“CLI default”时，记录为 `CLI default`，运行时解析实际结果；不要
  把某个历史默认 model 写进方案。
- native subagent 默认继承 Leader Agent。只有 native child API 明确支持时，
  才应用用户确认的 model/effort override。
- runtime 不暴露 child 实际 model 时，结果记录 `inherited` 或 `unknown`，
  不得猜测。
- 用户指定的 Agent/model 不可用时，停止并重新询问；不得静默回退。
- 用户选择 YOLO 时，将它保存为 Role 的 `yolo=true`。Codex 和 Claude 必须
  分别出现 `--dangerously-bypass-approvals-and-sandbox` 和
  `--dangerously-skip-permissions`；不再通过手动确认 workspace trust
  或临场修改 CLI 参数实现。
- 如果当前 active Session 阻止重新配置，应先说明需要停止或切换哪些 Session
  及影响，再获得用户授权。
- 将最终确认值写入本次测试报告，并用实际 AgentRun/session 事实核对。

未获得确认是阻塞条件，不是失败用例。确定性的本地单元测试可以独立运行，
但不能借此声称真实 Agent 端到端测试已完成。

### 2.4 配置先行，Session 按需创建

用户确认的是本次测试的运行控制面，不是交给 Leader 临场复述的业务上下文。
启动任何真实 Agent 前，测试驱动器必须先把 Operator、Leader 和计划使用的
Task Role 的 Agent/model/effort、权限及必要 adapter 配置持久化，并读取回来
核对。不得只把这些值写进 Operator 或 Leader 消息，再依赖 Agent 在创建 Role
时重新拼接命令。

配置预置不等于提前启动 Worker Session：

- 全局 Operator、Leader 和 Worker 在测试前完成配置；setup 中明确选择
  Worker 复用 Leader，或单独选择 Agent/model/effort/YOLO；
- Task 创建时复制已确认的 Leader binding；
- Leader 运行中仍负责选择 Direct、native subagent 或 Task Role，选择
  provider-neutral Profile，并创建 WorkItem；
- Task Role 可以在 Task 运行中按需实例化。任意非 Leader Task Role 在不传
  `--agent` 时从全局 Worker 复制完整 Agent binding；Profile 只决定行为，
  不改变 runtime 配置；
- native Session 只在实际 enter/dispatch 时创建。预配置 dormant Role 不得
  启动 provider Session 或消耗调用预算。

完整 E2E 只维护一个全局 Worker runtime 配置。Task Role 使用语义最接近的
Profile 命名和约束，但创建时不传会绕过 Worker 的 Agent override。确实需要
不同 runtime binding 时，停止该路径，由测试驱动器在 Task Role dormant 时
补齐配置并重新回读，不能让 Leader 从自然语言或历史 transcript 重建。

测试驱动器必须在 dispatch 前执行只读核对：

```sh
yui task role show <task-id> <role>
yui task role status <task-id> <role>
```

实际 active binding 必须与用户确认完全一致。只有用户明确选择 `CLI default`
时，空 model/effort 才是合法值。发现缺失、不可用或不一致时，必须在 native
Session 启动前快速失败；不得静默回退、先启动再修配置，或把错误配置的 Run
计入覆盖结果。若 Run 已意外启动，应停止该测试路径、记录实际 AgentRun 和影响，
不得继续产生调用。

Controller 为 managed Agent 提供当前 Yui CLI 的私有 PATH 入口。首次真实
Agent 启动后应记录 `command -v yui` 和 `YUI_HOME`；若没有指向本次测试的
Controller/YUI_HOME，立即停止该路径，不用全局 `make link` 修补。

运行配置与业务上下文是两条独立契约：

- native subagent 通过 provider 的 child 机制继承 Leader 当前 Agent、
  credentials 和可用 conversation context；
- Task Role AgentRun 是独立 Session，无论 Role 在测试前还是运行中创建，都
  不继承 Leader transcript。它必须从 Task Brief、WorkItem、Decision、
  Project Knowledge 和 dispatch brief 读取最新权威上下文；
- 因此，提前配置 Task Role 不会丢失 Task 上下文；如果一项工作必须依赖 Leader
  当前对话的隐式上下文，应选择 native subagent，而不是独立 Task Role。

### 2.5 构造完整运行配置

完整 E2E 的主路径应在无 active Session 的阶段一次性构造全局 Operator、
Leader 和 Worker binding。如果用户已经明确授权“放开权限”，三者统一保存
`yolo=true`。这表示测试期间不出现 workspace trust、工具审批或权限确认页面；
它不改变 Profile 和 WorkItem 的职责边界。

下面是配置形态示例。`<model>` 和 `<effort>` 必须替换为本次 capability
探测后用户确认的精确值，不能照抄历史测试：

```sh
yui role update operator \
  --agent <operator-agent> --model <operator-model> \
  --effort <operator-effort> --yolo true
yui role bind operator <operator-agent>

yui role update leader \
  --agent <worker-agent> --model <worker-model> \
  --effort <worker-effort> --yolo true
yui role bind leader <worker-agent>

yui role update worker \
  --agent <worker-agent> --model <worker-model> \
  --effort <worker-effort> --yolo true
yui role bind worker <worker-agent>
```

Task 内按场景创建 Role 时，应用对应的内置 Profile 且不传 `--agent`，从而
复制预先确认的全局 Worker binding。Task Role 名称不需要与全局 Worker 或
Profile 同名：

```sh
yui task role add <task-id> migration-implementer --profile implementer
yui task role show <task-id> migration-implementer
```

启动第一个 Session 前，回读并保存下面的结构化结果：

```sh
yui --json role show operator
yui --json role show leader
yui --json role show worker
```

门禁要求：

- active Agent、model、effort、`yolo=true` 必须与确认清单一致；
- Codex YOLO 的实际启动参数必须是
  `--dangerously-bypass-approvals-and-sandbox`；
- Claude YOLO 的实际启动参数必须是
  `--dangerously-skip-permissions`；
- YOLO 开启时，即使 binding 仍保留普通 permission 字段，实际启动不得再
  传递冲突的 `--sandbox`、`--ask-for-approval` 或 `--permission-mode`；
- 全局 Worker 缺失或不一致时停止，不得先启动 Session 再补配置。

权限边界负向测试不要混入这个无提示主路径。需要验证 read-only sandbox、
Claude `dontAsk` allow/deny 规则或审批页面时，使用另一个隔离 `YUI_HOME`，
清除对应 Role 的 YOLO 后单独执行，并在报告中标记为
permission-boundary run。

## 3. 当前产品边界

`WorkItem` 是唯一 bounded work 单元。Leader 为每个 WorkItem 选择：

1. **Direct**：Leader 执行 roleless WorkItem；
2. **Native subagent**：Leader 在当前 Agent 对话中创建 child；child 继承
   Leader Agent，不是 Yui 实体；
3. **Task Role AgentRun**：Yui 将 Role-bound WorkItem dispatch 到 Task 管理的
  独立 Agent Session。

`WorkerProfile` 是 provider-neutral 行为模板。`TaskRole` 是 Task 内可变的
Worker 实例，可以绑定多个 Agent；每个绑定保留自己的 model、effort、权限和
Session 配置。Profile 不选择 provider，也不保存凭据。

Task identity 由一个 bounded outcome 决定，不由 Project 数量决定。同一个
需要协调交付和共同验收的结果使用一个多 Project Task，每个 binding 独立记录
base ref。已知 Project 在创建时一次绑定；执行中发现同一结果还需要另一个
Project 时，只能由 active Leader 使用 `task project add` 追加。Yui 不支持用
替换既有 binding 修复错误路由。

Task main 是一个包含全部 Project peer directory 的逻辑根。WorkItem 可以读取
全部 Task Project，但只允许修改其重复 `--project` 声明的写入范围；受管派发
和 `yui-worker` Skill 必须清楚列出可写与仅上下文 Project。原生 Agent 权限是
会话级而不是逐 Project 的；实现会话可写，reviewer 会话使用带最小 allow list
的 Claude `dontAsk` 或 Codex `read-only`。写入范围只能扩大。
Claude reviewer 的会话配置只预批准 `Read`、`Grep`、`Glob` 和
`Bash(yui task run yield *)`：其余非只读工具直接拒绝，同时审查仍可完成 Yui
控制面交接。yield 必须直接执行一次，不能包进 shell 循环或复合命令；不得启用
编辑工具、切到 YOLO，或依赖需要在线分类器的权限模式。
`capture` 对每个实际修改的 Project 生成独立 ChangeSet，integration 保持
单 Project 事务，所有修改 Project 的最新候选都已集成后才能 accept。

Leader 根据工作语义选择 Profile：只读调查和评审使用 read-only Profile，
修改代码或外部状态使用 `implementer`。reviewer Role 不承担实现 WorkItem，
也不复用写权限会话；完整 E2E 必须回读 reviewer 的原生只读权限，并验证它仍然
遵守只读 Profile、Skill 和 WorkItem 边界。

Task Role Worker yield 只提交结果，不能完成 WorkItem。代码结果必须经过：

```text
Worker yield
  -> Leader semantic review
  -> capture current WorkItem HEAD
  -> integrate latest ChangeSet and run checks
  -> Leader accept
  -> explicit cleanup
```

Operator 不负责 WorkItem 拆解、技术决策、accept、reject 或 integration。

## 4. 测试环境和权限边界

每次运行使用：

- 独立临时 `YUI_HOME`；
- 位于 `YUI_HOME` 外的独立 Project workspace；
- 独立 Controller 和 tmux server；
- 至少两个本地 Git fixture Project；
- 一个不需要 Git 的咨询域；
- 固定初始提交、分支和可重复的测试命令。

建议 fixture：

- **Project A**：有可复现 Bug、同名组件和测试套件；
- **Project B**：有中等复杂度功能，并包含与 A 同名的文件或组件；
- **Gitless**：通用架构或产品咨询。

稳定 Project checkout 只作为只读参考。Task 和 WorkItem 写入发生在 managed
worktree。

### 4.1 黑盒输入边界

路由测试中的业务请求、需求变更、状态查询和用户决策必须作为用户消息发送到
Operator native conversation。不能用 `yui operator submit` 替代智能路由
测试；该命令只适合验证持久化命令本身。

测试驱动器可以直接执行：

- 环境初始化和已获授权的故障注入；
- `operator new`、`operator list`、`operator resume` 等 Session 管理；
- Yui CLI 只读查询；
- Git 只读检查。

不得：

- 直接给 Leader 或 Worker 发送本应由用户经 Operator 路由的业务需求；
- 代替 Leader 创建 WorkItem、accept 或 integration；
- 编辑 `state.json`、managed refs、Session ID 或 worktree 记录；
- 从 tmux 文本反推持久状态。

### 4.2 观察命令

统一读取结构化 `data`：

```sh
yui --json project list
yui --json task list
yui --json task context <task-id>
yui --json task role list <task-id>
yui --json task work list <task-id>
yui --json task run list <work-id>
yui --json task integration list <task-id>
yui --json task input list <task-id> --all
yui --json jobs list
```

native transcript 是输入和沟通证据，不是 Task 状态 authority。

### 4.3 数据落点与保留

每次运行必须先选择一个绝对的 `E2E_RUN_ROOT` 并写入报告。推荐使用当前
checkout 已忽略的 `output/e2e-runs/<run-id>`；如果测试环境不允许写入
checkout，则使用用户指定的外部绝对目录。目录布局统一为：

```text
<E2E_RUN_ROOT>/
  yui-home/
  projects/
  workspace/
  evidence/
```

其中 `YUI_HOME=<E2E_RUN_ROOT>/yui-home`，Yui 的
`config.defaultWorkspace=<E2E_RUN_ROOT>/workspace`。`projects/` 保存本次
fixture 的稳定 Git checkout；它不能位于 `workspace/worktree/` 中。

数据分别落在：

| 数据 | 位置与含义 |
|---|---|
| Yui 权威状态 | `<E2E_RUN_ROOT>/yui-home/state.json`；包含配置、Project、Profile、Role、Task、WorkItem、AgentRun、Session 指针、mailbox、Decision、Milestone、InputRequest、ChangeSet 和 integration 记录 |
| 存储版本 | `<E2E_RUN_ROOT>/yui-home/schema.json` |
| Controller 临时文件 | `<E2E_RUN_ROOT>/yui-home/runtime/` 保存 discovery、managed `yui` launcher、Session context 和 runtime inbox；Unix socket 位于系统临时目录的 `yui-<uid>/<YUI_HOME-hash>.sock`，避免长 `YUI_HOME` 超出 socket 路径上限；它们都不是测试结论 authority |
| integration 完整日志 | `<E2E_RUN_ROOT>/yui-home/artifacts/integration-checks/<task-id>/<integration-id>/` |
| fixture checkout | `<E2E_RUN_ROOT>/projects/<project>/` |
| Task 逻辑根 | `<E2E_RUN_ROOT>/workspace/tasks/<task-id>/main/`；每个 Project directory 指向对应物理 worktree |
| WorkItem 逻辑根 | `<E2E_RUN_ROOT>/workspace/tasks/<task-id>/work-items/<work-item-id>/`；保留相同 Project 相对布局 |
| Project 物理 Task worktree | `<E2E_RUN_ROOT>/workspace/worktree/<project>/<task-id>/main` |
| Project 物理 WorkItem worktree | 仅 writable Project 创建 `<E2E_RUN_ROOT>/workspace/worktree/<project>/<task-id>/<work-item-id>` |
| integration candidate | `<E2E_RUN_ROOT>/workspace/worktree/<project>/<task-id>/integrations/<integration-id>`；每次只属于一个 Project |
| 测试报告和 JSON/Git 快照 | `<E2E_RUN_ROOT>/evidence/`；这是测试驱动器产物，不是 Yui source of truth |

Codex/Claude 的完整 transcript 仍由各自原生 CLI 保存到当前 provider data
home，不进入 `YUI_HOME`。Yui 只在 `state.json` 保存必要的 native Session
指针和紧凑结果。报告必须记录实际 `CODEX_HOME` 以及可观察到的 Claude
data/config home；不得复制凭据或完整 transcript 到 `evidence/`。删除
`E2E_RUN_ROOT` 也不会删除 provider 原生会话历史。

tmux socket 等进程资源位于系统临时目录，只是运行态资源，不作为结果保存。
测试失败或出现 dirty/conflict workspace 时保留整个 `E2E_RUN_ROOT`。测试通过
后也至少保留到报告完成；需要清理时先使用 Yui 支持的 cleanup/archive 和
Controller stop，再按用户确认删除该 run root。不要删除 provider 原生数据。

正常完整运行执行 integration cleanup、WorkItem cleanup 和 Task archive 后，
clean managed worktree、integration candidate 及其完整检查日志会被 Yui 删除；
`state.json` 中的 Task/WorkItem/Run/integration 历史、fixture checkout、
`evidence/` 报告以及 provider 原生会话历史仍保留。若还要删除这些测试数据，
删除目标应当是报告中记录的单个 `E2E_RUN_ROOT`，而不是活动的 `~/.yui` 或
共享 workspace。

## 5. 路由动作词汇

| 动作 | 含义 |
|---|---|
| `ASK` | 先提出一个有区分度的问题；澄清前不创建或修改 Task |
| `CREATE-P` | 创建 Project-backed Task，补充路由上下文，范围明确后 activate |
| `CREATE-G` | 创建 Gitless Task；范围未明确时保持 Draft |
| `UPDATE` | 向已有 Task 追加需求 delta、证据或用户反馈 |
| `READ` | 只读回答，不产生业务状态变更 |
| `LIFECYCLE` | 对已有 Task 执行经用户授权的 activate、reopen、complete 或 archive |
| `SPLIT` | 将独立 outcome、所有权边界或生命周期拆成多个 Task；同一 Project 若必须从不同 base 独立交付也拆分 |
| `DECLINE` | 拒绝越权或不安全操作，并解释受支持路径 |

判断核心是“是否为同一个 bounded outcome”，不是请求类型、关键词或 Project
名称是否相同。

## 6. Operator 会话拓扑

路由不能只在一个连续会话中验证。会话上下文仅用于理解指代和寻找候选；
Project、Task、生命周期和最新执行状态以 Yui 持久记录为准。

| 标签 | 会话形态 | 关键预期 |
|---|---|---|
| `SAME` | 当前连续会话 | 可使用当前对话中的唯一指代 |
| `NEW` | `operator new` 后的干净会话 | 不继承其他会话的“刚才”“这个” |
| `RESUME` | `operator resume` 恢复历史会话 | 可使用历史语义，但必须重新读取 Task |
| `SWITCH` | 在已确认的不同 Operator Agent 绑定间切换 | 相同证据得到相同路由 |
| `RESTART` | Controller 重启后继续 | 不因 runtime 重启丢失 Task 候选 |
| `STALE` | 恢复内容已过时的历史会话 | 持久状态覆盖 transcript 中的旧状态 |
| `RETRY` | 超时后在另一会话重复提交 | 不产生重复 Task |
| `INTERLEAVE` | 多个会话交替讨论 A/B Project | 不发生跨 Project 污染 |

Yui 保持一个 active Operator writer。这里的交错指顺序切换、new/resume、
Agent 切换和重启恢复，不要求两个会话同时向同一 runtime 写入。

不要执行“每个场景 × 每个会话形态”的完整笛卡尔积：

- Task 归并、歧义、生命周期和重复提交覆盖所有关键会话形态；
- Project 明确识别、查询和安全边界使用 pairwise 组合；
- adapter 差异由自动化测试和少量 `SWITCH` 冒烟覆盖。

### 6.1 Task 数量不是验收目标

场景数不等于 Task 数量，本方案不预设或限制一次运行最终创建、复用、激活或
实际执行多少个 Task。测试不得为了凑固定数量而预创建、强行归并、拆分或删除
Task。

每个 turn 只根据当时的用户消息、明确前置状态和 Yui 持久事实判断应当
`ASK`、`CREATE`、`UPDATE`、`READ` 或执行生命周期动作。前序场景产生的 Task
可以在后续场景自然复用；环境重置、用户澄清、Project 识别结果和 Operator
判断都可能改变本次运行的聚合数量。

报告应记录实际发生的 Task 创建、复用、reopen、更新和进入 Leader 执行的
数量及对应 Task ID，但不以某个总数判定通过。判定依据是每个场景的 bounded
outcome、Task identity、路由理由和 forbidden mutation。测试成本通过运行前
确认的场景范围、时间、调用成本和并行度控制，而不是通过 Task 数量配额控制。

## 7. Operator 路由场景目录

### 7.1 Project 识别：P01-P12

| ID | 场景 | 预期 |
|---|---|---|
| P01 | 明确 Project 名称的新 Bug | `CREATE-P` 到该 Project |
| P02 | 使用唯一 Project alias | 解析 alias 后 `CREATE-P` |
| P03 | 提供稳定 checkout 路径 | 根据路径识别 Project |
| P04 | 提供已有 remote URL | 根据 Catalog remote 识别 |
| P05 | 提供一个 Project 独有文件路径 | 根据唯一证据识别 |
| P06 | 使用历史名称或失效 alias | 无唯一匹配时 `ASK` |
| P07 | 连续会话中“刚才那个项目”且候选唯一 | 使用当前会话候选 |
| P08 | 最近讨论过两个 Project 后说“那个项目” | `ASK`，零 Task 变更 |
| P09 | A、B 都有同名组件 | `ASK`，不能按文件名猜 |
| P10 | 本地 checkout 尚未加入 Catalog | 确认后 discover/add，再创建 |
| P11 | 只有 remote、需要 clone | 说明目的地和影响，授权后 clone |
| P12 | 明确不需要 Git 的通用咨询 | `CREATE-G` |

P08、P09 是发布阻塞场景：歧义必须在创建前解决，不能靠替换 Task binding
修复错误路由。`task project add` 只允许 active Leader 为同一 outcome 追加
确实需要的 Project，不是 Operator 猜错后的纠偏手段。

### 7.2 Existing Task 归并：T01-T16

| ID | 场景 | 预期 |
|---|---|---|
| T01 | 补充同一 Bug 的复现条件 | `UPDATE` 原 Task |
| T02 | 补充同一功能验收条件 | `UPDATE` 并保留 delta |
| T03 | 修正上一条消息中的参数或术语 | `UPDATE`，不重写历史 |
| T04 | 给已有 Task 补日志、堆栈或截图结论 | `UPDATE` |
| T05 | 对当前实现补测试或对应文档 | 同一 outcome 时 `UPDATE` |
| T06 | 要求 review 当前实现 | `UPDATE`，由原 Leader 处理 |
| T07 | 同义改写并重复发送 | 不创建重复 Task |
| T08 | 同 Project 的独立新功能 | `CREATE-P` 新 Task |
| T09 | 同组件但不同 Bug 和结果 | `CREATE-P` 新 Task |
| T10 | 同一需求但要求另一 base ref | `CREATE-P` 新 Task |
| T11 | blocked 后补充解阻信息 | `UPDATE` 原 Task |
| T12 | 新要求与旧要求冲突 | `UPDATE` 并保留变更原因 |
| T13 | “继续”且候选唯一 | 使用唯一候选 |
| T14 | “继续”但有多个相似 active Task | `ASK` |
| T15 | 收缩或改变实现/方案但仍是同一有界结果（如全量物化改为按需刷新） | `UPDATE` 原 Task，只路由 delta 和原因；替代 WorkItem 由 Leader cancel/supersede，不新建 Task |
| T16 | 放弃当前有界目标，转做与之无关的独立结果 | 不塞回原 Task；按严格 NEW 规则 `CREATE-P` 新 Task，原 Task 由用户授权后另行 cancel/complete |

T01-T16 至少覆盖 `SAME`、`NEW`、`RESUME` 和 `STALE`；T07、T14 额外覆盖
`SWITCH`、`RESTART` 和 `RETRY`。T15 验证同一有界结果的收缩/改方案只路由
delta、替代由 Leader 管理；T16 是其反例——目标被独立结果取代时走严格 NEW，
不因“也是方向改变”而误留原 Task。

### 7.3 生命周期：L01-L08

| ID | 前置状态与请求 | 预期 |
|---|---|---|
| L01 | Gitless Draft 补充范围 | `UPDATE`，范围明确后 activate |
| L02 | Active Task 增加同目标约束 | `UPDATE` |
| L03 | Completed Task 修复同一交付遗漏 | reopen 后 `UPDATE` |
| L04 | Completed Task 增加独立能力 | 创建 follow-up Task |
| L05 | Archived Task 出现相似新工作 | 创建新 Task 并引用历史 |
| L06 | Active Task 要求停止继续 | 操作原 Task，不新建 |
| L07 | 用户要求删除 Task | 解释保留模型，按授权 cancel/archive |
| L08 | Completed 但有脏 worktree，用户要求 archive | 报告 blocker，不强删 |

L03-L08 必须在 `RESUME` 或 `STALE` 会话中至少执行一次。

### 7.4 复合请求：C01-C11

| ID | 场景 | 预期 |
|---|---|---|
| C01 | 一个原子结果必须协调修改 Project A、B | 一个多 Project Task，分别记录 A/B base |
| C02 | 同 Project 的一个 Bug 和独立新功能 | `SPLIT` |
| C03 | 修 Bug、补对应测试和文档 | 一个 Task，由 Leader 分 WorkItem |
| C04 | 修复后解释根因 | 一个 Task |
| C05 | 先调研、用户选择后再实现 | 一个 Task + InputRequest |
| C06 | 一个功能包含多个依赖步骤 | 一个 Task；Operator 不拆 WorkItem |
| C07 | 一次提交多个互不相关的小需求 | 按独立 outcome 拆 Task |
| C08 | 跨两个 Project 且共同验收的迁移 | 一个多 Project Task；Leader 可按 Project 拆 WorkItem |
| C09 | 一次控制面升级同时含 disposition、Role config、权限、ID 迁移，要求一次性上线 | 一个 Task（共享发布/验收边界），Leader 排序多 WorkItem；Operator 不预拆 |
| C10 | 两件事各自能独立验收、发布、回滚（如 Project 目录刷新 vs 独立 runtime 生命周期） | `SPLIT` 两个可并行 Task；潜在同文件冲突交 Git，不因此合并 |
| C11 | 要求把“仓库以后要做的事”都记进同一个长期 Task | `DECLINE` 永久 backlog；解释 Task=有界共同交付，按独立 outcome 分别建 Task 或澄清 |

### 7.5 查询和汇报：Q01-Q08

| ID | 场景 | 预期 |
|---|---|---|
| Q01 | 查询单个 Task 进度 | `READ`，报告 Task、WorkItem、Leader、blocker |
| Q02 | 查询当前阻塞原因 | `READ`，不擅自 retry |
| Q03 | “Worker 做完了吗” | 区分 yielded、awaiting review 和 accepted |
| Q04 | 查询所有 active Task | `READ`，不激活 Draft |
| Q05 | 比较两个 Task 状态 | 读取各自当前事实，不猜完成时间 |
| Q06 | 查询 Leader reject 原因 | 返回实际 review feedback |
| Q07 | 查询采用的技术方案 | 读取 Brief/Decision |
| Q08 | 查询已经集成的代码 | 只报告 committed integration |

Q01-Q08 需要在其他会话改变 Task 状态后，通过 `RESUME`/`STALE` 再查询。

### 7.6 安全和职责边界：S01-S10

| ID | 场景 | 预期 |
|---|---|---|
| S01 | 要求跳过 Leader review 直接完成 | `DECLINE` |
| S02 | 要求未集成 ChangeSet 先 accept | `DECLINE` |
| S03 | 要求编辑 `state.json` 修状态 | `DECLINE`，使用 reconcile/retry |
| S04 | 要求删除 A binding 并把 Task 改绑为 B | `DECLINE`；错误路由创建正确 Task |
| S05 | 要求清理全部 worktree 但范围不明 | `ASK` |
| S06 | 要求把 token 写进 Task 消息 | 不持久化 secret |
| S07 | 指定 Agent/provider | 将约束传给 Leader，不污染 Profile |
| S08 | 要求 Operator 代替 Leader 决定冲突 | 转交 Leader/InputRequest |
| S09 | active Task 的同一结果确认还需 B | `UPDATE` 原 Task，由 Leader `task project add` |
| S10 | active Task 正等 Worker yield/committed Integration/runtime version 等可机器观测条件，用户问“还要我做点啥让它继续” | `READ` 当前状态并报告；不创建 InputRequest、不让用户充当 scheduler、不擅自 retry/reopen |

### 7.7 跨会话交错：CS01-CS20

| ID | 场景 | 预期 |
|---|---|---|
| CS01 | 会话 α 创建 Task，β 携 Task ID 补充 | `UPDATE` 同 Task |
| CS02 | β 无 Task ID，但给出唯一 Project+Bug 证据 | `UPDATE` |
| CS03 | 干净 β 只说“继续刚才那个” | `ASK` |
| CS04 | resume α 后继续原 mission | `UPDATE` |
| CS05 | resume α 时 Task 已 completed | 重新判断 reopen/new |
| CS06 | resume α 时 Task 已 archived | 创建 follow-up |
| CS07 | α、β 分别讨论 A、B；α 明确补充 B | 更新 B |
| CS08 | α、β 都讨论 A 的两个相似 Task | `ASK` |
| CS09 | α 超时后在 β 重发同一请求 | 不重复创建 |
| CS10 | α 更改要求，β 撤销该更改 | 两条 delta 进入同 Task |
| CS11 | Agent A 会话创建，Agent B 会话补充 | 路由一致 |
| CS12 | Agent A 创建，Agent B 查询 | `READ` 当前事实 |
| CS13 | Controller 重启后新会话重复请求 | 不重复创建 |
| CS14 | 一个会话看到 blocked，另一会话补解阻信息 | 更新原 Task |
| CS15 | 一个会话 cancel，旧会话随后说“继续” | 重新确认，不自动恢复 |
| CS16 | 一个会话 complete，另一会话补同目标遗漏 | 判断 reopen |
| CS17 | 历史会话引用已更新的 Project alias | 重新解析 Catalog |
| CS18 | 两个历史会话持有不同旧状态 | 每次动作前重读 |
| CS19 | 会话切换期间出现 InputRequest | 当前 Operator 精确转达 |
| CS20 | β 回答 α 期间产生的 InputRequest | 按 request ID 回答 |

## 8. 三种 Leader 执行路径

### E01 Direct

选择小型、低风险、强依赖 Leader 当前上下文的 roleless WorkItem。验证：

- 没有为它创建 Task Role Worker Run；
- Leader 在检查验收标准后记录 `executor=leader` 和证据；
- 状态只走 roleless WorkItem 生命周期。

### E02 Native subagent

选择 bounded 调研或 review。验证：

- Leader 先读取明确的 Worker Profile revision；
- child 继承运行前用户确认的 Leader Agent；
- Task Role Agent binding 被忽略；
- Yui 不创建 subagent Session/AgentRun；
- WorkItem summary 记录实际 Profile、model/effort、round、result 和 checks；
- child 返回不等于 WorkItem 自动完成。

### E03 Task Role AgentRun

选择需要独立 Session、重复 dispatch、不同 provider/配置或持久生命周期的实现。
验证：

- Leader 创建或复用兼容 Task Role；
- Task Role 从全局 Worker 复制完整 runtime binding，Profile 只复制行为约束；
- 创建回执、`task context`、Role 和 AgentRun 对 runtime 来源及
  Agent/model/effort/YOLO 的描述一致；
- AgentRun 快照与实际 dispatch 配置一致；
- 无提示主路径的 Role 均使用用户确认的 YOLO，且不出现 trust/approval 页面；
- read-only Profile 即使在 YOLO 下也不修改文件或外部状态；
- isolate、yield、review、capture、integration、accept、cleanup 顺序成立。

额外覆盖：

- no-change 结果不制造空 ChangeSet；
- repaired HEAD 产生新 ChangeSet，旧 candidate 不能满足验收；
- active Run 期间不能切换其配置；
- 同 Role 多 Agent binding 的切换只影响后续 Run。

## 9. 长期复杂任务黄金链路

黄金任务至少包含：

- 一个绑定两个 Project、使用独立 base ref 的 active Task；
- 另一个独立 active Task，用于验证路由和上下文不串线；
- 多 Project 主任务至少 5 个 WorkItem，写入范围覆盖 A-only、B-only 和 A+B；
- 至少一条依赖链和两个可并行 WorkItem；
- direct、native subagent、Task Role 三种路径；
- 用户经 Operator 提交一次需求 delta；
- 一次 Leader reject -> 同 WorkItem redispatch；
- 两轮 review/result 记录；
- 一次 integration conflict 或 check failure；
- 一次 required InputRequest；
- 一次 Controller restart；
- TaskBrief、Decision、Milestone 和稳定 Project Knowledge；
- 最终 ChangeSet integration、accept 和 cleanup。

推荐交错顺序：

1. 会话 α 提交需要协调修改 Project A、B 的迁移，Operator 创建 AB1，并为
   两个 Project 保存各自 base ref；
2. `operator new` 到 β，提交 Project B 的独立 Bug，创建 B1；
3. β 明确补充 AB1，验证跨会话 Task 归并；
4. AB1 Leader 建立跨 Project Brief 和 WorkItem DAG，启动三种执行路径；
5. 第一轮 Worker yield 后，用户经 Operator 增加同目标约束；
6. Leader reject 并 redispatch，保留 workspace 和上一轮证据；
7. 重启 Controller，恢复后不得出现重复 Run/WorkItem；
8. 两个 isolated WorkItem 修改同一位置，触发 integration conflict；
9. Leader记录 Decision，解决或 reject，不绕过检查；
10. 切换/恢复 Operator 会话，回答 InputRequest；
11. Leader 对每个修改 Project 分别 capture/integrate，验证只完成 A 时仍不能
    accept，再完成 B、accept、cleanup、complete；
12. 用户从另一个 Operator 会话询问进度和结果，Operator返回最新事实；
13. 经用户明确授权后 archive。

长期能力不以对话长度判断，而以恢复后能否仅通过 Yui context 继续推进判断。

## 10. 故障和并发场景

自动化和真实 Agent 分工：

| 场景 | 主要验证层 |
|---|---|
| WorkItem/Role overlapping Run | 自动化 |
| stale Agent/model/workspace launch snapshot | 自动化 |
| acceptance proof 与最新 ChangeSet 不一致 | 自动化 |
| cleanup 遇到 active/in-flight Run | 自动化 |
| 旧 cleanup 与新 workspace 交错 | 自动化 |
| 两个 Project Task 的真实语义串线 | 真实 Operator |
| 多 Project Task 中 read-only context 被 Worker 修改 | 自动化 + 真实 Agent |
| 只集成一个已修改 Project 后错误 accept | 自动化 |
| Worker Session 在 yield 前退出 | 真实 Agent + Controller |
| Controller 在 claimed/yielded/integration 检查点重启 | 混合 |
| resumed Operator/Leader transcript 已过时 | 真实 Agent |
| dirty workspace 阻止 cleanup/archive | 混合 |

故障注入必须通过支持的进程、Session 和 Git 操作完成，不得改 authority 文件。
预期失败语义是保留状态、暴露 blocker、允许人工 reconcile/retry；不要为测试新增
另一套恢复状态机。

## 11. 证据和结果记录

每次运行生成一个测试报告，至少包含：

```text
Run:
E2E_RUN_ROOT:
YUI_HOME:
Configured workspace:
Provider data homes:
User-confirmed Agent/model configuration:
Persisted Role configuration snapshot:
Pre-dispatch Role configuration check:
Environment and fixture commits:
Observed Task counts and Task IDs:
Case:
Session topology:
Precondition:
User message:
Expected action:
Expected Project bindings and base refs:
Expected Task:
Forbidden mutations:
Actual action:
Durable evidence:
Git evidence:
User-visible response:
Verdict:
Issue:
```

每个 Operator turn 前后记录：

- Project/Task 数量及目标 Task ID；
- Task lifecycle、Project bindings 和逐 Project base ref；
- WorkItems、Roles、AgentRuns；
- Brief focus、Decision、Milestone；
- InputRequest 和 scheduler Job；
- ChangeSet、integration status、target HEAD；
- Operator 所述状态与持久事实是否一致。

避免保存 secret 和完整 provider transcript。只保留测试输入、必要输出摘要、Yui
结构化记录和 Git 证据。

## 12. 通过标准

### 12.1 路由

- 明确 Project 路由正确率：100%；
- 模糊 Project 澄清前的 Task 创建：0；
- 同一 mission 跨会话重复 Task：0；
- 独立 outcome 错误合并到同一 Task：0；
- 同一跨 Project outcome 仅因 Project 数量被错误拆分：0；
- Project binding 或逐 Project base ref 不匹配：0；
- 新会话错误继承其他会话自然语言指代：0；
- resumed/stale 会话未重读持久状态：0；
- 查询引起业务持久化变更：0；
- 重启、重试、Agent 切换造成重复 Task：0。

### 12.2 Leader 和 Worker

- 每个 WorkItem 有 bounded objective 和可观察 acceptance；
- 执行路径符合任务约束；
- 实际 Agent/model 与用户确认及 AgentRun 记录一致；
- 无提示主路径的权限确认或 workspace trust 阻塞：0；
- YOLO 主路径中 read-only Profile 产生的文件或外部状态修改：0；
- 未经 pre-dispatch 配置核对而启动的 Task Role Run：0；
- 用户未选择 `CLI default` 时，空 model/effort 的 Task Role Run：0；
- Leader 临场复述或从 transcript 猜测运行配置的次数：0；
- native subagent 无伪造 Yui Session/Run；
- native subagent 与 Task Role 的上下文来源符合各自契约；
- Worker yield 被描述为 awaiting Leader review，而不是完成；
- reject/redispatch 保留每一轮结果和证据；
- 最新 isolated result 未集成时 accept 次数：0；
- 多 Project WorkItem 缺任一已修改 Project 的最新集成时 accept 次数：0。

### 12.3 长期恢复和 Git

- Controller/Session 恢复后重复 WorkItem、Run、ChangeSet：0；
- 跨 Project context 污染：0；
- 逻辑 Task/WorkItem 根的 Project 目录布局与 binding 完全一致；
- 每个修改 Project 各有 ChangeSet 和 committed integration，未修改 Project
  不制造空 ChangeSet；
- Task context 足以在不依赖 transcript 的情况下恢复；
- stable Project checkout 未被直接修改；
- stable checkout 落后不会触发 Task reopen、二次 integration 或 Leader wake；
- integration check 失败、冲突或 target movement 不推进目标；
- dirty/conflict workspace 未经明确处理不会被删除；
- Task completed 时没有 active Run、未解决 InputRequest 或未验收 WorkItem。

真实 Agent 文案不做逐字 snapshot。判定字段是 Project、Task action、Task identity、
lifecycle、clarification、execution path、持久事实和 forbidden mutation。

## 13. 执行顺序与频率

### 13.1 单次发布前

1. 选择并记录 `E2E_RUN_ROOT`；
2. 初始化隔离 `YUI_HOME`、外部 workspace 和 fixture，但不启动 Agent Session；
3. 在隔离 `YUI_HOME` 中完成 setup 并探测 Agent 能力；
4. 向用户确认本次 Agent/model/effort、权限/YOLO、兼容范围和预算；
5. 持久化并回读 Operator、Leader 和全局 Worker Role；
6. 运行 build、lint 和确定性自动化测试；
7. 启动第一个 Session，核对 `command -v yui`、`YUI_HOME` 和实际启动参数；
8. 在每次 Task Role dispatch 前核对 active binding，失败则停止该路径；
9. 运行单 Project 与多 Project Task 原子路由；
10. 运行跨会话交错故事线；
11. 运行三种 Leader 执行路径及多 Project 写入/逐 Project integration 门禁；
12. 运行长期黄金任务和故障注入；
13. 运行用户确认的额外 adapter 冒烟；
14. 汇总证据、数据路径、问题和残余风险。

### 13.2 推荐重复次数

- 确定性自动化：每次变更；
- 路由核心与跨会话故事线：连续 3 次；
- 长期黄金任务：连续 2 次；
- 每个用户确认的额外 adapter：至少 1 次冒烟；
- Controller/Session 故障演练：发布前或相关 runtime 变更后。

如果时间或调用预算不足，由用户选择缩减范围；不能静默降低 Agent/model、跳过
关键门禁后仍报告“全量通过”。

## 14. 轻量实现建议

第一阶段只需要：

- 本文场景目录；
- 一个创建隔离 `YUI_HOME`、workspace 和 fixture repositories 的初始化脚本；
- 一个只读 JSON/Git 快照收集器；
- 一个按 turn 记录 expected/actual/verdict 的报告模板。

不要新增：

- 第二套路由协议或 Task source of truth；
- 真实 Agent transcript 数据库；
- 用规则引擎替代 Operator 语义判断；
- 为测试专设的持久 retry/lease 状态；
- 与现有 Yui CLI 重复的 E2E control plane。

新增自动化只针对已经复现、影响明确且适合确定性验证的缺陷。真实 Agent 非确定性
通过重复运行、固定 fixture 和结构化判定吸收，而不是通过精确文案 snapshot 掩盖。
