# Yui 双层多 Agent 编排架构 RFC（T0）

- 状态：T0 冻结候选（本 RFC 经 Task-final Review 与 Leader 接受后成为 T1–T10 的上游架构决议）
- 日期：2026-08-22
- 适用项目：Yui（`project-1`）
- 代码基线：`ff613ddcefa67f13b1a56bab261e333a550417ac`
- 上游证据：Task-25「调研 multi agent wiki」持久结论；共同架构基线（2026-08-22 暂存稿）；外部资料见 §13
- 性质：架构决议文档。不展开详细实现、持久化字段或迁移代码；这些属于 T1–T10。

## 0. 决议摘要

Yui 采用**一个持久化编排内核、两个调度层级**：

1. **Task 维度**以 `WorkItem.dependsOn` 表达 DAG，解决不同子目标的并行、串行与汇合。
2. **WorkItem 维度**以有界阶段状态机组织同一目标的多路探索、比较、综合和验证。

不建立第二套 TaskGraph 数据源，不建立独立的 multi-agent runtime。目标架构直接扩展现有 `WorkItem`、`ExecutionGroup/Lane`、`EffectiveLaunchSnapshot`、Candidate、Review 和 Integration 主链。

Leader 负责语义规划、动态修订和最终决议；Controller 负责确定性调度、并发约束、状态持久化与恢复。YUI_HOME 中的 Project Knowledge 和 Task 记录是知识权威，仓库、网页、会话和文件只作为证据或产物。

冻结决议索引（详见 §11）：

| ID | 决议 |
|---|---|
| D-01 | 双层模型：Task DAG + WorkItem 多路探索状态机，无第二套图/运行时 |
| D-02 | `WorkItem.dependsOn` 是 Task 级顺序的唯一权威；调度器是投影 |
| D-03 | WorkItem 内固定阶段 `Plan→Generate→Compare→Synthesize→Verify→Resolve` + 轮次；禁止任意嵌套 DAG |
| D-04 | Role / Agent / Execution Profile / Lane Spec / EffectiveLaunchSnapshot / Turn 分离；Lane 运行身份 = group/lane/attempt |
| D-05 | ContextSnapshot 清单模型与上下文权威顺序；禁止完整 transcript 共享 |
| D-06 | 统一 Resource Broker：跨 Task/WorkItem/Group/Provider/Agent/模型的并发与成本核算 |
| D-07 | 健康状态四档；禁止仅凭静默判死 |
| D-08 | Resolve 只产出一个 Candidate 或一个显式多 ChangeSet 决议；复用现有 Review/Integration 主链 |
| D-09 | 可观测性要求：DAG 视图、探索视图、六类指标 |
| D-10 | 非目标与红线冻结（§1） |
| D-11 | 推进顺序与 MVP 边界：MVP = T0–T4 + T7；多 Agent 永不默认开启 |
| D-12 | 真实 Provider/付费资源验证须用户逐次明确授权 |

## 1. 范围与非目标

### 1.1 本 RFC 冻结的内容

- Task 维度 DAG 与 WorkItem 维度多路探索的**职责边界**（§3）。
- **核心对象边界**（§4）与**核心不变量**（§5）。
- **失败语义与恢复依据**（§6）、**成本模型依据**（§7）。
- 上下文与知识边界（§8）、Review/Integration 衔接（§9）、可观测性要求（§10）。
- 供 T1–T10 直接依赖的**决议清单**（§11）与**逐 Task 边界约束**（§12）。

### 1.2 非目标（冻结红线）

1. 不新增第二套 TaskGraph 数据源或独立并行运行时。
2. 不在 WorkItem 内开放任意嵌套 DAG 或通用图引擎。
3. 不允许 Worker 自动写 Project Knowledge。
4. 不共享完整 transcript；兄弟 Lane 不共享可写工作区或原生 Session。
5. 不默认开启多 Agent；单 Agent 是默认路径。
6. 不用简单多数投票代替证据验证。
7. 不因 Leader/Lane 长时间无输出就判定死亡。
8. 第一阶段不引入 Agent 声誉、通用投票、CRDT、无限自我迭代或训练闭环。
9. 不使用真实 Provider、付费模型或共享资源进行自动验证，除非用户对具体资源边界另行明确授权（D-12）。
10. 本 RFC 不定义持久化字段、API 签名或迁移代码。

## 2. 证据基础

### 2.1 当前 Yui 基础（已对照 `ff613dd` 源码独立核对）

