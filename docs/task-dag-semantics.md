# T1 契约：Task DAG 语义与调度投影

- 状态：T1 冻结候选（本契约经 Task-final Review 与 Leader 接受后，成为 T4/T6/T9 等下游 Task 可依赖的语义决议）
- 日期：2026-08-23
- 适用项目：Yui（`project-1`）
- 代码基线：`ff613ddcefa67f13b1a56bab261e333a550417ac`
- 上游决议：T0 RFC（task-27，已归档接受）——D-01（双层模型）、D-02（`WorkItem.dependsOn` 唯一 DAG 权威）、§3.5-4（现状 all-completed 门控无限阻塞，T1 必须修复）、§14.1（ready/blocked 精确传播规则与失败传播矩阵下放 T1）
- 性质：架构语义契约。只定义语义与投影，不定义持久化字段、API 签名、迁移代码或调度器实现；这些属于后续实现 Task。

## 0. 决议摘要

`WorkItem.dependsOn` 是 Task 级顺序的**唯一权威**（D-02/I-1）。本契约把现状的单一 all-`completed` 二元门控替换为**边分类 + 传播矩阵**：

1. 每条依赖边按依赖 WorkItem 的持久状态分为四类：`satisfied` / `active` / `failed-open` / `dead`。
2. 每个非终态 WorkItem 由边分类集合与 open InputRequest 的作用域**确定性投影**为：`ready` / `blocked` / `unreleasable`；`input-waiting` 是会阻止 `pending` 项进入 `ready` 的门控，不只是展示标记。
3. `failed` 是**可重试终态**：下游进入 `blocked (dependency-failed)`，不自动级联取消；Leader 选择重试或关闭失败。
4. `retired` 是**永久不可满足**：无替换的退役使下游进入 `unreleasable`；带替换的退役在投影层沿 `replacementWorkItemId` 链重定向，存储的 `dependsOn` 永不改写。
5. **跳过（skip）**是 Leader 对 `unreleasable`（或任何 blocked）WorkItem 的显式退役决议，带跳过原因的 disposition；被跳过的 WorkItem 对其自身下游表现为 `dead`，级联确定。
6. 动态修订（加节点、加边、删边、退役）只允许在**未释放**（`pending`）的 WorkItem 上改边；每次变更重跑存在性、replacement 链和解析 replacement 后的有效依赖图无环校验。
7. Controller 是确定性投影器与不变量执行者；Leader 是唯一的语义规划者与跳过/修订/重试/派发顺序决议者。投影是持久快照的纯函数。
8. CLI/UI 消费**同一个只读投影**：传递式阻塞链、输入等待链、逐节点投影状态；界面不建立第二套状态权威（D-09）。

## 1. 现状机制（已对照 `ff613dd` 源码）

