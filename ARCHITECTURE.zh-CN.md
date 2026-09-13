<p align="right"><a href="./ARCHITECTURE.md">English</a> | <strong>简体中文</strong></p>

# Yui 架构

Yui 是面向智能 Agent 的本地控制面与上下文 API。Agent 拥有规划、执行拓扑、语义审查、
验收和恢复。Core 拥有持久身份、授权、工作区隔离、数据完整性和有界效果。它暴露当前
事实和原子操作，而不是替 Agent 选择工作流。

## 职责

| 边界 | 拥有 | 不拥有 |
| --- | --- | --- |
| Operator / Leader | 用户协调；Task 结果、规划和判断 | 伪造的运行时回执或自行授予的外部权限 |
| Task Store | Task、Role、WorkItem、Run、消息、结果、事件和资源所有权 | 原生 transcript 或推断出的 Provider 活动 |
| Context | 获授权的有界读取、不可变事件增量、精确执行快照 | 第二份可写 Task 或投递确认 |
| Controller | 投递、观察、Job、能力 Host 和 Web 监听 | 对 Agent 散文的语义解读 |
| CapabilityRegistry / InstanceHost | 描述符解析、范围受限调用、实现引用和处置 | Task 规划、任意插件特权或自动恢复 |
| AgentHost / AgentEndpoint / Driver | 原生连接、输入处置、精确结果关联和观察 | Task 验收或对共享 Provider daemon 的所有权 |
| Project / Resource | Knowledge、受管 Git 工作区、采用的环境和持久 artifact | 从目录名推断出的权限 |
| CLI / Web | 共享的领域操作和投影 | 独立的业务状态或另一个插件 Host |

一个 `YUI_HOME` 有一个权威的 SQLite 控制面 Store 和一个 Controller。Project Knowledge
维护在该 Home 下；仓库材料可以作为证据，但不替代所维护的 Knowledge。

## 意图、协作与执行

Task 表示一个有界结果，可能跨多个 Project。它的 type 描述意图，不规定分解方式。
Leader 可以直接负责有界工作；WorkItem 是有实质性、可独立验收、且有明确负责人的需求。

Task 生命周期是 `draft / active / completed / cancelled / archived`。WorkItem 生命周期
是 `open / accepted / retired`。执行、等待和失败归 AgentRun 和运行时观察，不构成额外的
WorkItem 状态。只有被接受的直接依赖才满足 `dependsOn`；替换元数据不重定向依赖图。

一个有效的 Leader Session 可以在没有活动 AgentRun 的情况下读取 Context 并修改范围
受限的 Task 事实。Worker 与 Reviewer 动作保留其精确的 Assignment 和工作区边界。替换
或撤销一个 Session 会改变权限；一次瞬时的投递失败既不授予也不撤销无关权限。已释放的
Leader 保留范围受限的诊断读取，而非写权限。

持久 Task 上下文与工程控制数据有各自的用途。需求、决策、验收和原始结果必须在原生
对话之外存续。AgentRun 的输入/结果历史仍是证据，而它的活动索引、原生投递状态、Host
和 Session 选择只控制一次执行尝试。替换那次执行绝不完成或删除 Task。

AgentRun 记录一次明确请求的执行，带有冻结的 Context 和生效配置。原生对话、Goal 延续
和普通 Leader 通知不会自动创建 Run。消息可以通过一个新的、精确关联的 Run 延续已派发
的工作，而不改变需求、已捕获的权限或工作区。

参见 [Session 与 AgentRun](docs/managed-turn-and-session-runtime.zh-CN.md)和
[Task 依赖](docs/task-dag-semantics.zh-CN.md)。

## 投递与结果

显式派发与普通通知共享原生输入传输，但保有不同的持久 owner。Controller 认领一个有界
mailbox 批次；AgentHost 通过 AgentEndpoint 串行化提交。Provider 绑定记录实际接受和原生
关联。一条通知可以在接受时结算，而不要求最终执行报告。

忙碌且已证明未接受会为后续尝试保留输入。仅有传输提交不证明接受。未知效果保持可见且被
围栏隔离：不盲目重发，也不推断成功。显式替换先解决实际的原生执行，再丢弃其工程占用。
在一个已认领批次期间到达的输入，留待下一个批次。读取 Context 不消费投递。

一个精确的终态事务持久化一个原始 AgentRunResult 和一条引用 Message。Core 校验身份、
传输和工作区事实；它不把散文解析为 findings、投票、修复拓扑或验收。Provider 成功与
语义成功是两回事。

直接执行使用一个 main Run。复制执行为彼此不同的 Producer Lane 冻结一个 Assignment。
Leader 显式选择终态原始结果并启动一个 main 综合 Run；被选中的失败结果也可以是有用的
证据。Core 检查来源，而不是成功计数或共识。Lane 不是 Candidate，也不是 Integration
来源。

ReviewRound 引用一个冻结的 Candidate 或 Task head，以及它确切的 Reviewer Run。原始
Reviewer 输出留在那个 Run 上。审查策略和显式的 Task-final 合同规定何时需要审查；报告的
含义由 Leader 判断。参见[结果消费](docs/agent-result-consumption.zh-CN.md)。

## 规划、工作区与资源

Draft 包含规划事实和 Project 绑定，而不是一个已采用的交付工作区。它私有的规划目录位于
`<YUI_HOME>/runtime/task-runtimes/planning`，与持久控制数据和交付树分开。
规划 Session 捕获 `planning` 权限。Leader 可以在一个 Run 或
普通讨论中持久化一个激活请求并返回；原生静止会把该意图释放出来，进行当前权限和资源
检查。

