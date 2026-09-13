<p align="right"><a href="./agent-runtime-drivers.md">English</a> | <strong>简体中文</strong></p>

# Agent 运行时 Driver

AgentEndpoint 提供通用执行边界。Driver 把原生事件、错误和受支持的观察来源翻译
成 `RuntimeObservation`；Controller、Store、CLI 和 Web 消费这份共享合同。

## 职责

连接实现拥有启动、协议、prompt 投递、resume 和中断。Driver 拥有原生身份提取、
观察能力、事件/错误映射和用量归一化。Core 拥有权威、精确的请求关联、持久归并
和投影；Agent 选择恢复方式并判断语义进展。

内置 Driver 身份为 `openai/codex`、`anthropic/claude-code` 和
`acp/agent-client-protocol`。ACP 是协议 Driver，不是产品标签。接入一个 ACP peer
不需要另一套业务状态模型。

能力必须如实声明。未知的 resume、取消、活动或用量行为不能从产品名推断。

## 观察路径

原生结构化事实通过精确的 Session/请求围栏，进入运行时收件箱，并归并为持久观察
和原始结果。一个单独采样的用量来源可以馈入同一份规范合同。Driver 不能选择另一个
actor、指派后继 Run，也不能绕过围栏。

Yui Run 身份与 Provider 原生 Turn 身份不可互换。一个显式派发的 Run 保留其已接受
的原生关联；直接的原生对话不是另一个隐式 Run。重放按精确事实身份去重，迟到事件
不能终结一个后继。

受管 Codex 使用 App Server 事件。Claude 映射其结构化流以及受支持的 Hook/来源
负载。ACP 映射协议 Session 更新和 prompt 响应。终端文本、信任对话框和 prompt
字形都不是生命周期事实。

## 状态与错误证据

持久 Run 生命周期是 `active / completed / failed`。输入处置、原生等待/活动、Goal、
Session 生命周期和进程存在回答的是不同问题。UI 投影不得把一个排队中的请求当作
Agent 忙碌的证明，也不得把一个存活进程当作接受。

标准 Agent 错误保留 source、phase、category、code、输入处置、Session 处置以及
序列化的原生错误。类别包括 availability、rate-limit、transport、access、
invalid-request、context、session、runtime、conflict、cancelled 和 unknown。
映射报告证据，而不是重试策略。无法识别的错误保持 unknown。

运行时活动与工作流进展使用彼此独立的证据。一个工具边界可能显示原生活动；一个
持久且被接受的结果才显示语义进展。token、CPU、RSS 和面板存在都不能替代接受或
Task 完成。

## 用量

用量是只读的，范围限定在确切的原生 Session。输入/输出总量与缓存/推理分解、请求
上下文和剩余容量区分开来。稳定的 activity ID 对请求快照去重；累计增量只在具备
有效有序的同 Session 证据时使用。

缺失、部分、混合或已回滚的观察保持“未观察”，而不是猜测。增量观察者报告健康度
和覆盖度；采样不阻塞生命周期事件。度量绝不触发模型选择、唤醒、重试、资源释放
或接受。

[Task 用量与耗时](observability/README.zh-CN.md#task-用量与耗时)跨历史 Session
复用此 reducer。Task 围栏内的观察不是完整账单保证。缺少明确互斥合同时，原生
子计数不加入父 Session 总量，也不作为额外请求。原始 Session 累计值与安全归属
的 Task 增量分开；仅精确请求/Run 绑定支持 WorkItem 分配。

## 原生子代

原生 subagent 是父对话内部的协作，不是 Yui Role、Lane 或独立的受管工作区 owner。
当 Provider 暴露血缘和结果引用时，continuation 观察可以记录它们。

尽力而为的子代结果通过父代返回。只有持久化的内容回执才支持 `durable-result`；
存活的子代或声称的成功都不行。被报告的结果仍是不受信任数据。一段丢失的尽力而为
对话可能需要重做工作。当需要独立的持久性和验收时，选择受管的 WorkItem 执行；
复制是另一个单独的选择。

## 接入与验证

一个新的连接实现必须提供如实的控制/观察能力，并把它们与精确的身份、错误和终态
映射配对。Provider 专有的协议细节留在边缘，不进入 Task 规划、Store 语义或 Web
业务规则。

针对变更的一次性证据应覆盖被改动的关联、权限、取消或观察边界。永久测试保持在
[验证策略](testing/verification-levels.zh-CN.md)中的主要路径。真实
Provider/模型验证需要显式授权，并且必须把原生进程证据与夹具输出区分开。
