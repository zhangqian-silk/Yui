<p align="right"><a href="./README.md">English</a> | <strong>简体中文</strong></p>

# 运行时观察与诊断

只读投影帮助 Agent 区分持久意图、实际运行时活动和未知效果。它们不引入第二套
调度或验收权威。

## 检查

```sh
yui controller status
yui execution audit --task <task-id> --json
yui task next-action <task-id>
yui task role session inspect <task-id> <role>
yui task run show <task-id>/<run-id> --json
```

Controller status 暴露当前进程与 Home 身份。Session inspect 区分期望绑定、
生效启动、实际连接以及 Agent 自报配置。Run 检查暴露原始输入、处置、精确结果
和诊断。读取状态不会启动另一个 Agent，也不确认工作。

## 证据的含义

- Task 与 WorkItem 生命周期描述意图和验收。
- AgentRun 生命周期描述明确请求的一次执行。
- Provider 接受与原生活动描述实际的输入/连接。
- Host PID、tmux 与资源清单描述进程观察。
- 运行时配置区分请求值与自报值。
- token、时长与编排成本是仅供参考的观察。

对于专用 Claude 流，一次主 assistant 响应会在终态结果之前确认当前这一条本地
输入已被处理。因此该响应到达后，Controller 与 Role 读取才显示 accepted/running。
启动、回显的用户输入、子响应以及重复的旧消息都不建立新的接受；message UUID
永远不作为原生 Turn ID。

普通 Leader 通知是 TaskWake/mailbox 投递，不是 Leader Run。即使没有打开
AgentRun，Role 状态也包含其原生准入/活动；当某个 WorkItem 处于终态时，它显示
保留 Session 的实际工作区，而不是用 Task main 顶替。未知证据仍为未知；进程退出
不证明共享 Provider 已停止，传输成功也不证明原生已接受。

工程控制证据可以比附着的 Session 缓存活得更久。这样的 Role 会把保留的原生输入
报告为需要关注，而不因缓存为空就当作空闲。范围受限的 Task/Session 检查仍可用于
诊断。替换与原生清理失败是持久事件，路由给 supervisor；替换后待处理的输入引用
仍然可读。

精确的工具 start/result 事件投影为 `tool-active`，模型活动投影为 `model-active`；
安静间隔并不意味着 Agent 卡住或已完成。工具失败是操作结果，不是自动的 Run 失败。
被拥有的 Claude 执行进程若死亡，会关闭其精确输入并把 Session 标记为 failed，即使
监督它的 Host 仍存活。一个已被有意停止、且原生输入已结算的 Session 是空闲状态，
而不是虚假的运行时失败。

## 执行审计

`execution audit` 汇总既有的 Task、Run、wake、Session、Review、Integration、
Publication、事件、WorkItem、存储和编排证据。`--since` 与 `--until` 界定时间窗。
各部分各自报告自己的读取错误，不为缺失数据编造值。

故障分类使用 Core 拥有的失败原因或明确标识的 Core 诊断证据。Agent 撰写的报告
散文不会被解析为判定或严重级别。原生 Agent 错误保留其原始负载和标准类别，供
Agent 结合当前 Task 上下文解读。

成本与重复劳动提示不会阻止一个合法动作、设定 Review 预算或选择恢复拓扑。
`task next-action` 是决策支持，不是自动执行的计划。

## 隐私与资源边界

Telemetry 和缓存是诊断材料，不是 Task 真相，也不是 transcript 备份。不要仅为
解释某个状态就采集或发布凭据、私有环境值或原始 Provider 历史。

从精确的只读记录开始。进程变更、取消、grant 更新和资源清理都需要相应的显式动作
与范围。一个笼统的诊断请求不授权真实模型、共享或生产环境的测试。

## Task 用量与耗时

Task overview、Web Task/WorkItem 卡片和 `execution audit` 共用授权 Task
事件的纯读投影。读取不采样 Provider、不打开原始 transcript；没有新增指标存储、
迁移、价格表或预算策略，既有历史仍可读。

每项指标带 `value`、`status`（`known`、`partial`、`unknown`）和 `reasons`。
未知为 `null`，不是零；真实零必须有数值证据。部分值是已观测小计，不是完整账单，
也不保证是单调增长的下界。覆盖说明包括已观测 Session 身份、来源/计数语义和
证据截止点，不对不可知的 Provider 总量伪造覆盖百分比。口径是 Task 围栏内的
已观测来源。
JSON 使用方改读 `cost.tokens.value`、`cost.toolCalls.value` 及其状态/原因，
不再读取数字占位和 observable 标志。`elapsedSeconds`、`executionSeconds`
替代含义错误的 Group 求和 `wallClockSeconds`；这是读投影变更，不是持久存储变更。

- 请求用量复用 Session reducer：按稳定请求身份取最后收到的修订，累加输入与
  输出，缓存/推理子项不重复增加。缺失边界、混合语义、累计回退不猜测；剩余
  上下文是容量，不是消费。
- Session 替换不抹去历史。首次非零累计快照可能早于 Task，因此作为排除基线；
  后续可比增量为部分值，仅一个非零快照时 Task 用量未知。零基线可支持后续
  累计值。JSON 单独暴露原始 Session 计数，它不是额外的 Task 消费。
- Leader 直聊不需要伪造 Run/WorkItem。WorkItem 仅接收各次修订均绑定同一
  精确、匹配 Run 的请求用量；累计值不摊派，整个 Session 的原始计数不冒充
  WorkItem 用量。Task 总量不必等于 WorkItem 小计之和。
- 当前合同无法证明子执行计数在父统计之外，因此排除子计数并将覆盖标为部分。
  多个 Role 对同一原生计数器的归属冲突为未知，不当成两份独立总量。
- 工具次数按保留的精确原生 Session/Turn/operation 身份去重，失败调用也计一次。
  工具历史已压缩，有证据时只能是部分次数；无证据为未知，不能推出零调用。

**任务历时**从 Task 创建（含规划和等待）到记录的完成、退役或取消时间；
活动 Task 截止本次读取时间。归档保留原终点，终态证据缺失则未知，与 Group
数量无关。

**已观测原生执行累计**合并同一原生资源上起止完整、彼此重叠的 Turn 区间，
再相加独立并行资源。两个独立执行各十秒，可以在十秒自然时间内累计二十秒。
它不是 CPU/GPU 时间。由于 Turn 历史已压缩，该指标为部分值；缺少起止证据和
运行中的 Turn 不计入，不无限延长。保留不足一秒的精度，WorkItem 卡片不再用
Group 时长替代上述含义。

即使 `--since`、`--until` 过滤其他审计部分，`usage` 部分仍明确为 **Task 全生命周期**。
首版不提供窗口消费，不能先过滤累计快照，再把历史消费称为窗口用量。
既有 AgentRun 时长部分保留为单独标明的 Run 指标。

确定性 fixture 验证共享 reducer 和 CLI/Web/audit 语义，不证明真实 Provider 的
覆盖完整性。内置归一化支持来源所提供的 Codex 累计观察和 Claude 请求观察；
本次交付不采集真实模型账单证据，也不声称已实测真实 Provider 行为。