| 基线声称 | 核对结果 |
|---|---|
| `WorkItem.dependsOn` 可作为 Task DAG 唯一权威来源 | **存在**（`workItem.ts:117`，schemaVersion 9），存储层强制无环（`taskStore.ts` `assertAcyclicWorkItems`）；ready = 全部依赖 `completed` 的二元谓词（`nextAction.ts:743-745`）。**无拓扑/分层调度、无独立 WorkItem 自动并行派发**——DAG 引擎是 T1 的新增工作，不是既有能力 |
| ExecutionGroup/Lane 表达单路/并行、固定/自适应、隔离工作区、结构化结果 | **全部存在**（`executionGroup.ts`）：strategy `fixed`/`adaptive`、Lane 禁共享可写根（强制）、`ExecutionLaneResult` 结构化结果（summary/report/checks/findings/evidence）、`ExecutionResolution` 以 `selectedLaneIds` 汇合。**无 stage/round 字段** |
| EffectiveLaunchSnapshot 冻结最终启动配置 | **存在**（`effectiveLaunch.ts:33`，schemaVersion 2）：冻结 agent/adapter/model/effort/permission/profileAccess/writeProjectIds/workspace/context(RoleProfile)/sourceDesiredRevision 等；Dispatch 后不可变，运行中进程不被热变更 |
| Candidate / ReviewRound / Task-final Review / Integration 主链 | **存在**：Candidate 单槽（仅最新为 current，只能从 running 提交）；ReviewRound 与 Candidate 1:1、冻结 reviewBaseCommit、独占隔离工作区；Task-final 按集成头变化自动排队；IntegrationAttempt 以 CAS 推进目标头，冲突产出报告且 ResolutionDecision 为 Leader 独占 |
| Turn 审计记录 | **存在**（`turn.ts`）。Turn 是唯一调度权威；Provider 错误记录为标准化事实，由 Leader/Operator 决定在同 Session 提交新 Turn，或显式结束旧 Session 后创建新 Turn/Session。WorkItem 级重试仍派发新 Group；Lane 重启使用新 Turn id。 |
| 运行健康监控 | **存在 Role/Turn 级**（`roleTurnStall.ts`）：30 分钟无持久进展窗口 + 语义事件进展钟（非文本输出），分类 working/waiting-user/waiting-on-workers/truly-stalled，恢复归 Leader、绝不自动终止——与 I-10 一致。**Lane 级健康是 T7 的扩展** |
| Project Knowledge 权威 | **存在**（`project.ts`），但**仅 Operator CLI 可写**，无 Agent/Leader/Turn 写路径——I-8 在实现层面成立（ARCHITECTURE.md 所称 Leader「promote」尚无代码路径，T3/T7 如需该路径须显式建设） |
| 原生子 Agent 生命周期观测 | **部分存在**：subagent `operation.started/completed/failed` 持久事件 + `subagent-active` 展示状态。父 Provider Turn 的原生终态自动持久化 Turn 结果；子 Agent 的独立在途输出仍需写入持久 Task/Workspace 记录。 |
| Resource Broker / 预算核算 | **不存在**：仅有 Group 内 Lane 上限、每 Role 一个活跃 Turn、warning-only 语义进展预算；token 用量仅观测、明确排除在耐久进展钟外。D-06 为全新建设 |
| ContextSnapshot 类型 | **不存在**；装配原语存在（`dispatchContext`、`roleSessionContext`、`task context` 合并恢复读），冻结上下文角色由 `EffectiveLaunchSnapshot.context` 与 Brief/Decision/Milestone/Knowledge 持久记录承担。T3 定义清单契约 |
| WorkItem/Group 上的 stage/phase/round | **不存在**（grep 干净）。D-03 为全新建设；最接近的既有概念是 ReviewRound（仅评审生命周期）、Candidate.sequence（尝试编号）、WorkItem 上不可变的 executionGroups 历史（一次一个 current） |

### 2.2 Task-25 结论（已核对持久记录）

Task-25「调研 multi agent wiki」已于 2026-08-21 完成（结论落盘于其 message-4 与 milestone-1，无 Decision 记录；交付物为其 workspace 中 340 行 `report.md` 与四组证据笔记）。经核对持久记录：

**基线声称的 6 项缺口全部证实**：

1. native child 在途结果持久化（P0：最终结果应落盘到 WorkItem 证据链，turn 死亡后可恢复）。
2. Leader 只读恢复入口（P0：Task-25 曾在 leader-recovery-failed 状态下连只读命令都被 preflight 拦截）。
3. 唤醒自动上下文装配（缺 TacoTakumi 式 hook：唤醒时装配 ≤5 条指针，静默失败）。
4. Knowledge 新鲜度（缺 TTL/衰减；Hivebook 以 decay_days 翻 pending）。
5. 错误资产化回流（LLM-Wiki Error Book：Discover→Attribute→Constrain→Inject→Verify&Close）。
6. 上下文压缩遥测（wiki 把压缩比列为一等指标，Yui 缺该遥测）。

