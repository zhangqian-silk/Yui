# 端到端工作逻辑

**阅读视角：工作关系、逻辑层次和事实流的组合。** 自然语言经过 Operator／Leader 决策，确定操作可直达 Capability Plane；结果进入持久化，再由 Context 支持下一步判断。

本文用完整工作过程说明模块怎样协作。过程中的 Agent 决定不是框架强制步骤；每条链都可以根据任务需要缩短或组合。

## 1. 从全局需求进入两个任务

用户向 Operator 描述两个目标。Operator 判断它们可以独立交付，调用 Task 创建能力，分别建立 Draft 和 Leader Role。两份 Task 都持久化目标和必要背景，不要求立即启动两个常驻会话。

用户进入 Task A，与 Leader A 细化方案；同时也可进入 Task B。Surface 根据 Task 路由到对应 Leader，没有“必须回 Operator 转述”的限制。跨任务资料使用共享 Project 知识或带来源的普通消息传递，不建立自动跨 Task DAG。

**事实链：** 用户请求 → Task／Brief → Leader Role。  
**运行链：** 用户进入 → 按需 Session → planning Turn。  
**决定者：** Operator 划 Task，Leader 划内部工作。

## 2. Draft 中持续对齐

Leader 读取当前 Brief，讨论后直接更新要求或方案。对重要取舍写 Decision；日常进度写 currentFocus。必要资料通过 Artifact 保存，可从 Context 展开读取。

用户同意开始后，Leader 或 Operator 提出 Activation。若由当前 planning Turn 发起，请求立即返回，Turn 完成后执行资源采用。正式 Session 能兼容续用就续用，不能则打开新会话读取同一 Task Context。

Activation 的记录说明开始时依据什么，不限制之后继续讨论。临时实验内容可以显式引用或复制到交付环境，但不会因目录存在就自动被采用。

## 3. Leader 直接完成一个小任务

任务只需要整理一份说明。Leader 使用已有能力读取材料、生成文件、保存结果，然后调用 Task 完成能力写入说明和产物引用。

不需要合成 Worker、WorkItem、Lane、Review 或 Git Integration 来满足统一流程。Task 完成由明确操作产生，原生 Turn 的结束只保存该次回复。展示层读取两者各自的事实。

## 4. 两个 WorkItem 并行

Leader 建立两个可以独立负责的 WorkItem，分别配置 Worker Role 并发出执行请求。Execution 检查角色是否忙碌及实际环境条件，创建 Turn 并调用 Endpoint。

Worker 输出分别保存到原 Turn，通知 Leader。Leader 可以请求 Candidate、直接读取产物、发送反馈或接受结果。若一个 Worker 失败，另一个正常执行不受影响；失败只成为当前 Task 的一条事实。

要求改变时，Leader决定哪些工作需要调整。框架不自动根据每个 Brief 修改取消所有 Turn，也不以所有候选拥有同一 revision 为完成前提。

## 5. 同一工作多个独立尝试

Leader 请求两个角色对相同 Assignment 独立研究。ExecutionGroup 仅关联副本和各次尝试。每个结果保留来源；失败后重试仍归同一副本，避免综合时把一次重试当成两个独立意见。

Leader 可自己综合，也可委派一个主执行读取明确选择的结果。不默认“必须两个成功才能继续”，也不默认重复发布或发送。涉及写入时，先使用隔离环境或只读任务形态。

## 6. 用户直接改变要求

用户在 Leader 原生会话中说明目标变化。Leader 判断该信息需要跨会话存在，调用 Brief 更新并必要时记录 Decision，然后通知相关 Worker。

协议能提供输入证据时，Execution 留下可见来源；协议不能观察时，Yui 依赖 Leader 的显式写入，不补造消息。若 Leader 在持久化前失去会话，Operator 可根据现有记录和用户重新对齐。

已保存结果继续可读。Leader可复用它、修复一部分或重新执行；这些判断不由 Framework 的“过期”标记替代。

## 7. 切换角色使用的 Agent

Leader 将一个 Worker 的当前配置从 Agent A 改为 Agent B。Role 的逻辑身份不变，WorkItem 和消息不重建。

旧 Turn 仍按原配置结束，或者由 Leader 明确取消。新执行使用新有效配置，必要时新建 Session 并读取 Assignment 与持久化结果。新的 Session 不必重现旧会话的全部 token 历史。

配置切换不删除旧结果，也不需要全局重载所有插件。

## 8. 在原 Task 中补齐能力

Leader 需要处理一种当前目录没有覆盖的数据格式。它先查询现有能力，确认简单组合不足，再在授权的临时环境里编写转换插件。

插件声明输入输出与权限，测试后获得与代码产物关联的报告。Task-local 激活将完整能力注册到同一目录。Leader 经已有 CLI 调用入口使用新工具并保存业务结果。

验证失败由 Leader 修改实现。所需权限不足则向 Operator／用户提出具体请求。不需要创建新的开发工作流，更不能在插件初始化时偷偷发送业务请求。

## 9. 更换运行中的实现

Operator 启用一个新的 Runtime 适配实现。宿主验证后将新 Session 的默认选择切过去。已有 Leader／Worker Session 继续持有旧实现和必要连接，正在进行的调用不会中途变函数。

任务需要使用新实现时，负责人可以在当前执行结束后重开 Session。旧实例无实际使用者后释放；Candidate 和历史报告照常读取，不要求加载旧 Runtime。

短工具则以单次调用为边界更新，不需要为一次格式转换保留整个 Session。

## 10. 故障、未知效果与上报

Worker 执行失败，结果带必要证据进入 Task；Leader选择等待、修复、再派发或亲自处理。Leader 承载失败，现有通知路径将事实交给 Operator。Operator 承载失败，由用户处理，不增加恢复 Agent。

如果一个外部动作可能已经发生，Yui 保存未知处置和原请求引用。Agent 可以查询外部状态或处理可确认的部分，但框架不为了“兜底”自动换一份实现执行同一动作。

正常长请求继续等待并显示等待事实，不因为短期无输出就自动重做。

## 11. 重启后的接手

Controller 重启后读取当前配置、待处理输入和未决操作，重建目录和读视图。可连接的原生 Session 可以继续观察；不可用的由负责人选择新 Session。

任务目标、角色、WorkItem、结果和决定依然存在。Context 给出紧凑工作集，允许按引用展开。不存在“必须恢复终端屏幕或完整插件内存才能读 Task”的前提。

这些过程的验证条件见[验收场景](../reference/acceptance-scenarios.md)。