| 机制 | 现状 | 出处 |
|---|---|---|
| 依赖字段 | `WorkItem.dependsOn: readonly string[]`，schemaVersion 9；仅在创建时由 `work create --after` 写入，**创建后无改边命令** | `src/workItem/workItem.ts:117`；`src/commands/taskCommands.ts:2253-2255,2293` |
| 状态机 | 严格 6 态：`pending / running / awaiting_acceptance / completed / failed / retired`；终态需要 outcome；`retired` 不可变 | `src/workItem/workItem.ts:25-31,137-140,253-300` |
| 释放门控 | `selectOpenWorkItem`：`dependsOn.every(dep => byId.get(dep)?.status === "completed")`。**all-completed 二元谓词**：依赖为 `failed`/`retired`/不存在时，下游永不可 ready，无传播/取消/跳过——无限阻塞 | `src/task/nextAction.ts:741-745` |
| 无环校验 | 存储层 DFS `assertAcyclicWorkItems`，写入时与聚合加载时各校验一次，违例抛 `StorageRecordError` | `src/storage/taskStore.ts:4238-4251,1496-1502,3836` |
| 非法依赖 | 模型层拒绝自依赖；存储层拒绝不存在的依赖（同 Task 聚合内） | `src/workItem/workItem.ts:472-473`；`src/storage/taskStore.ts:3838-3840` |
| 失败重试 | `retryFailedWorkItem`：`failed → running`，保留历史 Group，仅清除已解决的 current 指针 | `src/workItem/workItem.ts:408-432` |
| 退役 | `retireWorkItem`：`completed` 不可退役；`failed` 可退役关闭；disposition 可选 `replacementWorkItemId`（同 Task）。**退役不释放、不重定向下游**——下游仍无限等待 `completed` | `src/workItem/workItem.ts:372-401`；`src/commands/taskCommands.ts:3197-3212` |
| 执行投影 | `taskExecutionProjection` 自述为 read-model 词汇（"deliberately not a new [authority]"）；`collectBlockers` 对 pending 且有非 completed 依赖的项产出 "waiting on a dependency" 阻塞（**仅直接依赖，无传递链**）；`failedWork` 使 Task 级投影为 `blocked/work-failed` | `src/scheduler/taskExecutionProjection.ts:23,339-341,710-731` |
| CLI 投影 | `task overview` 对 pending 项列出非 completed 直接依赖（"waiting on X"）；无 ready 集、无传递根因、无 unreleasable 区分 | `src/commands/taskOverviewCommand.ts:386-397` |
| UI 投影 | Web 明细仅以 chip 行展示 `dependsOn` 标题列表；无 DAG 图视图 | `src/web/assets/client/components.ts:462-463`；`src/web/assets/client/i18n.ts:57,355` |
| 输入等待 | `InputRequest.blockedRefs` 可指向 WorkItem 或 Turn，也可为空；存储层只校验所列引用存在。现状 `next-action` 对任意 open InputRequest 作 Task 全局门控，**未区分直接目标、Turn 归属、空引用或无关分支，也无沿依赖边的传递传播** | `src/input/inputRequest.ts:4-8,41-49`；`src/commands/taskInputCommands.ts:93-104,120-128,453-460`；`src/task/nextAction.ts:110-120`；`src/storage/taskStore.ts:3937` |

**结论**：DAG 的存储权威（`dependsOn` + 无环/存在性不变量）已具备；缺的是**释放语义**（边分类与传播矩阵）、**跳过/重定向语义**、**动态修订规则**与**传递式只读投影**。本契约补齐这些语义；调度器实现（拓扑释放、ready 集计算、自动派发）属于后续实现 Task，不在 T1 范围。

## 2. 图与权威

1. **唯一权威**：`WorkItem.dependsOn`（含 WorkItem 自身的 `status` 与 `disposition`）。不存在第二套 TaskGraph 存储、缓存或界面侧状态（D-01/D-02/I-1）。
2. **边方向**：DAG 一律采用“前置项 → 下游项”：`u → v` 当且仅当 `v.dependsOn` 包含 `u`。`dependsOn` 是每个下游节点存储的反向邻接表；根因分析从 `v` 沿入边反向遍历，不能据此改变图的箭头方向。
3. **投影纯函数**：给定同一持久快照 `(dependsOn, status, disposition, Turn.workItemId, open InputRequests)`，投影输出唯一确定，与时间、派发顺序、观察者无关。
4. **表达边界**：DAG 只表达语义与产物依赖；**不表达** Agent、Session、Provider 并发、文件锁或资源配额（属 Layer 2 与 T6 Resource Broker）。
5. **Task 局部性**：依赖边只在同一 Task 聚合内有效。Yui 无 Task-to-Task 原生依赖字段；跨 Task 依赖只记录在 Description/Brief（如本 Task 的 T0=task-27），不创建伪 WorkItem 依赖。
6. **AND 语义**：一个 WorkItem 的释放要求**全部**边满足。OR-join 不可表达——需要 OR 的场景由 Leader 用动态修订（§6）或退役建模。