**记录中另有基线未列的缺口**：选路理由不落盘、无事件驱动订阅原语、无量化成本模型（WikiLoop: Cost=0.6·token+0.2·搜索+0.2·阅读）、fan-out 缺背压（Hivebook 超额降级到队列而非硬拒）、元数据检索层（LLM-Wiki wiki_search 先查 name/alias/tag，每查询仅读 2.5–3.9 页）、变更差量视图。其归属：量化成本模型与背压 → T6/T10；元数据检索、Knowledge TTL、差量视图 → T3；事件订阅与选路理由落盘 → 超出 T1–T10 范围，记为 Yui Core 未来项（§14）。

**一手故障证据（本架构分离持久权威与会话/文件证据的直接经验依据）**：Task-25 的 turn-2 在完成三路并行调研派发后异常结束，三个 explorer subagent 的在途证据因跨 Turn 上下文压缩全部丢失；而 subagent 直接写入 workspace 的 `notes/01-03` 证据文件幸存。其结论原话：「凡外置的都活下来了，凡没外置的都丢了」。

当前 Project Knowledge 为空。本 RFC 在被接受前只是待接受设计，不冒充已接受知识；接受后按 §8 沉淀。

### 2.3 外部证据（取舍见 §13）

- **Anthropic Multi-agent Research**：orchestrator-worker 分解、子 Agent 上下文隔离、外部持久化 + 轻量引用回传、多 Agent 约 15× chat token 成本、仅在高价值且可并行的任务上值得（已逐字核对原文，2026-08-22）。
- **Google Deep Think / AI Co-Scientist / Multi-agent scaling / CATS / Antigravity**：并行假设探索与修订组合；Generation/Debate/Ranking/Evolution 分工；集中协调适合可并行任务、顺序任务可能放大错误；并行探索与顺序深化之间的统一预算分配；角色分工 + watchdog + 续任 + 独立审计。
- **Multica / Multi-Agent Wiki / LangGraph / AutoGen / MetaGPT / Cognition / Chroma / Manus / Swarm / LLM-Wiki**：见 §13 逐条取舍。

## 3. 双层职责边界

### 3.1 Layer 1：Task 维度 WorkItem DAG

- **唯一权威**：`WorkItem.dependsOn`。DAG 存储、界面、调度都是投影。
- **拥有**：不同子目标的分解；并行、串行、汇合（fan-out/fan-in）；产物与语义依赖；Task 级失败/阻塞/输入等待的传播；Leader 依据持久化中间结果动态追加 WorkItem 或依赖；环路与非法依赖检测。
- **调度器职责**：计算 `pending / ready / running / blocked / terminal`；依赖满足时释放；按明确规则传播失败、阻塞和输入等待。
- **禁止表达**：Agent、Session、文件锁、Provider 并发（这些属于 Layer 2 与 Resource Broker）。

### 3.2 Layer 2：WorkItem 维度多路探索状态机

- **拥有**：同一目标的不同路线、假设或实现的并行探索；阶段化的比较、综合、验证；轮次与预算；结构化结果归一化。
- **固定阶段**：`Plan → Generate → Compare → Synthesize → Verify → Resolve`（D-03）。每阶段继续使用 ExecutionGroup，并携带阶段/轮次语义：round、stage、contextSnapshot、budget（token、工具调用、时间、最大 Lane 数、最大轮次）、quorum/deadline、parentResults。物理形态受 §3.5 约束：**一个阶段 = 一个新 ExecutionGroup**（target 不可变、单 current Group），阶段间只传递已持久化的结构化结果。
- **探索模式**（T4/T5 细化，T0 冻结分类）：
  1. `single`：单 Agent，默认模式。
  2. `parallel-diverse`：不同模型、Provider、工具或思路解决同一目标。
  3. `ensemble-replicated`：相同配置的独立重复尝试。
  4. `adversarial`：生成者、批评者、验证者分工。
  5. `adaptive-exploration`：先少量 Lane，再依据分歧、证据和预算扩展。
- **禁止**：WorkItem 内任意嵌套 DAG；兄弟 Lane 共享可写根目录或原生 Session；把多 Agent 当作默认提质开关（无法自然并行或需要连续隐式决策的任务仍用单 Agent 或顺序链）。

### 3.3 边界矩阵

| 维度 | Layer 1（Task DAG） | Layer 2（WorkItem 探索） |
|---|---|---|
| 表达对象 | 不同子目标 | 同一目标的不同路线 |
| 权威数据 | `WorkItem.dependsOn` | ExecutionGroup/Lane + 阶段/轮次语义 |
| 并行单位 | WorkItem | Lane |
| 失败单位 | WorkItem（传播规则 T1 定义） | Lane（不等于 WorkItem 失败） |
| 产物 | 已接受 WorkItem 结果 | 一个 Candidate 或显式多 ChangeSet 决议 |
| 动态修订 | Leader 追加 WorkItem/依赖 | Leader 调整 Lane/轮次/预算 |
| 禁止事项 | 表达 Agent/Session/锁/Provider 并发 | 嵌套 DAG、共享可写根/Session、默认开启 |

