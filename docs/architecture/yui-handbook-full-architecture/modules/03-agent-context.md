# Agent 与 Context：职责配置及工作视图

**层次位置：Intelligence Plane 的配置支持，以及 Capability Plane 的角色、沟通与读取入口。** Agent 实际推理由 Execution 承载；本模块保存 Role／Message 等必要事实，Context 本身只读并组织这些事实。

分层位置与完整工作关系见[总体架构](../architecture/01-overview.md)。

## 1. 模块组成

本模块包含 Role 配置、Agent 配置选择、Role／Skill 数据应用、Context 读取、对话目标和角色消息。它把持久化事实呈现给 Agent，不提供另一个 workflow planner。

Role 的行为指引说明应该怎样使用工具；工具入口的实际授权另由 Kernel 和应用模块执行。提示里的“你是 Operator”本身不授予权限。

## 2. Role、AgentDefinition 与模板

```text
Role
  stable id / kind / taskId?
  instructions / skillRefs
  current Agent selection / settings

AgentDefinition
  configured id / endpoint provider or preset
  non-secret launch settings / credential references

Profile
  reusable instructions / skillRefs / optional defaults
```

Operator 是全局 Role；Leader 属于一个 Task；Worker／Reviewer 是为该 Task 的局部责任配置的角色。Role 类型描述职责，不等于代码插件类型。

模板作为数据应用到 Role。应用后形成明确的当前配置。再次更新模板不静默改写已有 Role；用户或 Leader 可以重新应用。动态继承全局默认字段时，应显示继承来源，启动时解析成实际配置。

同一 Role 可以保留多份 Agent 绑定配置，只有一个明确当前选择。更换选择不删除其他配置，便于之后再用。数据存储可以复用现有 bindings，不要求建立新的配置服务。

## 3. 配置生效规则

Role edit 返回保存后的当前配置。正在执行的 Turn 保留实际配置；下一次派发解析新配置。若现有 Session 的 Agent、环境或安全相关设置不兼容，则由负责人决定停止或创建新 Session，不热改进程。

不影响执行控制的展示字段可即时更新。指令和 Skills 的生效也以实际 Runtime 能力为准，不能因为数据库已改就声称运行中的模型已经读到。

更换 Worker Agent 不改变 WorkItem 身份。Leader 承载更换也不重建 Task；原分配的 Worker 结果按原 Turn 保存后交给当前 Leader。

## 4. Context 的返回内容

```text
core
  Task / Brief / active Decisions
  open WorkItems / recent results
  pending Messages / InputRequests
  Role current configuration / selected history references
  cursor / omitted pointers

observations
  source / observedAt / value or reference / coverage
```

core 来自一次受权一致读，cursor 只覆盖这部分记录。observations 可以包含 Endpoint 状态、可见能力和资源探测，明确独立来源与时间。

默认 Context 是紧凑 working set，不是数据库导出。重大未决输入和未知外部操作至少保留计数或引用，不应被普通长度裁剪完全隐藏。长报告和详细工具输出通过 inspect 展开。

## 5. read、delta、inspect

`read` 返回当前工作集及其游标。`delta` 返回固定区间内的变化，分页时保持上界；变化过多可以明确要求重新获取快照。`inspect` 读取某个确切记录或产物，不扫描所有 Task 猜测局部 ID。

读取不更改任务进度，不自动 ack 消息，不运行隐藏 LLM，也不生成 recommendedNextAction。Context provider 贡献只读信息，受限于当前访问范围，失败时显示 unavailable 而不拖垮核心读。

## 6. 对话入口

Surface 使用两个主要目标：全局 Operator 或某 Task 的 Leader。Task 处于 Draft 也有此入口，首次访问时再创建所需 Session。

用户也可以在原生 Agent UI 里继续同一会话。能观察输入时保留可见来源；不能观察时不伪造完整历史。Role Skill 要求 Leader 将影响未来工作的必要信息写入 Yui。

用户直接对 Leader 说“帮我修改全局配置”不会让该 Session 自动获得 Operator 身份。Leader 可以通知 Operator，或提示用户使用全局入口。权限扩大必须来自实际授权，不来自对话文本。

## 7. Message 与 InputRequest

普通消息保留 from、to、task、body／reference 和 createdAt。用户问题可附回答状态和回答引用，以便重启后知道仍在等什么。不存在额外的 Message-driven 工作流。

投递可以批量包含事件和消息引用。记录稳定 attempt 与被接受 Turn 的关系。忙碌时保留待投递输入，重复 Wake 合并；未知投递先保留证据，不因 Role 换绑自动再发。

消息接受只说明输入到达，不证明 Agent 已经实施。对于重要要求，落实证据是后续持久化和工作结果。Context 读取是独立行为。

## 8. 责任上报

本地工具错误返回当前调用者。Worker／Reviewer 的执行失败和主动求助通知 Leader；Leader 承载不可用或主动求助通知 Operator。使用已有 Event／Message，不建立额外故障队列。

同一事实重复观察不产生无限消息。通知携带原记录引用而不是复制全部日志。Operator busy 或不可用时消息保留；系统不创建备用 Operator 或自动恢复 Task。用户处理 Operator 的运行问题。

运行观察只描述证据。没有足够进度不自动定义成“Leader失败”；可以向界面呈现，让用户或 Operator 检查，不派隐藏监督 Agent。

## 9. 配置、上下文与热更新

Role／Skill 当前数据可改变，但实际执行使用的快照保留。新工具通过稳定能力桥在当前 Session 后续调用中发现，不需要 Context 模块强制重启会话。

Context 无权固定插件代码生命周期。读取一个历史来源时只展示元数据和结果引用；只有实际准备再次执行时才请求可运行 Provider。

## 10. 验收要点

测试角色配置切换、模板不静默改 Role、Context 一致 cursor、消息读写分离、用户直聊持久化、故障责任到 Operator 为止。对应场景为 S03、S14、S15、S16、S17、S18、S19、S20、S36。
