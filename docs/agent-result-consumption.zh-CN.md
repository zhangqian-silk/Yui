<p align="right"><a href="./agent-result-consumption.md">English</a> | <strong>简体中文</strong></p>

# Agent 结果消费

读取原始结果前，可用[有界 Task 目录](task-discovery.zh-CN.md)发现候选任务。
目录摘要不替代需求正文或原始结果。

每一次显式派发的 AgentRun 都产生一个持久的原始结果。普通通知和原生对话不会
隐式创建 Run。所有权链上的下一个 Agent 读取这个精确结果并判断它意味着什么。

## 唯一的原始结果

`AgentRunResult.output` 是 Agent 撰写的报告。Core 保留其字节，不解析、不分类、
也不校验语义内容。Markdown、JSON 和普通散文都是合法的；缺少标题或结论不够有力
都是质量证据，而不是运行时失败。

Core 另外记录 Provider 身份/状态、完成时间、诊断、失败原因和系统拥有的工作区
证据。非空输出必须符合当前传输上限且不含 NUL。缺失或不可传输的文本会让 Run
失败，而不编造散文。当之后某个 Core 拥有的边界失败时，一份已到达的报告仍可以
留在一个 failed 的 Run 上。

终态结果会附带保存一条引用 Message。`task message show <task/message>` 和
Context inspect 展开同一个 `resultRef`。ReviewRound 不持有第二份报告。文件和
持久业务产物归 Artifact 或受管 Git 结果。

## 执行不等于验收

Run 生命周期是 `active / completed / failed`。Provider 结果、输入接受和资源静止
是彼此独立的事实。Run completed 只表示它所需的 Core 执行边界成功，而不表示答案
正确或 WorkItem 已验收。

可写的 replicated Lane 需要其精确的、Core 拥有的工作区证据。分支错误、快照脏、
owner 不符或范围不符都会让该边界失败，但不会替换一份已到达的原始报告。

只有 Leader 决定证据是否足以验收、继续工作、再审查或放弃。Core 从不从 Agent
文本中推导 findings、投票或修复拓扑。

## 直接执行与复制执行

直接的 WorkItem 执行使用一个 main Run，没有 ExecutionGroup。直接 Review 同样
使用一个 main Reviewer Run。

复制执行在一个冻结 Assignment 上使用彼此不同的 Producer Lane。每个 Producer
保留自己的原始结果和精确血缘。Leader 显式地把彼此不同的终态来源 Run 引用交给
综合。来源必须属于确切的 Group/Lane 且有结果，可以是 completed 或 failed。不存在
自动综合、投票、最少成功 Producer 数，也不要求在选择来源前等待所有 Lane。

综合快照保留所选来源顺序，以及它们原始输出、诊断和来源的有界视图，不复制完整
transcript。只有 main 综合结果能提供 WorkItem Candidate 或权威的 replicated
Review 结果。Producer 从不直接进入 Integration 或验收。重试针对失败的那次精确
执行，不会静默重跑已成功的 Producer。

## Review

ReviewRound 拥有冻结的 Candidate 或 Task-head 身份、工作区来源、执行拓扑、精确
的 main Reviewer Run、生命周期和 Core 诊断。它的 completed 状态是结构性执行证据，
而不是从报告里提取出来的“通过”。

Candidate 审查遵循其捕获的审查规则。Task-final 审查可以被显式请求，或由不可变的
final-review 合同要求。一次被请求的审查是证据，而不是要求此后每次改动都审查的
自动新策略。当前交付需要审查时，它必须覆盖确切的治理候选或 head 以及 completed
的 main Run。

Reviewer 应检查完整的有界范围，并把重要 findings 一并报告。Leader 读取完整报告，
把 findings 路由给原 owner，直接修复 Task-main 上的小问题，只为有独立价值的实质
工作创建新的 WorkItem。

## Leader 消费

唤醒窗口指向带结果的事件，包括在窗口之前创建、但在窗口之内完成的 Run。读取精确
来源：

```sh
yui task wake show <task> <wake>
yui task run show <task/run>
yui task message show <task/message>
```

一个可选的报告结构是：结果、改动/发现、验证、不确定性和下一步动作。它是沟通
建议，不是机器协议。

验收与 Task 完成仍是显式操作，并带有当前 Git、审查、范围和资源检查。参见
[执行与会话](managed-turn-and-session-runtime.zh-CN.md)和
[Task 依赖](task-dag-semantics.zh-CN.md)。