## 3. 节点状态与投影词汇

### 3.1 持久状态（不变）

WorkItem 仍为严格 6 态机（`pending / running / awaiting_acceptance / completed / failed / retired`）。本契约**不新增持久状态**。

### 3.2 边分类（派生）

对依赖边 `u → v`（v 依赖 u），按前置项 u 的持久状态分类：

| u 的状态 | 边分类 | 含义 |
|---|---|---|
| `completed` | `satisfied` | 已接受结果可用（T0 §3.4-1：只有已接受的上游结果可作下游输入） |
| `pending` / `running` / `awaiting_acceptance` | `active` | 依赖在途，等待其终态 |
| `failed` | `failed-open` | 终态但可重试；失败尚未被 Leader 关闭 |
| `retired`（无替换链到 completed） | `dead` | 永久不可满足 |
| `retired`（带替换，见 §5.2） | 跟随替换链 | 链终止于 `completed` → `satisfied`；`failed` → `failed-open`；活跃态 → `active`；无替换 `retired` → `dead` |

### 3.3 节点投影（派生，仅对非终态 WorkItem）

| 投影 | 条件 |
|---|---|
| `ready` | `pending`、全部边 `satisfied`，且没有作用于该项的 open InputRequest 门控 |
| `blocked (waiting)` | `pending` 且无 `dead`/`failed-open` 边，至少一条 `active` 边 |
| `blocked (dependency-failed)` | `pending` 且至少一条 `failed-open` 边，无 `dead` 边 |
| `unreleasable` | `pending` 且至少一条 `dead` 边 |
| `blocked (input-waiting)` | `pending`、全部边 `satisfied`，但至少一个 open InputRequest 门控作用于该项 |
| `running` / `awaiting_acceptance` | 投影等于持久状态（已释放） |

判定优先级固定为：`dead` → `unreleasable`；否则 `failed-open` → `blocked (dependency-failed)`；否则 `active` → `blocked (waiting)`；否则有输入门控 → `blocked (input-waiting)`；否则 `ready`。`input-waiting` 同时作为标记叠加在 `unreleasable`、`blocked (dependency-failed)`、`blocked (waiting)` 以及已释放的 `running` / `awaiting_acceptance` 上，保留到每个相关 InputRequest 的根因链，但不会回滚已发生的状态迁移。

### 3.4 InputRequest 作用域与门控

每个 open InputRequest 先独立映射为作用域，再把所有作用域取并集；answered / cancelled InputRequest 不参与投影：

1. `blockedRefs` 中的 `work-item:W` 直接门控非终态 W，并沿 W 的 DAG 出边传递到所有非终态下游；其祖先和无关 fan-out 分支不受影响。
2. `turn:R` 若所指 Turn 具有 `workItemId=W`，等价于 `work-item:W`。没有 `workItemId` 的 Turn（例如 Task 级 Leader Turn）映射为 Task 全局门控。
3. `blockedRefs=[]` 表示问题属于 Task 级决议，映射为 Task 全局门控。全局门控作用于 Task 内全部非终态 WorkItem，因此任何 `pending` 项都不得进入 `ready`。
4. 多个引用取并集；其中任一引用映射为 Task 全局门控时，结果即为全局门控。每个被门控节点仍保留全部 InputRequest 根因，不能因选择第一个请求而丢失其他请求。
5. 引用已终态 WorkItem，或引用一个归属已终态 WorkItem 的 Turn，不重开该 WorkItem，也不沿其出边传播；该 open InputRequest 仍是 Task 完成前必须回答或取消的收敛事项。引用不存在或跨 Task 的记录继续由存储边界拒绝。
6. InputRequest 回答或取消后移除对应门控，以最新持久快照完整重算节点和下游；回答/取消本身不把任何依赖边改成 `satisfied`，也不改写 WorkItem 状态。