### 3.4 跨层规则

1. 只有**已接受**的上游 WorkItem 结果才能作为下游 WorkItem 的输入（Layer 1 → Layer 1）。
2. Layer 2 的 Resolve 只输出一个明确 Candidate，或一个显式的多 ChangeSet 组合决议（D-08）。
3. Lane 失败不向上传播为 WorkItem 失败；只有阶段预算耗尽、连续无进展或验证失败才使 WorkItem 进入 blocked/input。
4. 两层共享同一持久化内核与同一 Resource Broker；不存在第二个运行时。

### 3.5 现状机制对设计的约束（T1–T10 的设计包络）

对照源码确认以下既有语义是本架构的设计包络，下游 Task 必须在包络内设计（出处见 §2.1）：

1. WorkItem 是严格 6 态机（pending/running/awaiting_acceptance/completed/failed/retired）；Candidate 只能从 `running` 提交，终态需要明确结果。
2. 每个 WorkItem 同时至多一个未解决 ExecutionGroup；Group target 不可变、追加式 Lane、Resolution 一次性不可变。**新阶段或新探索目标 = 新 ExecutionGroup**——这是阶段状态机的物理形态（T4 据此设计，不引入新容器）。
3. Lane 扇出受 strategy（fixed count / adaptive max）上限约束；每 Lane 一个 Role；每 Role 同时一个活跃 Turn。并行路线消耗 Role 槽位而非通用预算；T6 的统一预算层在此之上建设，不另起运行时。
4. `dependsOn` 门控是 all-`completed` 二元谓词；失败/退役依赖会使下游无限阻塞，无传播/取消/跳过。**T1 必须定义失败传播与跳过语义**，这是 D-02 的必备组成部分。
5. Candidate 单槽：一个 WorkItem 同时只有最新 Candidate 是 current。多路线结果必须在 Resolve 归一为一个 Candidate 或一个显式多 ChangeSet 决议（D-08），不存在多 Candidate 并存。
6. ReviewRound 与 Candidate 1:1、冻结基线、独占工作区；多路线评审 = 每个 Candidate/路线一个 Round，由 T8 衔接。
7. 存储层强制依赖无环与记录图校验；新字段/新链接需要迁移注册条目（T2/T4 的持久化工作受此约束）。
8. Project Knowledge 仅 Operator CLI 可写；任何「Leader 沉淀知识」路径须显式建设且保持 I-8（Worker 永不写）。
9. 不存在 token/时间/轮次预算原语——T6 是绿地；在其建成前，轮次/路线上限只能由 Leader 以语义判断执行。
10. 阶段间衔接只通过已持久化的 Lane 结果（`ExecutionLaneResult` + evidence）；结果复用是强制的（I-6），不允许阶段间重放未持久化的会话内容。

## 4. 核心对象边界

- **Role**：语义职责（solver、critic、reviewer、verifier 等）。
- **Agent**：Provider/CLI 身份（`codex`、`claude` 等）。
- **Execution Profile**：可复用执行配置——模型、effort、工具、权限、技能、搜索、Provider 高级参数。
- **Lane Spec**：一次并行路线的期望配置 = Role + Agent/Profile 引用 + 局部覆盖 + 差异化探索指令。
- **EffectiveLaunchSnapshot**：Dispatch 时解析并冻结的最终配置，Dispatch 后不可变。
- **Turn**：某个 Lane 的一次实际启动、恢复或重试；重试创建新 Turn。

同一 Agent ID 可出现在多个 Lane 中使用不同模型/effort（如 `codex + gpt-5.6-sol + xhigh`、`codex + gpt-5.6-terra + high`、`claude + opus + max + critic`）。不同 EffectiveLaunchSnapshot 不共享原生 Session；**Lane 的运行身份由 group/lane/attempt 确定，不能由 Agent ID 确定**（I-3）。

## 5. 核心不变量

