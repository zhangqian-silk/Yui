# 总体架构

**图形入口：** [完整架构分层图](../full-architecture.html)。该页面直接显示四个逻辑层、最小内核与横向插件机制。

## 1. 设计定位与阅读方法

Yui 是面向高智能 Agent 的通用任务控制系统。Operator 代表用户处理全局操作和 Task 划分；每个 Task 的 Leader 对规划、执行与交付负责。系统保存必要事实、提供原子操作，并允许用插件补充和替换具体能力。

架构从三个互补视角表达：**工作关系图**说明谁围绕什么工作；**逻辑分层图**说明哪些职责承接决策和执行；**模块映射表**说明代码与记录由谁负责。分层展示不要求增加相同数量的服务、进程或插件包。

## 2. 工作关系图：围绕 Task 形成闭环

```text
                              User
                         /              \
                    Operator            Leader
                 全局操作与任务划分     一个 Task 的完整负责人
                       |                   |
                       |             Worker / Reviewer
                       |                   |
                       +------ Task -------+
                         当前目标、配置与工作事实
                                   |
                               Yui Tools
                       同一套查询与原子操作入口
                                   |
          +------------------------+-----------------------+
          |                        |                       |
       Context                  Execution              Capability
    组织当前事实                 承载明确请求             发现与调用能力
          |                        |                       |
     Persistence                Runtime                 Plugins
   保存工作与必要证据       AgentEndpoint / Resources    提供具体实现
          \                        |                       /
           +-------------------- Kernel -----------------+
                    存储、身份、权限、操作事实与实例宿主
```

图中的 Task 是工作事实中心，不是一个运行进程，也不是 Operator 的全部作用域。Operator 还可以直接修改全局配置、管理项目和插件；它创建多个 Task 后，每个 Task 都有自己的 Leader 和同样的闭环。

用户既可与 Operator 对话，也可直接与一个 Task 的 Leader 对话。Leader 可以自己执行，或通过 WorkItem 委派 Worker、请求 Reviewer。Draft 阶段即可建立逻辑 Leader，首次进入时再按需启动 Session。

图中 Context、Execution 和 Capability 是三条主要职责路径，**不是三个互不通信的子系统**：Context 可附带可用能力和运行观察；Execution 使用插件实现；查询与执行都受相同权限边界约束。Project、Resource、Role 等完整能力在分层图中展开。

最下方的 Kernel 支持全部路径。Persistence 表示其中的存储职责，不代表另一套内核或独立数据库平台。

## 3. 逻辑分层图：四个 Plane、一个内核、横向插件机制