投影须为每个 `input-waiting` 节点给出可复现的根因链：直接命中为 `W ← InputRequest`；传递命中为 `W ← ... ← U ← InputRequest`；Task 全局门控标记为 `W ← Task InputRequest`。

### 3.5 确定性与单调性

- 投影只随持久 WorkItem、Turn 归属或 InputRequest 状态变化重算；不随时间、不随观察次数变化。
- 状态迁移对投影的影响是确定的：`u: failed → running`（重试）使其边 `failed-open → active`；`u: retired`（无替换）使边 `→ dead`；替换完成使链重定向收敛。
- `ready` 集是调度器的唯一释放输入：现状 `selectOpenWorkItem` 只取第一个 eligible 项（`nextAction.ts:743`）；契约下投影计算**完整 ready 集**，其中的派发顺序是 Leader/策略选择（现状：Leader 手动派发，每 Role 同时一个活跃 Turn；未来自动派发与配额属 T6）。

## 4. 释放与传播规则

### 4.1 释放（ready）

1. WorkItem 在其全部依赖边 `satisfied` 且没有有效输入门控时进入 `ready`；`ready` 是派生状态，不写回。直接命中的无依赖 pending WorkItem 也必须先解除输入门控，不能利用“边集合为空”进入 `ready`。
2. 释放是单调事件：一旦进入 `running`，其依赖边不再影响其投影（已释放）。
3. 扇出示例：A 完成后，B、C、D（均只依赖 A）同时进入 `ready` 集；Leader 决定派发顺序（受每 Role 单活跃 Turn 等现状约束）。
4. 汇合示例：E 依赖 A、B、C；只有三者全部 `completed`，E 才 `ready`——无部分释放、无 OR-join。

### 4.2 阻塞传播（blocked）

1. `blocked` 投影必须携带**传递根因链**，而不仅是直接依赖：若 `w → u → v`，且 w 为 `failed-open`，则从 v 反向遍历入边显示 `v ← u ← w (failed)`。现状 CLI 只显示直接依赖（`taskOverviewCommand.ts:386`），契约要求传递化。
2. 根因链的终点是第一个处于 `failed` / `retired` / input-waiting / 活跃执行 的祖先节点；无环保证链有限。
3. `awaiting_acceptance` 的依赖按 `active` 处理：结果尚未被 Leader 接受，下游不能消费（T0 §3.4-1）。

### 4.3 不可释放（unreleasable）

1. 任一依赖边 `dead` → `unreleasable`，无论其他边状态。
2. `unreleasable` 不是终态（WorkItem 仍 `pending`），但**不会随时间自行解除**——只有 Leader 动作能改变（§5、§6）。
3. 投影必须把 `unreleasable` 与 `blocked` 明确区分：前者需要 Leader 决议，后者是正常等待。现状两者混为同一个 "waiting on a dependency" 阻塞（`taskExecutionProjection.ts:727`），无限阻塞因此不可见——这是本契约修复的核心缺陷。

## 5. 失败、退役与跳过传播矩阵

### 5.1 矩阵

行 = 依赖 WorkItem 的持久状态迁移；列 = 下游投影与 Leader 决议路径。