- **I-1 图唯一**：`WorkItem.dependsOn` 是 Task 级顺序的唯一权威；不存在第二套图存储或并行运行时。
- **I-2 状态机唯一**：一个 WorkItem 至多有一个活跃的探索状态机实例；阶段集合固定且可恢复。
- **I-3 运行身份**：Lane 运行身份 = (group, lane, attempt)，永不由 Agent ID 确定；不同 EffectiveLaunchSnapshot 不共享原生 Session。
- **I-4 快照不可变**：Dispatch 冻结 EffectiveLaunchSnapshot；运行中进程不被后续配置编辑热变更。重试分两级：瞬时 Provider 错误的传输级重试在同 Turn+Session 内原地进行（不改变 Snapshot）；Lane/路线级重试以新 Turn 重启，WorkItem 级重试派发新 ExecutionGroup。
- **I-5 写隔离**：兄弟可写 Lane 不共享可写根目录或原生 Session。
- **I-6 Lane 失败有界**：Lane 失败限于 Lane；已完成 Lane 的持久结果可复用；未完成 Lane 以新 Turn 重试。
- **I-7 单一出口**：Resolve 只产出一个 Candidate 或一个显式多 ChangeSet 决议，进入既有 Review/Integration 主链。
- **I-8 知识权威**：只有被接受/集成的结论才能进入 Project Knowledge；Worker 永不写 Knowledge。
- **I-9 上下文清单化**：ContextSnapshot 是 ID/版本/digest/仓库 commit/验收条件/证据引用的清单，不复制全文；Compare 只收归一化结果与产物引用，Verify 只收选中结果、验收条件和证据。
- **I-10 静默非死亡**：确认死亡必须综合进程、原生 Session、Provider 事件、工具活动和宽限期；长时无文本输出单独不构成死亡判据。
- **I-11 多 Agent 非默认**：单 Agent 是默认；成本优化排在验收与证据充分之后。
- **I-12 资源授权**：真实 Provider/付费模型/共享资源的验证须用户对具体资源边界逐次明确授权。

## 6. 失败语义与恢复依据

### 6.1 失败层级

| 层级 | 触发 | 语义 |
|---|---|---|
| Lane 失败 | 单路执行错误、模型/Provider 错误 | 瞬时错误走传输级原地重试（同 Turn+Session）；持续失败以新 Turn 重启该 Lane 或终止该路线，其余 Lane 继续；已完成 Lane 的持久结果不重放 |
| 阶段未达 | quorum 未满足、预算耗尽、连续无进展 | 阶段 blocked，Leader 决议：适配/扩展/放弃路线或升级 WorkItem blocked/input |
| WorkItem 失败 | 验证失败、所有路线耗尽 | 进入 Layer 1 传播规则（T1 精确定义） |
| Leader Session 丢失 | 进程/会话终止 | 从权威记录重新装配上下文续任，不依赖手写 handoff 文件 |
| Provider 限流 | 配额/限流 | 有界队列 + 背压，不放大为全部 Lane 失败 |

### 6.2 恢复依据

1. **持久状态权威**：Controller 恢复后根据持久化 Group/Lane/Turn 状态重建执行；会话 transcript 仅用于审计与故障定位。
2. **结果复用**：已完成 Lane 的持久结果必须可被后续轮次/恢复复用，不重复执行。Task-25 的一手经验（在途证据随上下文压缩丢失、直写文件幸存，§2.2）表明：在途结果持久化是 T7 的**强制项而非可选优化**，且持久化目标必须是 Yui 权威记录（WorkItem 证据链），不能依赖会话 transcript 或手写 handoff 文件——「凡外置的都活下来了，凡没外置的都丢了」。
3. **Leader 续任**：新 Leader Turn 从 Task Brief、Decision、Milestone、已接受 WorkItem 结果和 Project Knowledge 重新装配；Task Brief 的 focus/leader-summary 是续任契约的一部分。
4. **健康判定**：`running-active / running-silent / suspected-stalled / confirmed-dead` 四档；`suspected-stalled` 触发诊断而非杀死；`confirmed-dead` 才允许 Turn 重试。

## 7. 成本模型依据

1. **成本量级证据**：Anthropic 多 Agent 系统约 15× chat token；token 用量解释了 BrowseComp 80% 的性能方差。多 Agent 只在高价值、重并行、超出单上下文的任务上值得；需要共享上下文或重相互依赖的任务（如多数编码任务）不适合。
2. **放大风险证据**：Google 的 agent 系统规模化研究表明集中协调适合可并行任务，顺序任务与独立 Agent 可能放大错误——多 Agent 不是默认提质开关。
3. **预算统一**：借鉴 CATS，在并行探索与顺序深化之间统一分配预算。预算维度 = token、工具调用、墙钟时间、最大 Lane 数、最大轮次。成本核算应有量化模型（Task-25 记录的 WikiLoop 参考式：Cost=0.6·token+0.2·搜索+0.2·阅读；Yui 的口径由 T6/T10 定义）。
4. **充分先于省费**：Task-25 核实的 WikiLoop sufficiency-before-efficiency 门控提供直接反例——不门控时成本最低但过早停止率 24.2%。因此「省上下文/省 token」的激励必须挂在证据集齐之后，否则上下文受限的 Leader 会理性地接受薄证据。这与 I-11 共同构成成本规则的两面：多 Agent 非默认，但一旦开启探索，不得以成本为由在证据不足时提前终止。
5. **路由规则**：根据任务特征决定增加并行 Lane 还是继续顺序深化；自适应扩展必须依据分歧、证据和预算，不依据乐观情绪。
6. **终止经济**：支持 quorum、deadline、straggler 与达到充分度后的提前终止；新增 Lane 的边际价值必须可观测（§10）。
7. **优先级**：验收与证据充分 > 成本优化。成本指标用于事后复盘与路由改进，不用于在证据不足时提前终止验证。