```text
                                       User
                                          │
                                          ▼
┌────────────────────────────────────────────────────────────────────────────────────┐
│  Experience Plane · 交互层                                                         │
│                                                                                    │
│  CLI / Web / API / 原生会话入口                                                    │
│  TUI / IM 等按需接入；命令、面板和展示可以由插件贡献                               │
│  职责：采集输入、展示事实、确认操作、调用能力                                      │
└────────────────────────────────────────────────────────────────────────────────────┘
                                          │
                                          ▼
┌────────────────────────────────────────────────────────────────────────────────────┐
│  Intelligence Plane · 决策层                                                       │
│                                                                                    │
│  Operator                         Task Leader                                      │
│  用户代理 / 全局操作 / Task 划分    单 Task 规划 / 委派 / 判断 / 完成              │
│                                   Worker / Reviewer                                │
│  Role / Skill 提供行为与配置；多路执行是策略，不是新角色                           │
│  职责：决定做什么、怎样做、下一步做什么                                            │
└────────────────────────────────────────────────────────────────────────────────────┘
                                          │
                                          ▼
┌────────────────────────────────────────────────────────────────────────────────────┐
│  Capability Plane · 原子能力层                                                     │
│                                                                                    │
│  任务与交付：Task / Brief / WorkItem / Decision / Candidate / Review               │
│  上下文沟通：Context / Message / InputRequest / Project Knowledge                  │
│  配置与管理：Role / Agent 配置 / Project / Plugin                                  │
│  执行与资源：dispatch / inspect / stop / 资源操作 / Artifact                       │
│  统一入口：Yui Tools → 公开操作；扩展能力经 Capability Registry 解析               │
│  职责：返回事实、执行声明的原子意图，不制定工作流                                  │
└────────────────────────────────────────────────────────────────────────────────────┘
                                          │
                                          ▼
┌────────────────────────────────────────────────────────────────────────────────────┐
│  Execution Plane · 执行层                                                          │
│                                                                                    │
│  请求承载：并发准入 / Mailbox 投递 / 结果采集 / 观察与 Wake                        │
│  Agent 执行入口：AgentEndpoint                                                     │
│    产品适配  Codex / Claude Code / 其他 Agent CLI                                  │
│    协议适配  App Server / stream-json / ACP / terminal                             │
│    通信载体  stdio / WebSocket / PTY / 已有代理连接                                │
│  资源与环境：具体资源插件 / 环境准备 / 工具执行 / 产物保存                         │
│  职责：让已经请求的动作发生，报告实际结果和必要证据                                │
└────────────────────────────────────────────────────────────────────────────────────┘
                                          │
                                          ▼
╔════════════════════════════════════════════════════════════════════════════════════╗
║  Minimal Kernel · 最小内核                                                         ║
║                                                                                    ║
║  Identity / Authority / Ownership                                                  ║
║  Durable Store / Transactions / 受控迁移                                           ║
║  必要的 Operation / Command 记录与 Receipts                                        ║
║  唯一实例宿主 / 生命周期 / 实现句柄                                                ║
║  职责：保护事实与操作边界，不理解业务目标                                          ║
╚════════════════════════════════════════════════════════════════════════════════════╝

┌────────────────────────────────────────────────────────────────────────────────────┐
│  Plugin Fabric · 横向插件机制（覆盖各层，不是调用链的下一层）                      │
│                                                                                    │
│  能力与贡献注册 / 必要依赖 / Global · Project · Task 配置作用域                    │
│  Effect 清理 / generation / 按调用或 Session 替换 / drain                          │
│  Role 模板与 Skills 优先是数据；Bundle 只是可选的配置组合                          │
│  插件提供能力，Kernel 执行权限；不增加另一套工作流或事实来源                       │
└────────────────────────────────────────────────────────────────────────────────────┘
```

向下箭头表示上层使用下层能力的主要关系，不是每次请求都必须经过的同步流水线。结果、回执和通知向上反馈；具体数据读取路径见第 6 节。

图中列出的是目标架构可容纳的入口和实现。TUI、IM、其他 CLI、特定协议组合是否提供，以实际启用和验证的能力为准，不由架构图承诺全部已经实现。

## 4. 各层的职责与边界

### 4.1 Experience Plane：统一交互，不拥有任务策略

CLI、Web、API 和原生会话入口负责输入、展示、必要确认和操作调用。用户可以通过它们与 Agent 对话，也可以直接执行确定的管理命令。

自然语言请求交给 Operator 或 Leader。确定的 CLI／API 操作直接进入 Capability Plane，**不必先调用模型**。已有原生 Leader 会话也可直接使用，不要求全部消息穿过 Web 聊天界面。

Surface 的展示消费查询结果。重新连接和页面刷新不重新执行业务动作，面板卸载不删除工作事实。

### 4.2 Intelligence Plane：唯一制定工作方法的层

Operator 负责全局意图、Task 边界、配置和跨 Task 协调。Leader 负责单 Task 的目标理解、WorkItem 拆分、执行选择、Review、恢复和完成。Worker／Reviewer 承担其局部责任。

Role、模板和 Skill 提供可保存的职责配置及行为指导，不是权限来源。Lane／replicas 是同一 Assignment 的多路执行方式，不与 Leader、Worker、Reviewer 并列为新角色；是否使用、如何综合结果由 Leader 决定。

决策层是职责视角。实际模型计算发生在执行层承载的 Agent Runtime 中，**不意味着在 Controller 中再实现一个智能决策引擎**。

### 4.3 Capability Plane：稳定事实与原子操作入口