| 依赖状态 | 下游边分类 | 下游投影 | Leader 决议路径 |
|---|---|---|---|
| `pending`/`running`/`awaiting_acceptance` | `active` | `blocked (waiting)` | 无需动作；等待终态 |
| `completed` | `satisfied` | 释放（全部边满足时 `ready`） | — |
| `failed`（新发生） | `failed-open` | `blocked (dependency-failed)` | ① `retryFailedWorkItem`（→`running`，边回到 `active`）；或 ② 退役该失败项关闭失败（→ 下两行） |
| `failed → retired`（无替换） | `dead` | `unreleasable` | ① 跳过下游（§5.3）；② 修订边（§6.3）；③ 退役下游 |
| `retired`（无替换） | `dead` | `unreleasable` | 同上 |
| `retired --replacement R'` | 跟随替换链（§5.2） | 链终止于 `completed` → 可能 `ready`；否则按链终止态投影 | 无需动作（投影自动重定向）；或显式修订边 |
| 当前 pending 项被 scoped open InputRequest 直接命中 | — | 全部边已满足时 `blocked (input-waiting)`；否则在原阻塞投影叠加 `input-waiting` | 回答/取消 InputRequest → 移除门控并重算 |
| 祖先项被 scoped open InputRequest 命中 | 原边分类不变 + `input-waiting` 链 | 原阻塞投影叠加 `input-waiting`；祖先完成前不释放 | 回答/取消后重算祖先及传递下游 |
| Task 全局 open InputRequest（空引用或无 WorkItem 归属的 Turn） | — | 全部非终态项叠加 `input-waiting`；任何 pending 项不得 `ready` | 回答/取消后全 Task 重算 |
| open InputRequest 只引用终态目标 | — | 不改变 DAG 节点或下游投影 | 仍须在 Task 完成前回答/取消 |

**不自动级联**：依赖失败/退役**不自动**使下游失败或取消。下游保持 `pending`，投影显式标出原因；所有解除动作都是 Leader 的显式持久决议。理由：失败是否可恢复、下游是否仍有价值，是语义判断，属 Leader 职责（T0 §0、§3.1）。

### 5.2 替换重定向（投影层）

1. `retired` 带 `replacementWorkItemId = R'` 时，依赖边的满足性**跟随替换链**：存储边 `R → v` 的有效前置项由解析链 `R ↝ R' ↝ ...` 的终点决定；终点为 `completed` 时该边才 `satisfied`。`↝` 只表示 replacement 解析关系，不是 DAG 边。
2. **存储的 `dependsOn` 永不改写**——重定向是投影规则，不是数据迁移。审计轨迹保留原始边。
3. 定义 `resolve(u)`：沿有限的 replacement 链前进，直到第一个没有 replacement 的 WorkItem。对每条存储依赖 `u → v`，有效依赖图包含 `resolve(u) → v`。状态分类读取 `resolve(u)` 的持久状态，原始 u 只保留审计轨迹。
4. replacement 链自身必须无环；解析所有 replacement 后的**有效依赖图**也必须无自边且无环。反例：已有 `A → B`（B 依赖 A），再令 `A ↝ B`，会得到有效自边 `B → B`，即使两种关系分别看都无环，也必须拒绝。
5. 创建 WorkItem、加/删依赖边、写入退役 replacement 以及聚合加载都按同一 `resolve` 规则校验完整有效依赖图；不能只分别校验 `dependsOn` DAG 与 replacement 链。
6. 若 `R'` 在退役时已 `completed`，且有效图合法，下游在下一次投影中立即 `ready`——确定、无窗口期歧义。
7. 替换不传递语义义务之外的东西：R' 是否承接 R 的意图，由 Leader 在退役 disposition 中记录；投影只做状态跟随。

### 5.3 跳过（skip）语义

1. **定义**：Leader 判定一个 `unreleasable`（或任何 `blocked`）WorkItem 的前置条件永不满足、且无修订价值时，将其**退役并在 disposition 中记录跳过原因与死亡依赖**。跳过是退役的一种语义，不是新持久状态。
2. **级联**：被跳过的 WorkItem 对其自身下游表现为 `dead` → 下游进入 `unreleasable` → Leader 逐节点决议。级联确定、可在投影中预演（"若跳过 X，受影响的下游集合"由传递闭包给出）。
3. **对 failed-open 依赖的跳过**：跳过一个 `failed-open` 依赖的下游，意味着 Leader 把该失败接受为终局。规范顺序是先退役失败依赖（关闭失败）再跳过下游；若直接跳过下游，disposition 必须记录所接受的失败依赖，且该失败依赖之后即使重试成功，跳过项也不复活（`retired` 不可变）——其下游仍经它保持 `dead`。Leader 若想保留复活可能，就不应跳过。
4. **永不自动**：Controller 不自动跳过任何 WorkItem，包括"全部依赖都 dead"的情形。自动跳过会把语义判断埋进投影，违反 D-02 与 Leader/Controller 分界（§7）。
5. 跳过的持久证据是 disposition（summary + 可选 replacement）。未来实现 Task 可选择增加 disposition 判别字段以结构化区分"跳过/过时/取消"——属实现决策，T1 不定义持久化字段。