## 8. 上下文与知识边界

### 8.1 权威顺序

1. Project Knowledge（仅接受/集成后写入）。
2. Task Brief、Decision、Milestone、Input、Message。
3. 上游 WorkItem 的已接受结果。
4. 仓库、外部网页、产物——作为证据。
5. Session transcript——仅审计与故障定位。

### 8.2 ContextSnapshot 规则

- ContextSnapshot 是清单（ID、版本、digest、仓库 commit、验收条件、证据引用），不复制 Project Knowledge 全文。
- 所有 Generation Lane 使用同一基础 Snapshot + Lane 专属探索指令。
- Compare 只接收归一化结果和产物引用；Verify 只接收选中结果、验收条件和证据。
- 通过阶段化上下文、稳定提示前缀、按需读取和外置持久状态控制单 Agent 上下文增长与自动压缩。
- Leader Session 丢失时从权威记录重新装配，不依赖手写 handoff 文件。

## 9. Review 与 Integration 衔接

- Generate/Compare/Synthesize/Verify 属于 WorkItem 执行控制面；Resolve 后只产生一个明确 Candidate，或一个显式的多 ChangeSet 组合决议。
- Candidate 继续进入现有 WorkItem Review 与 Task-final Review；本架构不新增第二条验收通道。
- 只有选中的冻结产物可以进入 Integration；Integration 保持原子性；冲突由 Leader 形成持久 Decision。
- 可写 Lane 必须使用隔离工作树，兄弟 Lane 不能共享可写根目录。
- Reviewer 诊断提交永不自动进入 ChangeSet/Integration。

## 10. 可观测性要求

- **Task 视图**：展示 DAG（含 ready/blocked/running/terminal 投影）。
- **WorkItem 视图**：展示探索轮次、阶段、Lane、Agent、Profile、模型、effort、状态、成本、上下文、证据和决议。
- **指标族**：
  - 质量：首次验收通过率、Review 缺陷、Integration 成功率。
  - 协调：Leader 回合数、重复 Lane 比例、straggler 时间、重试次数。
  - 上下文：ContextSnapshot 大小、Leader 上下文增长、自动压缩次数与压缩比（Task-25 缺口：压缩比应成为一等指标）、恢复读取量。
  - 成本：每个被接受 WorkItem 的 token/工具调用/墙钟时间、新增 Lane 的边际价值。
  - 可靠性：恢复成功率、误判卡死率、已完成结果复用率。
  - 多样性：候选相似度、独立证据数量、真实差异路线数。

## 11. 冻结决议清单

> 每条决议给出：决议 / 依据 / 对下游的约束。T1–T10 必须在此边界内设计；边界变更须回 T0 流程修订本 RFC 并 supersede 对应 Decision。

### D-01 双层模型
决议：一个持久化内核 + Task DAG / WorkItem 探索两个调度层级。
依据：§3；Anthropic orchestrator-worker 与 Google 集中协调证据；避免第二套图的复杂度。
约束：T1–T10 不得引入第二套图存储或独立运行时。

### D-02 DAG 唯一权威
决议：`WorkItem.dependsOn` 为唯一权威；调度与界面是投影；调度器计算 ready/blocked、fan-out/fan-in、失败/阻塞/输入传播、环路检测、Leader 动态修订。
依据：§3.1；I-1。
约束：T1 只做投影与传播语义，不新建 TaskGraph 数据源。

### D-03 固定阶段状态机
决议：WorkItem 探索固定为 `Plan→Generate→Compare→Synthesize→Verify→Resolve` + 轮次；阶段携带 round/stage/contextSnapshot/budget/quorum/parentResults 语义。物理形态：一个阶段 = 一个新 ExecutionGroup（§3.5-2），阶段间只传递已持久化的结构化结果。
依据：§3.2；Google Deep Think/Co-Scientist 阶段分工证据；现状无 stage/round 字段（§2.1）。
约束：T4 定义状态机语义；不得实现通用嵌套图引擎或无限自治循环；不得引入 ExecutionGroup 之外的新容器。

### D-04 对象分离与运行身份
决议：Role/Agent/Execution Profile/Lane Spec/EffectiveLaunchSnapshot/Turn 六类对象分离；运行身份 = group/lane/attempt；Snapshot Dispatch 后不可变；重试 = 新 Turn。
依据：§4；I-3/I-4；现有 Turn 不可变快照语义。
约束：T2 定义分离契约；不得通过复制 Role 表达模型差异，不得共享原生 Session。

### D-05 上下文清单与权威顺序
决议：ContextSnapshot 为清单模型；权威顺序 §8.1；Compare/Verify 按需最小上下文。
依据：§8；I-9；Anthropic 外部状态 + 轻量引用证据；Chroma context rot 警告。
约束：T3 定义装配契约；不得复制完整 transcript，不得以仓库/临时文件替代知识权威。

