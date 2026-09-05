# Execution 与 Runtime：一次执行的可靠承载

**层次位置：Execution Plane；在 Capability Plane 暴露派发、查看、停止等原子入口。** 本模块执行已经提出的请求、采集结果；Runtime／Protocol／Transport 是内部接口分工，公开使用统一 AgentEndpoint。

分层位置与完整工作关系见[总体架构](../architecture/01-overview.md)。

## 1. 责任

Execution 接受已明确请求的工作，建立 Turn，取得可用 Endpoint，收集输出并保存。它不对输出质量做判断，也不因为失败次数自动更换执行策略。

Runtime 内部负责产品启动、协议交互和连接。上层只使用 AgentEndpoint，不直接解析 terminal 字符、Provider Hook 名字或 JSON 字段。

## 2. 执行对象

| 对象 | 保存内容 | 生命周期 |
|---|---|---|
| 执行请求 | 目标、Role、输入、请求者 | 等待准入或被明确处置 |
| Turn | 实际输入、配置、原生关联、输出／错误 | 一次执行事实 |
| Session 引用 | 原生会话 ID、有效配置、实现引用、环境 | 可跨多个 Turn 续用 |
| Host | 连接、进程、事件订阅、实例句柄 | 临时运行对象，可重建 |
| ExecutionGroup | 相同 Assignment 的副本及尝试引用 | 关联执行，不拥有工作流状态 |

Session 元数据可以持久化，实际对象不保存。Host 退出不自动删除 Session，也不自动完成 Task。

## 3. 最小 Endpoint 契约

Endpoint 能打开或恢复会话、提交输入、检查事实、请求取消、可选 steer、读取事件并解除附件。每项操作的具体支持来自实际实现描述。

提交结果包含 accepted、pending、not-submitted 或 unknown。accepted 的证据可以来自 Provider 确认或准确关联的终态；只有通信写入时明确标记证据较弱。内部可以分配本地 execution ID，但不把它命名为 Provider 返回的原生 Turn ID。

事件入口必须能关联到原请求、Session 及相应实现。重复事件不重复创建结果；迟到事件写入原 Turn，不完成后继 Turn。

## 4. 产品、协议与载体组合

产品适配知道 binary、版本、认证配置和启动预设。协议适配知道 Session、Turn、事件和错误语义。载体知道打开与关闭何种连接。

Endpoint 工厂只允许已声明兼容的组合。具体 CLI 是否支持 ACP、哪个版本或 native 连接，应在实现时探测验证。协议公共代码可以复用，但不同能力不被填成相同布尔值来掩盖差异。

Codex 与其 App Server 适配可同包；通用 ACP 实现可供多个产品使用。一个只支持终端的 CLI 可以作为人工终端资源接入，不自动成为高保真 managed executor。

## 5. 准入与并行

已经提出的执行请求检查 Role 是否有 active Turn、配置是否可解析、所需环境是否可使用。暂时不可用返回事实或保留同一请求，避免创建重复工作。

同一 Role 普通输入串行处理。不同 Role 可并行。多路执行共享一份 Assignment，每个副本有自己的尝试编号，重试不变成新副本。

资源写冲突优先通过分离环境处理。Execution 不建立全能资源锁系统，具体插件负责其资源的条件；已有写入证据不能只因管理配置切换就忽略。

## 6. 输入与用户共存

用户可能直接使用原生会话。若它已忙，Yui 保留输入，不抢占或静默插入另一轮。运行中输入的语义必须明确是 native steer、排队下一轮还是不支持；不能用同一个函数名字把三者混为一谈。

Controller 重启后可以根据保存的原生身份检查当前状态。可以证实的结果写回一次；不能确认接受与否的请求保持 unknown，不以新 Session 自动重发。

## 7. 结果、取消与后台活动

原生终态结束相应 Turn 并保存原始可见结果。Task 层再由 Leader 使用结果。

取消分为 request 和 confirmation。请求成功不等于所有后代进程和外部服务已停止。Agent 需要重用冲突资源时，查询相关活动或更换独立环境；无关活动不阻止任务其他部分推进。

原生 subagent 的输出可作为父执行证据保留，必要时单独引用已得到的结果。它们不自动形成独立 WorkItem，也不因父执行结束而假定全部已取消。

## 8. 实现更新

普通调用固定到调用结束；长会话固定 Endpoint 与其必要状态型依赖。新 Session 选择新版本，旧 Session 通常继续旧版本。

若旧运行实例丢失而代码不再保留，准确报告不能按旧实现续用。负责人可以新建 Session 从 Task Context 接手，不因此宣称任务事实丢失，也不悄悄用不兼容 Provider 恢复原调用。

热更新不保证零间断，不要求动态迁移所有协议状态。最小正确行为是明确使用哪个实现，并让用户／Agent有能力在适当边界停启。

## 9. 观察与故障

runtime activity 与 task progress 分开。正常模型长调用可以没有频繁工具事件；token 增长也可能不代表任务有成果。Execution 保存观察，不由它制定失败阈值驱动业务重试。

连接层已有的有限同目标重连可保留。失败通知按 Role 路由：Worker／Reviewer 给 Leader；Leader 给 Operator。Operator 自身问题没有额外自动处理机制。

## 10. 验收要点

关注真实提交证据、pending／unknown、迟到事件、同 Session 配置、用户直接输入、资源停止证据、多路尝试关系及 hot reload。对应场景为 S09、S11、S12、S14、S21、S22、S23、S24、S25、S35。