## 6. fan-out / fan-in 与动态修订

### 6.1 fan-out 与 fan-in

1. **fan-out**：多个 WorkItem 共享同一（组）已满足依赖时，同时进入 `ready` 集。DAG 不限制扇出宽度；实际并发受 Layer 2 与 Resource Broker 约束（现状：每 Role 一个活跃 Turn；T6 统一预算）。
2. **fan-in**：多依赖 WorkItem 在全部边 `satisfied` 时一次性释放（AND-join）。汇合点不产出额外状态——`ready` 即是汇合事件。
3. **菱形**：A → B、A → C、B+C → D。B、C 并行释放；D 等两者都 `completed`。B 失败不影响 C 的释放（边独立分类）；B 被退役且无替换时 D `unreleasable`，C 仍可独立完成。
4. ** ready 集与派发**：投影产出完整 ready 集；派发顺序与并发度是 Leader 决议（现状）或 Resource Broker 策略（T6）。DAG 语义不规定派发顺序，只规定释放合法性。

### 6.2 动态修订：加节点

Leader 可随时追加新 WorkItem（现状能力）。新节点可依赖任意既有节点（含已终态节点）：

- 依赖 `completed` → 立即 `satisfied`（可用于强制顺序/汇合）。
- 依赖 `failed` → 立即 `blocked (dependency-failed)`。
- 依赖 `retired`（无替换）→ 立即 `unreleasable`。
- 创建允许这三种情形，投影使其后果立即可见——不拒绝、不静默。

### 6.3 动态修订：加边与删边

1. **改边只允许在 `pending`（未释放）WorkItem 上**。已释放（`running` 及以后）的 WorkItem 其前置条件已评估完毕，追溯性加边会使历史歧义，故拒绝。
2. **加边 `u → v`**（把 u 加入 `v.dependsOn`）：v 必须 `pending`；u 必须存在且同 Task；replacement 解析后的有效依赖图必须无环。满足后 v 的投影按新边重算（可使 `ready → blocked`）。
3. **删边**：v 必须 `pending`。删边是解除 `unreleasable`/`blocked` 的合法路径（Leader 判定该依赖不再需要）。
4. 现状无改边命令（`dependsOn` 仅创建时写入）；本契约定义其语义，**命令与持久化实现属后续实现 Task**。在该能力建成前，Leader 的等价手段是：退役旧 WorkItem + 以正确依赖创建新 WorkItem（带 replacement 链）。
5. 每次修订都是一次持久写入，重跑全部图不变量（§8），并触发投影重算。修订历史本身是审计记录（revision 递增）。

## 7. Controller / Leader 职责分界

| 职责 | Leader | Controller（Yui Core） |
|---|---|---|
| 创建/连接/修订 DAG（加节点、加边、删边） | ✅ 唯一 | ❌ 不发起 |
| 重试失败、退役、替换、跳过 | ✅ 唯一 | ❌ 不自动 |
| ready 集中的派发顺序与并发度 | ✅（现状）/ T6 策略 | ❌（现状不自动派发） |
| 验收与最终决议 | ✅ 唯一 | ❌ |
| 投影计算（ready/blocked/unreleasable/input-waiting 链） | 消费 | ✅ 确定性纯函数 |
| 不变量执行（存在性、自依赖、替换链无环、有效依赖图无环） | — | ✅ 存储边界强制 |
| 持久化与恢复后投影重建 | 消费 | ✅ |
| 阻塞/根因/输入等待的可见性（CLI/UI） | 消费 | ✅ 同一投影供给 |