### D-06 统一 Resource Broker
决议：跨 Task/WorkItem/Group/Provider/Agent/模型的统一并发控制与成本核算（token/工具调用/墙钟/轮次）；限流走有界队列 + 背压。
依据：§7；CATS 统一预算证据。
约束：T6 定义调度与预算；不得默认开满 Agent，不得绕过 Provider 限额。

### D-07 健康四档与静默非死亡
决议：running-active/running-silent/suspected-stalled/confirmed-dead；confirmed-dead 需多维证据 + 宽限期。现状 Role/Turn 级已有 30 分钟无持久进展的语义事件检测（`roleTurnStall.ts`，恢复归 Leader、绝不自动终止），T7 在此基础上扩展 Lane 级健康与在途结果持久化。
依据：§6.2；I-10；Task-25 恢复经验与在途结果丢失证据。
约束：T7 定义监控与恢复；不得仅凭无输出时长杀死 Session；在途结果持久化是强制项。

### D-08 单一出口与主链衔接
决议：Resolve 输出一个 Candidate 或显式多 ChangeSet 决议；复用现有 Candidate/ReviewRound/Task-final Review/原子 Integration；冲突由 Leader 持久 Decision 解决。
依据：§9；I-7。
约束：T8 定义衔接；兄弟 Lane 不得共享可写工作区；未选择产物不得进入集成。

### D-09 可观测性要求
决议：DAG 视图 + 探索视图 + 六类指标（§10）。
依据：§10。
约束：T9 定义界面；不得建立界面侧状态权威，不得为表格展示改变领域语义。

### D-10 非目标与红线
决议：§1.2 十条红线冻结。
依据：Task 边界 + 外部失败教训（Cognition 隐式决策冲突、Swarm 生产化不足等）。
约束：所有 T1–T10 继承。

### D-11 推进顺序与 MVP
决议：T0 →（T1,T2,T3 并行）→ T4 →（T5,T6,T7 并行）→ T8,T9 → T10；MVP = T0–T4 + T7（固定多配置 Lane + Leader 基于结构化结果人工决议）。
依据：§12 依赖图；先冻结语义再自动化。
约束：自动比较/综合、自适应预算、完整界面在 MVP 之后；多 Agent 永不默认开启。

### D-12 资源授权边界
决议：真实 Provider/付费模型/共享资源的验证须用户对具体资源边界逐次明确授权；默认使用确定性 mock 与隔离资源。
依据：Task 边界；I-12。
约束：T10 评测设计继承；未授权时报告验证缺口而非阻塞。

## 12. 对 T1–T10 的边界约束

| Task | 目标（基线） | 可依赖的 T0 决议 | 禁止 |
|---|---|---|---|
| T1 Task DAG 语义与调度投影 | ready/blocked、fan-out/fan-in、失败传播、动态修订、图投影 | D-01, D-02, §3.5-4 | 新建 TaskGraph 数据源；WorkItem 内任意 DAG；忽略失败依赖的传播/跳过语义（现状 all-completed 门控会无限阻塞） |
| T2 多配置 Lane 与启动快照契约 | 六类对象分离，同 Agent 多模型/effort 并行 | D-04, I-3, I-4 | 复制 Role 表达模型差异；共享原生 Session；绕过迁移注册新增字段 |
| T3 ContextSnapshot 与权威上下文装配 | 层级化上下文、可恢复按需展开 | D-05, §8, §3.5-8 | 复制完整 transcript；以文件替代知识权威；让 Worker 获得 Knowledge 写权限 |
| T4 WorkItem 多路探索阶段状态机 | 六阶段、轮次、阶段 Group、重试、终止 | D-03, D-01, §3.5-1/2/5/10 | 通用嵌套图引擎；无限自治循环；引入新容器替代 ExecutionGroup；多 Candidate 并存 |
| T5 候选比较、综合与验证策略 | 结构化结果、去重聚类、证据比较、按产物类型综合、独立验证 | D-03, I-9 | 简单多数投票；全任务 Elo/大规模 debate |
| T6 自适应预算与资源调度 | 并行/顺序路由、配额、统一预算、背压、quorum、straggler、提前终止 | D-06, §7, §3.5-3/9 | 默认开满 Agent；绕过 Provider 限额；在证据不足时以成本为由提前终止 |
| T7 Agent/Lane 状态监控与恢复 | 四档健康、Controller 恢复、Turn 重试、结果复用、Leader 续任 | D-07, §6, I-10, §3.5-10 | 仅凭无输出杀 Session；handoff 文件替代持久记录；把在途结果持久化做成可选项（现状不存在，是强制项） |
| T8 多路结果接入 Review 与 Integration | Resolve 结果接入 Candidate/ReviewRound/Task-final Review/原子 Integration | D-08, §9 | 兄弟 Lane 共享可写工作区；未选产物直接集成 |
| T9 可观测界面 | DAG + 探索 + 成本/上下文/证据/决议统一展示 | D-09, §10 | 界面侧状态权威；为展示改变领域语义 |
| T10 评测、基线与分阶段启用 | 单 Agent 基线 + 多路策略评测、启用门槛 | D-11, D-12, §7 | 未经明确授权调用真实 Provider/付费资源 |