这一层回答“现在有什么事实、我能做哪些操作”。Task／WorkItem／Review 是对工作对象的操作，Context 是查询视图，Role 是配置操作，dispatch／inspect／stop 是执行管理入口，资源动作和插件管理同样从这里使用。

Yui Tools 是这些公开入口的总称。CLI 命令、类型明确的内建调用和 describe／call 桥可以使用同一套操作；不要求所有内部调用都经过字符串 RPC。Capability Registry 用于发现和选择扩展实现，不是另一个 Task Store。

查询直接读取事实；本地修改通过所属模块的事务；需要运行 Agent 或调用资源的动作进入 Execution Plane。系统检查权限、对象关联和必要副作用边界，尽量不把业务方法固定为调用前提。

### 4.4 Execution Plane：执行已声明的请求

这一层承载已经被用户或 Agent 请求的工作。准入只检查当前角色是否忙碌、资源和实现是否可用；Mailbox 投递已保存输入；采集路径保存结果和必要回执；Wake 提醒读取新事实。

Execution 通过 AgentEndpoint 使用不同 Agent。产品、协议和传输是内部接口分工，只组合实际支持的路径。资源工具负责自己的外部动作与实际环境，不要求所有 Task 都使用 Git 或工作目录。

执行层不选择下一 WorkItem，不因失败次数自动换模型，不解析 Review 后建立修复拓扑，也不从原生 Turn 结束推断 Task 完成。

### 4.5 Minimal Kernel：共同事实与执行基础

Kernel 提供稳定身份、授权上下文、事务与必要操作记录，以及唯一的实现实例宿主。工作记录的语义仍由 Task、Agent、Execution、Resource 等所属模块解释，Kernel 不把所有业务对象变成自己的逻辑。

纯读通常没有 Command；本地事务直接修改所属记录；具有外部效果的操作保留必要请求身份和回执。这样既不漏掉未决副作用，也不为每个读取动作建立多层日志。

### 4.6 Plugin Fabric：贯穿各层的实现机制

插件可以贡献展示、原子能力、具体 Agent／资源实现和只读上下文材料；Role 模板与 Skill 优先作为数据。每项动态注册归属于一个实例，停用时按实际使用边界撤销。

Global／Project／Task 表示配置范围和可见性，不构成三套运行时，也不增加资源权限。宿主只维护一份实例关系和生命周期；目录从当前启用配置与注册贡献生成。

本机制不要求复杂依赖求解、服务网格、统一 Workflow DSL 或前端插件操作系统。一个能力能直接用普通模块实现时，不为了满足图形结构额外拆包。

## 5. 逻辑层与七个代码模块的映射

| 代码模块 | 主要所在层 | 拥有的职责与记录 | 不负责的事情 |
|---|---|---|---|
| Kernel | Minimal Kernel；支撑 Plugin Fabric | 事务、身份、授权、必要操作事实、唯一实例宿主 | Task 方案、业务恢复、结果质量 |
| Task | Capability Plane | Task、Brief、Decision、WorkItem、Candidate、Review 关联、验收 | 运行模型、安排工作顺序 |
| Agent & Context | Intelligence 的配置支持；Capability 的角色与读取入口 | Role 当前配置、消息、问题、Context 读视图 | 另设调度大脑、持有第二份任务状态 |
| Execution & Runtime | Execution Plane；在 Capability 层暴露控制操作 | 执行请求、Turn、Session 必要引用、Endpoint 和结果采集 | 决定重试策略或 Task 完成 |
| Project & Resource | Capability 与 Execution Plane | 项目知识、资源引用、环境归属、产物保存、具体动作 | Task 领域分类、通用资源工作流 |
| Plugin & Capability | Capability Plane 与 Plugin Fabric | 包与启用配置、能力契约、目录、发现与注册 | 第二套宿主、任意扩权 |
| Surface | Experience Plane | CLI／Web 输入、展示、查询和操作映射 | 私有业务状态、独立恢复策略 |

一个模块可以跨层承担公开入口与内部实现；同一层也可以包含多个模块。**层是职责视角，模块是代码和记录归属，插件是可组合或替换的实现单元。**

## 6. 事实流与执行反馈