**规则**：

1. Controller **永不**自动跳过、自动取消、自动失败级联、自动改写 `dependsOn`。它只报告：`unreleasable` 是给 Leader 的信号，不是动作。
2. Leader **永不**绕过存储不变量直接改图；所有修订经持久命令，违例由存储层拒绝。
3. 投影无隐藏状态：任何观察者用同一持久快照算出同一投影；CLI、Web、`task context` 共享同一 read-model（现状 `taskExecutionProjection` 是该 read-model 的宿主，T9 扩展其 DAG 视图时不得另立权威）。
4. 恢复语义：Controller 重启后从持久状态重算投影，不依赖会话 transcript 或手写 handoff（T0 §6.2）。

## 8. 环路与非法依赖约束

| 约束 | 规则 | 现状/新增 |
|---|---|---|
| 存储 DAG 无环 | 以 `u → v iff v.dependsOn includes u` 定向的存储依赖图必须无环 | 现状：`assertAcyclicWorkItems`（`taskStore.ts:4238`），写入与加载双校验 |
| 自依赖 | WorkItem 不能依赖自身 | 现状：模型层（`workItem.ts:472`） |
| 存在性 | 依赖必须存在于同 Task 聚合 | 现状：存储层（`taskStore.ts:3838`、`taskCommands.ts:2254`） |
| Task 局部 | 不允许跨 Task 依赖边（无原生字段；跨 Task 依赖记录在 Brief/Description） | 现状（存在性校验的推论） |
| 替换链无环 | `replacementWorkItemId` 的 `↝` 链必须无环且有限 | **新增**（与无环同层校验；本契约定义语义，实现属后续 Task） |
| 有效依赖图无环 | 对每条存储边 `u → v` 解析为 `resolve(u) → v` 后，完整有效图不得有自边或环；创建、改边、退役替换和加载统一校验 | **新增**；拒绝 `A → B` 与 `A ↝ B` 组合产生的 `B → B` |
| 改边对象 | 加边/删边只允许 `pending` WorkItem | **新增语义**（§6.3） |
| 终态依赖 | 允许依赖已终态节点；后果由投影立即显式（§6.2） | 现状允许，契约明确不收紧 |

**不禁止**：依赖 `failed`/`retired` 节点（创建时）、菱形、任意扇出/扇入宽度、对已 `completed` 节点的追加依赖。这些都是合法图结构，其行为由传播矩阵完备定义。

## 9. CLI/UI 只读图投影语义

1. **单一投影源**：CLI 与 Web 消费 Controller 的同一 read-model 投影；客户端不重算图语义、不持有第二套状态（D-09）。
2. **逐节点投影**：每个 WorkItem 展示 §3.3 的投影状态（`ready` / `blocked (waiting)` / `blocked (dependency-failed)` / `unreleasable` / `running` / `awaiting_acceptance` / 终态），叠加 `input-waiting`。
3. **传递根因链**：阻塞展示必须从下游沿入边反向回溯到根因（例如 DAG 为 `w → u → v`，展示链为 `v ← u ← w (failed)`），而非仅列直接依赖。现状缺口：CLI 只列直接依赖（`taskOverviewCommand.ts:386`）、投影只产 "waiting on a dependency"（`taskExecutionProjection.ts:727`）。
4. **输入等待链**：input-waiting 展示给出 `WorkItem ← ... ← InputRequest` 或 `WorkItem ← Task InputRequest`；回答/取消后投影重算。
5. **跳过/替换可见**：退役节点展示 disposition（跳过原因、替换指针）；替换重定向在下游阻塞原因中可见（存储边 `R → v`，解析链 `R ↝ R'`，有效边 `R' → v`）。
6. **DAG 视图**（T9 实现）：节点 = WorkItem，边采用“前置项 → 下游项”（`u → v iff v.dependsOn includes u`），节点状态 = 投影，边可按分类标注（satisfied/active/failed-open/dead）。视图是投影的渲染，不是独立数据源；不为表格展示改变领域语义（D-09）。
7. **ready 集可见**：`task overview` 等入口应能列出完整 ready 集（现状只给单个 next-action 候选），使 Leader 的派发顺序选择有完整信息。
8. **只读**：CLI/UI 无 DAG 写路径；所有变更经 Leader 命令（`work create --after`、未来的改边命令、`retire`、`retry`）。

