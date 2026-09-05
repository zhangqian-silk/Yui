# 术语

| 术语 | 在 Yui 中的含义 |
|---|---|
| Plane／逻辑层 | 用来说明职责位置，不是必须部署的服务，也不等于代码模块 |
| Intelligence Plane | Agent 的决策职责；实际模型计算由 Execution Plane 承载 |
| Capability Plane | 查询与原子操作的公共面；不要求每项能力有独立 Service |
| Plugin Fabric | 各层共用的贡献注册与生命周期机制，不是请求的额外必经层 |
| Yui Tools | Agent 和确定性用户操作使用的同一套公开查询与原子能力 |
| Task | 用户希望完成的一个目标，以及围绕它持续保存的工作事实 |
| Operator | 代表用户进行全局操作的 Agent，不是所有 Task 的固定日常调度者 |
| Leader | 单个 Task 的完整负责人，可以更换实际 Agent 和会话 |
| Role | 稳定职责与当前配置；不等同于一个进程或一个插件 |
| AgentDefinition | 一个可配置的 Agent 选择，包括连接预设及非敏感配置 |
| Profile | 可复用角色模板，应用后形成 Role 当前配置 |
| Skill | 给 Agent 的行为指导和知识入口，不是权限或安全边界 |
| Brief | 当前任务认知；普通编辑无需变成正式 Decision |
| Decision | 值得保留重要选择及其原因的记录 |
| WorkItem | 可以独立负责和验收的一项责任，不是内部操作步骤 |
| Assignment | 一次实际委派的输入快照，可保存在 Turn 中 |
| Turn | 一次 Agent 执行的输入、实际配置、结果及必要身份 |
| Session | 可跨多个 Turn 使用的原生会话与有效配置 |
| Host | Yui 持有会话连接、进程附件和实现句柄的临时对象 |
| Candidate | 明确提交给负责人判断的一版结果，不决定未来要求 |
| Review | 对 Candidate 的 Reviewer Turn 引用；结果原文不重复保存 |
| Context | 由已有事实组成的工作读视图，不拥有第二份任务状态 |
| Message | 持久化沟通内容及其来源、目标和引用 |
| Wake | 提醒读取新事实的通知，不承担业务事实 |
| Command／Operation | 重要副作用的请求与处置记录，不是工作流引擎 |
| Capability | Agent 或用户可以调用的一项具名能力 |
| Provider | 某个能力的具体实现 |
| Plugin | 可注册能力或贡献、具有明确生命周期的实现包 |
| Scope | Global、Project、Task 级可见范围和配置归属，不是资源授权 |
| generation | 某个实现实例的身份，回答调用／会话实际用了什么 |
| Resource | 由具体能力操作的资源，其类型不由 Task 领域分类决定 |
| Environment | 一次执行实际得到的目录、网络、凭据及限制 |
| Artifact | 可以独立引用的结果内容、外部版本或动作回执 |
| Endpoint | Execution 使用的统一 Agent 操作接口 |
| Protocol | 某种 Agent 控制语义的实现，如会话、输入、终态 |
| Transport | 承载通信的流或消息通道 |
| drain | 停止新的独立使用并等待现有使用释放，不等同于取消业务动作 |
| revision | 防止并发覆盖的记录版本，不是结果过期判定 |

## 固定与开放

固定的是身份、责任、当前事实的写入边界和必要操作证据。开放的是工作方法、具体工具、资源类型、运行协议以及结果内容。

文档中的类型名称用于共享理解，实施可以复用当前数据结构或存储，只要保持相同的可观察语义。
