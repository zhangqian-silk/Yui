# T08｜Draft Leader 与正式执行

硬依赖：T03、T04、T05。

## 交付目标

让用户在激活前就能与 Leader 对齐，并在开始交付时明确采用正式配置和资源。

**完成状态：** Draft 对话与持久化可用，Activation 不以创建 Leader 为含义；同一逻辑 Leader 贯穿全程。

## 责任范围

- 按需创建 planning Session 和 Turn。
- 提供 Brief／Decision／WorkItem 编辑及临时材料保存。
- 实现安全资源采用、延后激活和兼容会话续用。

## 可独立分工的工作

1. 打通 Draft 对话和恢复。
2. 实现激活采用边界。
3. 验证空环境、当前 Turn 发起激活和配置不兼容。

这些分工供 Leader 判断，不要求按步骤建立 WorkItem。紧密耦合的实现应由同一责任单元完成。

## 不在范围内

- 不冻结后续方案、不强制重复探索。
- 不把 scratch 目录自动变成交付结果。

## 完成证据

- Draft 中与 Leader 对话并更新事实，重开后仍可读。
- 当前 planning Turn 发起激活不产生自等待。
- 不兼容 Session 可以读取 Context 接手。

验收场景：S01、S02、S27、S40。场景定义见[统一验收说明](../../reference/acceptance-scenarios.md)。

## 实施入口

[详细技术方案](../designs/T08-draft-leader.md)定义接口、改动位置的定位方法、存储影响、兼容路径和具体验证。共同执行约束见[实施路线](../README.md)。
