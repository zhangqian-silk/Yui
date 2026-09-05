# 模块设计索引

## 1. 层与模块的关系

逻辑层解释责任，模块解释代码和记录所有权，插件解释实现怎样被组合和替换。一层可包含多个模块，一个模块也可同时提供公开能力和执行实现，不要求按层拆成进程。

| 逻辑位置 | 主要模块 | 职责 |
|---|---|---|
| Experience Plane | Surface | 输入、展示、对话路由、直接操作 |
| Intelligence Plane | Agent & Context 提供配置支持 | Operator／Leader／Worker／Reviewer 的决策职责；实际推理由 Runtime 承载 |
| Capability Plane | Task、Agent & Context、Plugin & Capability，以及执行／资源的公开入口 | 读取事实、修改记录、派发执行、使用资源、发现能力 |
| Execution Plane | Execution & Runtime、Project & Resource、具体插件 | 请求准入、消息投递、原生执行、资源动作、结果采集 |
| Minimal Kernel | Kernel | 存储、身份、权限、必要操作事实、唯一实例宿主 |
| 横向 Plugin Fabric | Plugin & Capability 使用 Kernel Host | 贡献注册、作用域、依赖、清理、实现替换 |

总图见[总体架构](../architecture/01-overview.md)。

## 2. 七个模块的记录与入口

七个模块共享一个事实基础和一套能力入口。写入权表示记录所有权，不表示绕过授权直接修改数据库。

| 模块 | 主要记录或资源 | 关键读取者 | 设计文件 |
|---|---|---|---|
| Kernel | 存储、授权上下文、操作记录、实例句柄 | 全部模块 | [Kernel](01-kernel.md) |
| Task | Brief、WorkItem、结果关联和验收 | Context、Execution、Surface | [Task](02-task.md) |
| Agent & Context | Role 配置、消息；Context 为读视图 | Agent、Surface | [Agent & Context](03-agent-context.md) |
| Execution & Runtime | Turn、Session 必要关联、执行证据 | Task、Context、Operator | [Execution & Runtime](04-execution-runtime.md) |
| Project & Resource | 项目知识、资源、环境、产物 | Task、Execution、Context | [Project & Resource](05-project-resource.md) |
| Plugin & Capability | 插件配置、契约、注册贡献；目录为读视图 | Agent、Surface、Execution | [Plugin & Capability](06-plugin-capability.md) |
| Surface | 用户连接、展示和输入 | 用户 | [Surface](07-surface.md) |

## 3. 共同实现约定

公开入口负责权限和对象关系校验。内部模块可以使用 typed port，不要求通过网络。装配入口选择实现；业务模块不直接引用其他模块的私有类。

Context、能力目录和页面状态各有不同数据来源，但都不是第二份任务权威。实际 Agent 执行、调用回执和必要配置由所属模块持久化；内存连接和可重建缓存可以丢弃。

一个接口类型不自动对应一张表，一个能力名不自动对应一个 Service，一个插件贡献不自动对应一个独立插件包。新增表、后台循环或服务必须由实际工作需要证明。

功能测试和跨模块验收分别进行。静态类型检查证明结构一致，不证明真实协议接受、外部效果、文件系统权限或运行隔离。
