<p align="right"><a href="./managed-turn-and-session-runtime.md">English</a> | <strong>简体中文</strong></p>

# Session、AgentRun 与通知

## 权威

Task、WorkItem、Message、Decision、Artifact 和 Project Knowledge 保存持久工作。
Session 标识一段原生对话及其捕获的权限。AgentRun 记录一次明确请求的执行和原始
结果。AgentHost 是一次性 attachment，不是 Task 真相的 owner。

一个当前、未撤销的 Leader Session 可以在没有活动 Run 的情况下读取 Context 并保存
范围受限的 Task 事实，包括一个正式的 InputRequest。它确切的 Session 是该请求的
来源；有实际 Run 时会一并包含。这个问题在该执行结束后仍然存在，直到被回答或取消
才关闭。Worker 与 Reviewer 命令保留精确的 Assignment 检查。Session 替换、Role
绑定、Task 范围和资源 grant 各在其边界检查。一个活动 Run 指针并不证明同一 Session
中一条无关命令来自那个 Run。

原生对话、Goal 延续和普通 Leader 通知不会自动创建 Run。显式派发加载一个确切的
Run Context Pack。

## Context

```sh
yui task context <task> --json
yui task context delta <task> --after <coreCursor>
yui task context inspect <task> --store <store> --ref <id>
yui task run context <task/run> --json
```

Task Context 是一个有界的、获授权的工作集，带有当前 core 游标。delta 在一个固定
上界内分页不可变事件；inspect 展开一条当前记录，并可要求确切摘要。运行时观察声明
自己的覆盖范围，不会成为另一份持久快照。

Run Context 冻结 Assignment、来源引用、生效配置和工作区边界。一次 Role 编辑不改写
既有 Assignment。读取任一 Context 都不确认输入或创建执行权限。每一条受管输入都指向
确切的 Session Manifest 和 CLI 入口。Run Pack 是一个参考目录：动手前先读相关的需求
和消息正文，而不是把加载成功当成交付物。规划 Pack 不暴露 Project 写范围或 Task 完成
权限。

当前 Task 读取也会把无定向目标的 user/Operator 消息暴露给该 Task 当前的 Worker 和
Reviewer Session，包括在它们 Run 快照冻结之后新增的需求。用 `task message list/show`
或 Task Context inspect 来读取那些原始记录。这不改写冻结的 Assignment，也不授予投递
权限。定向消息、其他 Role 的结果以及其他 Task 仍在调用者范围之外，除非其 Assignment
授权访问它们。

## 派发与通知

一次显式派发在原生提交之前持久化执行意图。普通 Leader 唤醒则认领一个固定的
TaskWake/mailbox 批次，并通过同一个 Host/Endpoint 提交一条通知。已确认的接受只消费
那个批次；之后的输入仍待处理。通知不需要最终执行报告，也不会强行 steer 进入一段忙碌
的原生对话。

Leader 本地编辑保留持久事件，但不创建自唤醒。当 Leader 忙碌或不可用时，其他来源的
输入仍然持久。Operator 通知同样携带 TaskEvent/InputRequest 读取指针，而不是重复的
Task 叙述。人工输入、显式执行进入和激活失败通过既有唤醒机制及时投递。Worker 结果
保留其聚合窗口。忙碌的原生输入仍保留待处理的消息。

| 证据 | 处置 |
| --- | --- |
| 忙碌且已证明未接受 | 保留输入；新的传输尝试可以使用同一 Session |
| 原生接受 | 绝不重发；若这是一次执行，等待确切终态 |
| 仅有传输写入 | 保留传输证据；不宣称原生已接受 |
| 显式拒绝 | 保留原始原因并结算相应的准入 |
| 未知接受/效果 | 保留该尝试和冲突资源围栏；不重放也不切换 Session |

崩溃后缺少回执不证明未接受。结构化的 `SESSION_BUSY` 是证据；含有 “busy” 字样的文本
不是重试合同。

## 延续既有工作

```sh
yui task message send <task> "Continue with the clarified requirement" \
  --to <role> --work-item <work-item>
yui task message handoff <task/message> --to <successor-role>
```

Review 澄清使用 `--review-round` 代替 `--work-item`。Message 保留收件人、工作关联和
owner Run。当 Role 忙碌时，保存会返回而不打断它。一旦它可用，一个有界有序批次可以
创建一个 continuation Run，与那些消息原子地关联。既有 Assignment、生效权限、工作区
和未完成文件都保留；快照再加上获授权的消息和前一次原始结果。重复的终态不能把消息
指派两次。

所有权变更、不兼容的 Session、终态工作和过时的 Review 候选都保留可见的未投递原因。
显式 handoff 只针对同一工作已派发的后继。复制的 Producer/综合血缘不会被一条消息
静默改写。

未知的 Leader 通知保留其唤醒和输入窗口：

```sh
yui task wake show <task> <wake>
yui task wake resolve <task> <wake> --reason <quiescence-evidence>
```

resolve 在原生效果围栏清除后释放该认领。它既不重放通知，也不编造接受或完成。独立的
Role 工作和合法的本地事实不是一把 Task 范围的恢复锁。

