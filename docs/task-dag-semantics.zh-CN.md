<p align="right"><a href="./task-dag-semantics.md">English</a> | <strong>简体中文</strong></p>

# Task 依赖与 WorkItem 语义

## 需求与执行分离

Task 是一个有界结果，WorkItem 是其中可独立验收的需求。Task type 不决定
执行拓扑；Leader 可以直接工作，也可以创建独立负责人交付的 WorkItem。
实现步骤、一次测试、审查发现或小修补不因此成为新 WorkItem。

WorkItem 持久状态仅为 `open / accepted / retired`：

- `open`：需求仍在处理；可能尚未执行、正在执行、等待验收或需要重试。
- `accepted`：Leader 已显式接受当前交付。
- `retired`：需求已显式退役，保留记录和原因。

执行状态归 AgentRun，Candidate 记录当前待接受的结果。提交、拒绝或执行失败
不把 WorkItem 变成另一套运行状态。接受撤回是显式动作。

## 唯一依赖权威

`WorkItem.dependsOn` 是同一 Task 内的直接依赖列表。前置项 A → 下游 B
表示 B 的 `dependsOn` 包含 A。保存时检查同 Task 引用、存在性和无环约束。
它不表达 Provider 并发、Session 占用或文件锁。

派发时，每个直接依赖必须存在且为 `accepted`。Open、retired 或 missing
均不能满足依赖，错误返回具体 ID 和当前状态。Run 成功、Candidate 存在、
Review 完成或 Git 已集成都不能代替 WorkItem 接受。

退役的 replacement 字段只解释替代关系，不重定向或重写依赖。
Leader 必须显式修订需求或依赖；Controller 不沿替换链自动释放下游，
不级联取消、不自动跳过，也不把依赖列表变成调度计划。

## 修改与恢复

Open WorkItem 的合法定义编辑保存前后值，保留身份和执行证据。已经启动的
Run 仍使用冻结 Assignment；修改当前需求不追溯改写其 Context 或权限。
已接受和退役的定义不能借普通编辑覆盖。负责人与资源范围变更受各自边界检查。

执行失败时，Leader 检查原始结果、Session、依赖与工作区，决定续作、重试、
退役或修改计划。退役后迟到消息保留来源和未投递原因，不自动重开。
InputRequest 表示待决问题；回答不自动接受 WorkItem 或改写依赖。

## 接受、集成与 Task 完成

Direct 和 replicated 共享一个 Leader 接受边界。Replicated Producer 不形成
Candidate；只有显式综合的 main Run 结果进入候选路径。Leader 直接管理的
交付也必须满足适用的 Candidate 和 Integration 边界。

隔离代码结果按 Project 冻结 Candidate 提交，检查后 CAS 集成；缺少快照、未集成
或失效的最新结果不能满足交付。Review 依适用规则和 Task 合同检查。
Leader 自己交付的 Task main 需要干净、已提交的精确快照。

Task lifecycle 是 `draft / active / completed / cancelled / archived`。
Draft 先规划再显式采用工作区；completed/cancelled 不接收隐式新执行，
reopen 不重放旧请求；archived 不可重开。Archive 还要求资源静止、干净可移除，
不因依赖图或完成状态自动删除工作区。

CLI/Web 从这些事实派生展示和建议，不维护第二套可写 DAG、验收状态或计划。
