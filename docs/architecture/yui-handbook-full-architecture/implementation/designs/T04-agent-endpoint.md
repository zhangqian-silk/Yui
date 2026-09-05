# T04 技术方案｜统一 AgentEndpoint 与运行时适配

硬依赖：T02。

任务定义：[交付范围与证据](../tasks/T04-agent-endpoint.md)。

## 1. 代码边界

定位现有 Agent 配置、启动参数构造、结构化连接、原生事件归档、会话恢复与进程清理。先把它们装入统一 Endpoint，再根据真实复用点分离产品、协议和载体代码。

AgentEndpoint 是上层唯一执行接口。产品发现、native 参数和 protocol codec 可以在同一个插件包中；通信工具可以是普通共享库。Task 不保存一份可任意组合的 Runtime／Protocol／Transport 图。

## 2. Endpoint 行为

open／resume 返回 Session 引用和实际有效配置。submit 接受稳定 attemptId 与 inputRef，返回 accepted／pending／not-submitted／unknown。inspect 提供事实，不解释任务进展。cancel 区分请求与确认；detach 只回收 Yui 自己的附件。

对不同 Provider 保留实际能力：native steer 与排队下一 Turn 不等同，transport write 不等同 native ack，本地 attemptId 不等同 nativeTurnId。原生错误保留必要证据并映射为可读事实，不在适配器内选择新模型或新任务。

## 3. Codex 与 Claude 的实现

读取实施时安装 CLI 的实际协议和配置支持，固定被验证版本。将现有 Codex native 会话路径和 Claude 结构化路径逐一对应到 Endpoint，不根据文档示例猜测某个 flag 或方法已经存在。

现有共享会话或原生客户端共存行为应继续成立。Yui 管理自己的连接和自有子进程，不把共享 daemon 当作 Task 清理对象。用户原生执行占用会话时，Yui 输入保持待投递。

配置更新默认作用于新执行。一个长期 Session 保留实际 driver 和必要状态依赖，新配置不覆盖历史快照。第三 Agent 的通用性在 T07 实际验证，不在本任务追求所有协议功能的提前统一。

## 4. 结果与事件

事件入口核对原 Session、attempt／native ID 和实现引用，重复终态写一次原结果。早到终态可在接受回执之前被临时关联，最终归同一次 Turn；迟到事件不影响 successor Turn。

结果原文存一次。Review 和 Candidate 引用它，不由适配器解析“通过”“完成”等文字推动 WorkItem。

正常长请求保持 pending；连接中断且效果无法判断才成为 unknown。未知状态可以通过原会话查询澄清，但不能切到另一个 Provider 或 PTY 自动再发。

## 5. 轻量执行准入

同一 Role 的普通执行避免重叠。已声明 WorkItem 依赖可以检查是否有当前可用结果。暂时没有资源时保留同一请求或返回事实，由 Leader调整，不自动选择另一个 Worker。

ExecutionGroup 保存同 Assignment 的副本和尝试编号；综合输入显式引用选定的 Turn，框架不决定成功数量和投票规则。多路写入使用 T05 可提供的隔离或资源条件；外部发布动作不默认复制。

## 6. 取消与资源事实

停止请求不能直接清空所有使用信息。Agent 需要重新利用可能冲突的目录时，获取已停止或隔离的证据。对未知或仍在后台执行的资源保留引用，但不冻结无关 Task 工作。

Leader 换绑先影响新的管理动作，旧结果仍可归档。真正冲突的资源操作经当前 Resource 能力检查，不能只看数据库 Role 已变更。

## 7. 兼容选择

新 Endpoint 未覆盖某个真实路径时可以保留当前实现，并在创建 Session 时明确选择。一个正在进行的请求不会在两条路径之间迁移；现有 Session 可以继续其原实现。

暴露当前选择和实际有效配置，便于验证。只在能证明同等行为时删除旧代码，不要求同一个 Task 完成全部清理。

## 8. 验收

使用协议 fixture 覆盖接受前后断开、长 pending、重复与迟到事件、原生 busy、取消未确认等边界，再在明确授权下运行 Codex 和 Claude 的真实主路径。

S09、S11、S12、S14、S17、S21–S24、S35、S39 验证执行契约；S18、S19、S41、S43 验证 Task／Role 集成。未运行真实 Provider 的场景必须标为未验证，不以模拟端点结果替代。