wake 状态记录通知投递，不记录 Message 的实施结果。普通 Leader 通知的 `consumed`
表示原生接受；原生 Turn 完成与 Task 交付应分别依据运行证据和持久结果判断。
被拒绝或释放的 wake 可以保留为 `dispatched`，但已不再占用 mailbox claim。Session 替换把待投递输入
保留给新 wake 与当前 Context，不会追溯把旧 wake 标成已接受；旧回执也不能结算
新批次。Session 清理期间，新输入保持排队。检查时应结合 wake、
`notification.delivery` 事件、当前 mailbox 与 Session，不应要求每个历史 wake
都对应一条最终回复。

现行 wake 只表示通知，Run 完成不能消费 wake；首次通知窗口从 Task 创建时间开始。
退役的 Run-linked wake 通过 Task 事件保留原 ID 和完整原文，不作为第二种活动 wake 格式。

## 输入时机：queue、steer 与 interrupt

提交意图（`record / discuss / develop`）决定需求如何路由。输入时机决定一条已经
获授权的输入何时到达 Role；它不激活 Task、不扩大 Assignment，也不提升 planning
权限。仅保存输入使用 `message send --intent record`，`--wake-policy` 已移除。
Draft Message 编辑只改正文，保留原始提交意图；要选择另一个动作，应显式提交新输入。
[经认证的 Web 控制](architecture/capabilities-and-resources.zh-CN.md#cli-与-web)
与 CLI 使用同样的三种操作。

| 动作 | 效果 | 不证明什么 |
| --- | --- | --- |
| `queue` | 保存 Message，等待收件人的下一个合法机会，按 request ID 幂等 | 读取 Context 或接受投递不等于实施 |
| `steer` | 保存 Message，并尝试原生 steer 精确的当前 Turn | 不受支持、目标陈旧或未确认的 steer 不等于排队延续 |
| `interrupt` | 记录控制请求，请 Provider 取消精确的当前 Turn | 停止请求不等于终态，也不证明后台资源已停止 |

选择实时目标前先检查 Session：

```sh
yui task role session inspect <task> <role>
yui task message queue <task> "<continuation>" --request-id <id>
yui task message steer <task> "<correction>" --request-id <id> --to leader --expected-target <turn>
yui task role interrupt <task> <role> --expected-target <turn> --request-id <id> [--then-message <task/message>]
```

普通 Leader `queue` 输入省略 `--to`。显式 `--to <role>`（包括 `leader`）指向既有
Assignment，必须带 `--work-item` 或 `--review-round`；Message 不能创建 Assignment。
`steer` 仍需要显式 Role 与精确实时目标。同一个 request ID 若换正文或目标会产生冲突。
`steer` 与 `interrupt` 不会静默改目标、
替换 Session、杀进程或回退到另一动作。没有活动受管 Turn 时返回 `NO_ACTIVE_TURN`；
陈旧目标与不受支持的控制也保持为显式结果。

裸 interrupt 不创建 Message。可选的 `--then-message` 引用一条已保存且符合交接条件
的输入，只在精确终态之后、原 Session/writer 边界内保留下一次机会。它不是第四种动作，
也不能用来重放已接受、待确认或未知的 steer。明确证明未投递时，若用户意图允许，
可以显式选择新的控制；不确定性不允许重放。

Global Role 使用同样的三种动作和自己的 owner、Session，不虚构 Task 或 Run。
本地用户 Web Surface 通过共享 Global Role 处理器暴露这些动作。公开 CLI 提供
`yui role message queue|steer <role> <text>` 和 `yui role interrupt <role>`。
queue/steer 要求 `--request-id`，steer/interrupt 要求 `--expected-target`。
这些命令保留调用者现有 Session 权限，不虚构 Task/Run 或借用浏览器用户权限。
配置仍使用 `config role`，生命周期使用 `session`。新的受控 Global Session 使用 Host console。活动的非受管 Session
不会被静默采用，需要先执行显式的 Session 生命周期操作。

## 精确结果

原生终态只结算相匹配的那次执行。已知的原生 Turn ID 必须匹配；串行流可以使用已证明的
本地尝试关联。message UUID 不是原生 Turn ID。同一 Session 中无关的原生对话不能完成
待处理的 Yui 请求。

终态事务保存一个 AgentRunResult 和一条引用 Message。
`resultRef: { type: "agent-run-result", runId: "run-12" }` 展开原始报告而不是复制它。
Candidate 和 ReviewRound 保留来源；Core 不从散文中推导语义接受。

取消请求不证明物理静止。确切的终态证据保留部分输出，并只结算原始执行。Host 退出
并不意味着共享 Provider 或后代进程已停止。

## Draft 规划与激活

`EffectiveLaunchSnapshot.executionAuthority` 捕获 `planning | delivery`。它不从 Task
当前生命周期重新计算。planning 允许本地规划事实，不允许交付派发、候选采用、集成或
交付工作区 Job。

初始 Draft 规划派发创建一个 planning Run，并只绑定其初始消息批次。接受或一个确切终态
消费该批次；失败不会反复重建同一个规划执行。既有 planning Session 中后续的普通消息
仍是通知。Operator 提交和直接的 Task 消息都能到达那个 Session。Draft 计划/WorkItem
编辑保留执行历史；外部编辑通知 Leader，而它自己的规划编辑不创建自唤醒。

新的 Draft Role 使用位于 `<YUI_HOME>/runtime/task-runtimes/planning` 下、专属于该 Task 的规划
目录，与持久控制数据和交付树分开。一个 planning Run 可以用 `task activation request`
持久化意图并立即返回一个 `afterPlanningRun` 引用。它的终态把该请求释放给 Controller
准入；被取消的意图不会复活。Leader 也可以在普通讨论中请求激活而无需 AgentRun：一旦
原生输入结算，Controller 就采用其持久意图。不需要合成 Run 或额外的用户“continue”。

对于已绑定的 Git Project，`--environment empty` 表示没有额外环境：这些 Project 仍会
获得受管 worktree。`scratch` 选择一个 Task 拥有的目录。`local` 需要一个已登记的 local
Resource 及其 grant；Project ID 不是 local Resource ID。

`task activate` 是对已有请求的前台采用，不是创建激活意图的另一条路径。
没有请求的 Draft 会在资源准备前被拒绝；命令不代填环境计划或 request ID。

资源准备先于对 Task 状态和工作区所有权的原子采用。一次失败的采用记录一个失败请求，
并用持久事实通知 Leader；在失败未变时它不反复准备资源。Leader 选择显式重试或修正后的
请求。成功激活同样为 Leader 留下一条交付通知。激活绝不把活动 Session 变更为交付权限。
一次改变的启动必须通过既有的 Session 替换/环境边界。planning 权限是一项 CLI 保证，
不是针对恶意代码的文件系统沙箱。

## 检查与生命周期

```sh
yui task run list <task>
yui task run show <task/run> --json
yui task message show <task/message>
yui task role session inspect <task> <role>
yui task execution start <task>
yui task execution stop <task> --force --reason <reason>
```

Task execution start/stop 控制 Task 准入，而不是 Task 验收。stop 先围住新的 Yui 工作，
然后中断每一条被拥有的确切原生输入，并在移除 attachment 之前确认其终态。这也覆盖没有
Run 的普通 Leader 通知。未知的原生状态阻塞清理；仅停止一个代理绝不证明一个共享 Turn
已结束。start 保留持久进展，并在旧占用结算后接纳新输入。Draft 规划可以暂停/恢复，
失败的 planning Run 以 planning 权限重试。获授权的 user/Operator 可以通过
`task role session stop` 停止一个空闲的 Draft Session；它不必仅为恢复就激活 Task。
`task role session new <task> <role> --reason <reason>` 持久化一个显式替换请求。复用是
一种偏好，而不是要求证明旧对话不可恢复。该请求在 AgentRun 活动、Session 已结束或
上一次清理待处理时都是合法的。Leader 也可以请求替换自己并结束当前轮次。

`task role session stop` 也可以在不先更改 Run 状态的情况下停止一个运行中的 Role。它
保留原生对话以备复用。待处理的 Message 仍是意图，可以在停止后启动一次 continuation；
当整个 Task 都必须保持暂停时，使用 Task execution stop。对于自我替换，使用异步的
`session new` 请求，而不是同步的自我停止。

既有的运行时清理路径停止确切的原生执行，把该 Role 剩余的工程尝试关闭为 cancelled，
保留 Session/Run 历史和工作区，并选择一段新对话。其他 Role 和 Task 验收保持不变。
Leader 收到一条新的上下文通知；它决定重试哪些 Worker/Reviewer 尝试。待处理的输入
引用在替换后仍然存在，包括比新通知时间窗更早的记录。

一个缺席的 Host 不移除恢复入口。Codex 可以通过一个一次性的原生控制连接被检查和中断，
而不启动模型。专用 Claude 进程托管独立于 Host 持久化。真实的未确认执行仍阻止冲突资源
复用；清理失败是一条路由给 supervisor 的持久诊断，而不是编造接受或删除 Task 的理由。
仅有一个预分配的 ID 不证明一段对话存在。Codex 在一次失败的原生 Turn 之后可能保留
`systemError`。仅凭那个标签既不证明活动也不授权清理：Yui 在替换 Session 之前会检查
最新原生 Turn 的终态元数据并排空后台执行。未知或仍在运行的原生工作仍受保护。

已释放的 Leader 保留对自己 Task 和上下文的范围受限诊断读取，但不能修改它或读取另一个
Task。Operator 诊断和 Controller 重启不先要求一个健康的 Controller；当 RPC 不可用时，
显式重启只能用 PID/start 身份停止同一 Home 的那个确切进程。Operator 的存储诊断/升级
也能到达专用的迁移入口，而不先要求 Home 已经处于目标存储版本。完成、取消和归档具有
彼此不同的权限和资源边界。存储变更使用唯一的
[升级合同](sqlite-control-plane-design.zh-CN.md)。
