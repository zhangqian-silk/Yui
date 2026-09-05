# T04｜统一 AgentEndpoint 与运行时适配

硬依赖：T02。

## 交付目标

用同一执行接口承载现有 Codex 和 Claude 路径，产品、协议和载体在 Runtime 内部分工。

**完成状态：** 上层按 Role 发起和读取 Turn，不依赖具体 Provider 字段；现有原生能力不被统一接口抹平。

## 责任范围

- 定义 Endpoint、真实提交处置、Session 配置和事件关联。
- 接入 Codex native 与 Claude structured 路径，保持原有能力。
- 实现多路尝试关系、取消事实和必要资源活动观察。

## 可独立分工的工作

1. 完成共用 Endpoint 和测试实现。
2. 迁入 Codex／Claude 产品及协议逻辑。
3. 验证用户输入共存、迟到结果和同会话续用。

这些分工供 Leader 判断，不要求按步骤建立 WorkItem。紧密耦合的实现应由同一责任单元完成。

## 不在范围内

- 不要求三个内部职责分别发包；不把 PTY 当作自动 managed 降级。
- 不在本任务接入第三 Agent 或实现透明会话迁移。

## 完成证据

- 当前 Codex／Claude 主路径可通过 Endpoint 完成。
- pending、unknown、已接受和未提交按证据区分。
- 更换配置不改写已运行 Turn，不会重复未知输入。

验收场景：S09、S11、S12、S14、S17、S18、S19、S21、S22、S23、S24、S35、S39、S41、S43。场景定义见[统一验收说明](../../reference/acceptance-scenarios.md)。

## 实施入口

[详细技术方案](../designs/T04-agent-endpoint.md)定义接口、改动位置的定位方法、存储影响、兼容路径和具体验证。共同执行约束见[实施路线](../README.md)。
