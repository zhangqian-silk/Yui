# T08 技术方案｜Draft Leader 与正式执行

硬依赖：T03、T04、T05。

任务定义：[交付范围与证据](../tasks/T08-draft-leader.md)。

## 1. Task 与 Session 解耦

Task 创建时建立逻辑 Leader 和 Brief，不强制启动进程。用户进入 Draft 或 Operator 明确请求讨论时，按当前 Role 配置创建／恢复 planning Session。

会话持久化仅保存必要关联和有效配置。Task 可在没有会话时被读取和编辑，Leader 从 Context 恢复规划，不依赖终端仍存在。

## 2. Planning 行为

向 Leader 提供 Draft 可用的 Task 原子工具、项目知识、角色配置和必要研究能力。编写重要要求或决定由 Leader 完成，不通过隐藏模型提取全部聊天。

规划可使用授权只读资源或 scratch 环境。已有本地权限很宽时如实描述信任范围；不能只靠 purpose=planning 就声称 OS 写入被禁止。

成果可以保存为规划 Artifact。Activation 不自动采用整个 scratch 目录；Leader 可以显式引用材料或把所选内容用于正式结果。

## 3. 激活请求

请求包含 Task、稳定 requestId、期望开始方式和必要资源配置。Activation 记录只说明当时采用的任务说明和环境，不建立后续所有结果的版本一致性门禁。

若 planning Turn 已结束且资源可准备，可以立即采用；若请求来自仍在运行的 planning Turn，则在现有操作记录中保存 afterPlanningTurn，并立即返回请求引用。不要让同步工具等自己所属 Turn 结束。

用户在等待中取消请求或取消 Task，采用时重新检查明确状态，不继续执行历史意图。相关授权或资源配置变化时重新读取，只有影响实际采用的变化才需要重新准备，不因普通进度备注要求重新规划整个任务。

## 4. 资源采用

调用 T05 prepare 得到临时环境，可以为空。准备完成后在受控事务里采用环境引用并将 Task 置 active。失败时 Task 保持可继续 Draft，释放能够确认未采用的临时资源。

采用成功后 Agent 启动失败，保存 active 与环境事实，通知负责人决定再启动或换配置，不回滚成虚假的“什么都没有发生”。

## 5. 会话延续

当前 native Session 支持所需 cwd、权限和配置变化且已确认安全边界时可继续。否则创建新 Session，发送当前持久化 Context 和明确 delivery 指引。

不要求所有协议具备透明 handover，也不为保留聊天而在当前 Turn 中热升权。逻辑 Leader 不变，用户仍在同一个 Task 对话目标下工作。

## 6. Surface 配合

Draft 页面始终提供 Leader 入口并显示 planning；激活后显示正式执行及实际环境。此展示不维护独立 lifecycle。使用 T06 现有 target 路由，不另建 Planner 页面和 Planner Role。

Operator 可以创建多个 Draft 后让用户分别进入各 Leader，也可以对明确任务直接创建并激活。规划不是所有任务必须经历很长的一段流程。

## 7. 验收

S01／S02：用户在 Draft 对齐并持久化，关闭会话后再次进入能继续。S27：无资源准备的任务可激活。S40：当前 Turn 发起延后请求即时返回，结束后采用；取消或改变实际资源条件能够被正确识别。

还需分别验证可续用与不兼容需新建两条 Session 路径，结果不自动成为 Candidate。真实协议未验证兼容时默认新会话，不把文字声明当作证据。
