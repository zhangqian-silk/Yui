# T03｜任务事实、角色配置与 Context

硬依赖：T02。

## 交付目标

使 Task、Role 和结果成为可独立于会话继续使用的工作基础，并为 Agent 提供一致、紧凑的 Context。

**完成状态：** Leader 可从持久化工作集接手，角色可切换配置，结果保持可读；Task 状态不承担隐含工作流。

## 责任范围

- 明确 Brief、WorkItem、Candidate、Review 与完成记录的职责。
- 保存 Role 当前选择与实际执行配置引用。
- 实现 Context read／delta／inspect 和可靠消息引用。

## 可独立分工的工作

1. 整理 Task 原子写与结果验收。
2. 实现 Role 配置及模板应用。
3. 实现 Context 与角色通知。

这些分工供 Leader 判断，不要求按步骤建立 WorkItem。紧密耦合的实现应由同一责任单元完成。

## 不在范围内

- 不引入 task.type、DomainBinding 或自动候选失效算法。
- 不实现隐藏对话总结 Agent；不删除仍有诊断价值的历史事实。

## 完成证据

- 进度更新与结果验收独立，要求变化由 Leader 明确判断。
- Context 核心 cursor 与数据来自同一读取视图。
- Worker／Reviewer 通知 Leader，Leader 通知 Operator；Operator 由用户处理。

验收场景：S03、S05、S06、S07、S08、S10、S15、S16、S18、S19、S20、S36、S41、S43、S46。场景定义见[统一验收说明](../../reference/acceptance-scenarios.md)。

## 实施入口

[详细技术方案](../designs/T03-task-context.md)定义接口、改动位置的定位方法、存储影响、兼容路径和具体验证。共同执行约束见[实施路线](../README.md)。