激活先准备物理资源，然后原子地采用 Task 状态、工作区身份和所有权。失败会保留意图和一份
诊断、通知 Leader，并停止对那次失败采用的自动重复。成功会通知 Leader 进入交付，而无需
再一次用户提示。Task 激活不能把一个活动 Session 已捕获的权限变更为 `delivery`；一次
兼容的交付启动必须确立那条边界。

稳定的 Project checkout 是只读参考。受管工作区的 owner 是 Task、WorkItem、ReviewRound
或 IntegrationAttempt，而不是 Role 名。多 Project 工作区包含按 Project 划分的 Git 根。
写范围和精确的 Git 血缘在效果发生处检查；一个 Profile 的行为意图不是 grant。

一个隔离结果被捕获为不可变的、按 Project 划分的 ChangeSet，并通过一个候选 worktree
集成。检查先于对目标 head 的 compare-and-swap 推进。冲突或目标移动保留证据且不推进它。
Leader 单独验收交付。

Resource 支持不可变内容、外部版本和回执 artifact，以及被显式标记的参考资料。环境的
prepare、adopt、bind 和 release 是彼此独立的操作。选择影响未来的原生执行；活动 Session
保留其已捕获的环境。trusted-local 采用不是 OS 沙箱，release 也绝不意味着删除用户目录。

## 运行时身份与替换

Agent 执行组件、连接方案、原生 Session、Host attachment 和 AgentRun 标识不同的东西。
Codex CLI 使用 App Server，Claude Code CLI 使用 stream-json，ACP peer 使用 ACP 连接
实现。未知的 ACP 产品身份保持未知。

期望的 Role 配置、冻结的生效启动，以及 Agent 实际自报的配置是彼此独立的事实。被请求的
model 或权限不是它当前已生效的证据。ACP 配置通过协商的选项应用并检查；不受支持的轴
显式失败，而不是被猜测。

Host 拥有一次性客户端，而不是共享的原生对话。Session 实现被固定到其实际的代码边界。
新的调用或 Session 可以选择一个新实现，同时旧引用排空。一次超时或客户端退出不证明后代
资源已停止；未解决的处置保持可观察，而不是被报告为干净。

Session 复用是可选的。`task role session new` 在既有运行时 mailbox 中记录替换意图，
包括当一个 Run 处于活动、或先前的 Session 已经结束时。一旦其资源停止，Yui 取消旧 Role
的工程尝试，保留历史和工作区，并选择一个新 Session。未处理的通知引用被带入后继的上下文，
而不是丢在一个时间游标之后。是否重试既有工作由 Agent 决定。持久的原生连接位置和专用
进程托管使恢复独立于旧 Host。一个确实存活/未知的写者仍是一条资源边界，而不是隐瞒诊断
或抹除持久上下文的理由。

参见 [Provider Runtime](docs/provider-runtime.zh-CN.md)和
[Agent Drivers](docs/agent-runtime-drivers.zh-CN.md)。

## 能力、插件与 Surface

能力使用经认证的 `search / describe / call`。描述符声明 schema、effect、权限、scope 和
Provider 身份。歧义要求显式选择。嵌套调用不能放大调用者的权限或效果；原始操作回执在
父调用失败后仍存续。

Registry 暴露 context、消息、artifact、环境、插件以及部分 Task/Job 操作。其他 CLI/Web
操作直接共享领域处理器。并不要求每个操作都经由一个插件路由。

经验证的 Task-local 插件在 Store 中保留显式的 enabled 意图，在 InstanceHost 中保留活
实例。读取或重启不运行作者代码。Leader 的管理仅限于其 Task；可执行代码仍需要确切的、
由 Operator 签发的 grant。插件验证不是安全认证。

CLI 贡献和受控的 Web 面板是 Registry 的投影。Web 仅本地回环、由 Controller 拥有；浏览器
凭据认证本地用户控制，这些控制复用 CLI 领域操作；查询面板仍只读，不能借用该用户权限
执行修改或插件管理。参见[插件 SDK](docs/plugin-sdk.zh-CN.md)和
[能力与资源](docs/architecture/capabilities-and-resources.zh-CN.md)。

## 持久化、完成与运维

Home 有一条只追加的存储迁移链。普通运行时只接受当前记录。显式升级会备份并迁移受支持的
有效 Home；畸形状态被诊断，而不是自动修复。

完成会冻结交付结果，并检查适用的验收、集成和审查合同。它区别于发布、已验证的远程合并、
物理静止和归档。普通归档要求工作已了结、受管资源干净可移除。明确授权的 force 归档
可以保留未解决证据与不安全资源，但不宣称交付或物理静止。两者都保留 Task 历史且不可
重开。参见[Task 交付与归档](docs/task-delivery.zh-CN.md#归档)。

运行时健康度和成本是观察，而不是语义判定。Agent 读取精确的故障和当前意图，以选择重试、
修复或放弃。Yui 不会自动创建救援 Worker 或选择另一个模型。

[文档导航](docs/architecture/README.zh-CN.md)链接当前的各项合同。
[验证策略](docs/testing/verification-levels.zh-CN.md)把核心冒烟与临时的、针对变更的
以及经显式授权的真实资源证据区分开；文档不构成对完整生产验证的声明。