## 10. 与 T0 决议的一致性

- **D-01（双层模型）**：本契约只定义 Layer 1（Task DAG）语义；不引入第二套图存储或运行时。调度投影复用既有 `taskExecutionProjection` read-model 宿主。
- **D-02（唯一权威）**：全部语义从 `WorkItem.dependsOn` + `status` + `disposition` 派生；投影是纯函数；无 TaskGraph 数据源。
- **§3.5-4（现状包络）**：现状 all-completed 门控的无限阻塞由本契约的边分类 + `unreleasable` + 跳过/重定向/改边三条确定路径修复——失败/退役依赖不再静默卡死，而是显式可决议状态。
- **§14.1（下放事项）**：ready/blocked 精确传播规则与失败传播矩阵由本契约 §3-§5 冻结。
- **I-1（图唯一）/ I-8（知识权威）/ I-12（资源授权）**：本契约不涉及 Knowledge 写入；不调用真实 Provider 或付费资源。
- **边界**：不展开持久化字段、API 签名、迁移代码与调度器实现；这些属后续实现 Task（见 §12）。

## 11. 非目标

1. 不新增 TaskGraph 数据源或第二套图存储。
2. 不新增 WorkItem 持久状态（跳过/重定向都是既有状态的语义，不是新状态）。
3. 不定义持久化字段、命令实现、迁移代码或调度器/拓扑排序实现。
4. 不实现 WorkItem 内任意嵌套 DAG（D-03 禁止；Layer 2 用固定阶段状态机）。
5. 不定义自动派发、并发配额或资源预算（T6）。
6. 不定义 Web DAG 视图的布局与交互（T9）。
7. 不改变 Review/Integration 主链；本契约不涉及 Candidate 验收通道。
8. 不使用真实 Provider、付费模型或共享资源验证（D-12/I-12）。

## 12. 下放事项（明确移交）

以下事项本契约不冻结，留给对应 Task 在 D-01/D-02 与本契约边界内决议：

1. **调度器实现**：ready 集的拓扑计算、`selectOpenWorkItem` 从"单个候选"到"完整 ready 集 + 派发策略"的改造、传递根因链的投影实现（Yui Core 实现 Task；现状 `nextAction.ts:743`、`taskExecutionProjection.ts:727` 是改造点）。
2. **改边命令**：`pending` WorkItem 的加边/删边命令与持久化（含 revision 与审计），replacement 链及解析后的有效依赖图无环校验的存储层实现（Yui Core 实现 Task）。
3. **disposition 结构化判别**：是否为跳过/过时/取消增加 disposition 判别字段（实现 Task 决策；本契约只要求跳过原因可持久追溯）。
4. **自动派发与配额**：ready 集的自动派发、并发度、背压（T6，D-06）。
5. **DAG 视图布局与指标口径**：Web/CLI 的 DAG 渲染、边分类标注、ready 集展示形态（T9，D-09）。
6. **Layer 2 衔接**：阶段状态机（T4）与本契约的衔接——阶段 blocked/input 如何映射为 WorkItem 级投影输入，由 T4 在本契约边界内定义。