```text
                         Agent / 用户
                        /            \
                  查询 / 读           原子操作
                      /                \
             Context / Query         公开能力入口
                   ▲                  /        \
                   |          本地事实修改      执行 / 资源操作
                   |                |               |
                   |                |         Runtime / Plugin
                   |                |               |
                   |                |         结果 / 必要回执
                   |                ▼               ▼
             +-----+------------------------------------+
             |       持久化工作事实 · 唯一事实来源        |
             | Task / Role / Message / Turn / Artifact  |
             +---------------------+--------------------+
                                   |
                            变化通知 / Wake
                                   |
                             Agent 再读 Context

实时观察 ──→ Context / Surface 附带展示（来源、时间、不可用说明）
连接、进程句柄、缓存 ──→ 临时运行状态，可丢弃或重建
```

Task、Role、Message、Turn 和 Artifact 等各有明确写入入口，共用同一持久化基础。Context 只组合读取，Surface 的展示只消费这些读结果，不反向生成新的业务状态。

“只读 Context”不代表 Agent 或 Web 永远不能写。写入经显式原子操作发生，而不是通过修改视图完成。Context 中附带的运行观察也不意味着 Context 成为监控或恢复决策者。

持久化负责保存目标、配置、分配、结果和未决输入／效果。连接、进程对象、实时观察缓存和目录投影可以重建。运行对象丢失不导致已保存结果失效，读取结果也不要求启动生成它的旧插件。

## 7. 哪些实现可以替换

| 对象 | 配置或代码何时可更新 | 实际使用的生效边界 |
|---|---|---|
| 展示、无状态查询贡献 | 可动态注册和替换 | 新读取使用新实现，工作事实不变 |
| Capability 目录 | 注册成功后新查询可见 | 既有调用已选择的实现不变 |
| Role 配置、模板、Skills | 可保存新定义 | 后续应用、兼容执行或新 Session；不改写历史输出 |
| 独立工具实现 | 可在运行中准备新实例 | 当前调用保留原实现，新独立调用选择新实现 |
| Endpoint、协议及必要有状态依赖 | 可准备新实例 | 原 Session 默认沿用原实现，新 Session 使用新实现 |
| Kernel／存储和核心授权契约 | 按受控更新处理 | 不作为任意可热拔能力 |

热重载更新的是实现，不是任务含义。generation 只标识调用或会话实际使用的实现，历史 Candidate 保存内容与来源即可，不决定旧代码的保留时间。更新进度、模板或插件不自动决定结果是否仍适用。

## 8. 实现依赖与装配

Kernel 不依赖具体 Agent、领域资源或 Task 工作方法。Task 模块依赖存储和授权端口；Context 读取公开查询接口；Execution 保存自己的 Turn 证据并经公开能力关联任务；Runtime 与资源插件不直接写 Task 私有表。

一个装配入口知道内建实现并将其注册到宿主。其他模块依赖公开接口，允许普通的类型明确调用，不要求网络化。Agent 调用 Yui Tools 形成工作闭环，但不意味着源代码的 import 依赖必须形成环。

架构无需增加 DomainBinding、固定任务领域枚举、多级角色插件作用域或额外恢复主管。实例与记录数量按实际工作需要产生，不按图中的方框数量产生。

## 9. 工作推进与故障责任

```text
用户意图 → Operator → 一个或多个 Task
Task → Leader → 原子操作与工作委派
执行／资源动作 → 结果与回执 → 持久化
持久化事实 → Context → Agent 下一次判断
能力不足 → 复用／实现插件 → 继续原 Task
```

Worker／Reviewer 的问题交 Leader；Leader 的问题交 Operator；Operator 的问题由用户自行处理。使用已有消息和普通操作入口，不建设额外救援平台。

## 10. 阅读关系

[职责与交互](02-authority-and-interaction.md)解释决策层；[事实、配置与持久化](03-state-and-configuration.md)解释读写和状态；[执行与实现替换](04-runtime-and-replacement.md)解释 Execution；[能力与资源](05-capabilities-and-resources.md)解释 Plugin Fabric 和资源；[模块索引](../modules/README.md)将分层落到代码职责。