## 13. 参考资料及取舍

### Anthropic
- Multi-agent research system（已逐字核对，2026-08-22）：Lead 动态分解、隔离上下文、外部持久计划、直接产物引用；约 15× chat token；仅高价值可并行任务值得。https://www.anthropic.com/engineering/multi-agent-research-system
- Dynamic Workflows：对话外编排、分支/循环、提示缓存、恢复与进度展示；生成的 JavaScript 不能成为 Yui 状态权威。https://claude.com/blog/introducing-dynamic-workflows-in-claude-code ，https://code.claude.com/docs/en/workflows
- Context Engineering：有界上下文、外部状态、按需读取。https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents

### Google
- Deep Think：并行假设、修订、组合；不假设未公开内部算法。https://blog.google/products-and-platforms/products/gemini/gemini-2-5-deep-think/
- AI Co-Scientist：Generation/Proximity/Debate/Ranking/Evolution/Meta-review；不对所有 WorkItem 引入完整 Elo 竞赛。https://deepmind.google/blog/co-scientist-a-multi-agent-ai-partner-to-accelerate-research/
- Multi-agent scaling：集中协调适合可并行任务；顺序任务与独立 Agent 可能放大错误；多 Agent 非默认。https://research.google/blog/towards-a-science-of-scaling-agent-systems-when-and-why-agent-systems-work/
- CATS：并行探索与顺序深化的统一预算分配。https://research.google/pubs/cost-effective-agent-test-time-scaling/
- Antigravity：角色分工、watchdog、续任、独立审计；用 Yui 持久记录而非文件交接作为权威。https://antigravity.google/blog/google-antigravity-built-an-os

### 其他项目
- Multica：Agent/Runtime/Task 分离、Provider 中立配置、可观测性；其工作流编排不能替代 Yui 内核。https://github.com/multica-ai/multica/ ，https://github.com/multica-ai/multica/issues/1943
- Multi-Agent Wiki：barrier、pipeline、critic、debate、blackboard、结构化契约分类；不采用无边界群聊。https://multi-agent.wiki/
- LangGraph：checkpoint、恢复、人机边界；不建立第二套图状态。https://docs.langchain.com/oss/javascript/langgraph/persistence
- AutoGen：sequential/parallel/conditional/join；避免共享 transcript 污染。https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/tutorial/teams.html
- MetaGPT：SOP、角色、结构化消息；不套用固定软件公司组织。https://arxiv.org/abs/2308.00352
- Cognition / Chroma / Manus：隐式决策冲突、context rot、外部状态、缓存稳定性的警告。https://cognition.com/blog/dont-build-multi-agents ，https://www.trychroma.com/research/context-rot ，https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus
- OpenAI Swarm：只借鉴简洁 handoff 语义，不作为生产架构基础。https://github.com/openai/swarm
- LLM-Wiki / WikiLoop：溯源、充分度门槛、错误资产、下游效用反馈；暂不引入 CRDT、声誉投票、训练或强化学习闭环。https://arxiv.org/abs/2605.25480 ，https://arxiv.org/abs/2607.26604

## 14. 未决议事项（明确下放）

以下事项 T0 不冻结，留给对应 Task 在 D-01–D-12 边界内决议：

1. ready/blocked 的精确传播规则与失败传播矩阵（T1）。
2. Lane Spec 的字段级契约与 Profile 覆盖解析顺序（T2）。
3. ContextPack 的物理装配格式与按需展开协议（T3）。
4. 阶段状态机的持久化状态集合、重试上限与终止条件细节（T4）。
5. 聚类/去重算法、按产物类型的综合策略、验证者独立性要求（T5）。
6. 预算分配函数、背压队列参数、straggler 阈值（T6）。
7. 健康判定的具体信号权重、宽限期时长、恢复重建算法（T7）。
8. 多 ChangeSet 决议的表达格式与 Review 衔接细节（T8）。
9. 视图布局与指标计算口径（T9）。
10. 评测数据集、基线与启用门槛数值（T10）。
11. Task-25 记录中超出 T1–T10 范围的 Yui Core 缺口：选路理由落盘、事件驱动订阅原语、Knowledge 元数据检索与 TTL/衰减、变更差量视图。这些不阻塞本架构，由 Yui Core 另行排期；T3/T6/T9/T10 在边界内可部分覆盖（见 §2.2）。
