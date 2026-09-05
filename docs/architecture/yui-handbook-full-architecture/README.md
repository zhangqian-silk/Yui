# Yui 架构与实施手册

[直接查看完整架构分层图](full-architecture.html) · [打开完整阅读版](index.html)

**设计定位：面向高智能 Agent 的通用任务控制系统。**  
**文档日期：2026-09-06。**

Yui 保存工作事实，提供可靠的原子操作，并允许通过插件扩展能力。Operator 代表用户处理全局事务；每个 Task 的 Leader 对任务推进和交付负责。Agent Runtime、会话、连接和工具实现都可以更换，任务不依附于其中某一个运行实例。

本集合是一份目标设计规范，不表示所列接口已经在当前 Yui 版本发布。命令和类型用于约定职责及行为；实施时应根据当时源码确定具体名称、复用位置和存储布局。数据接口不要求一一对应数据库表。

## 架构总览

阅读时先看工作关系，再看逻辑层次。工作关系说明谁负责推进，逻辑分层说明能力由哪里承接，七模块说明实现职责。三者不是三套系统。

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

完整的 **Experience → Intelligence → Capability → Execution → Minimal Kernel** 分层图，以及贯穿各层的 Plugin Fabric、持久化读写图和模块映射，见[总体架构](architecture/01-overview.md)。箭头表示主要使用关系；直接 CLI 操作可以跳过模型判断，查询无需启动执行。

## 核心约定

- **决策归 Agent。** 框架不预设任务分解、评审顺序、重试次数或完成方式。
- **任务由 Leader 负责。** 用户可以直接和 Leader 对话，Operator 可以代表用户干预，但不另设日常任务调度大脑。
- **事实独立于运行时。** 目标、配置、工作分配、结果及必要回执持久化；进程句柄、连接、终端和可重建投影不成为任务真相。
- **能力可组合。** Task 不按 software、research 等领域分类。Project 提供知识和资源，插件提供具体能力。
- **扩展不等于扩权。** Agent 可以实现 Task-local 插件，但仍使用已经获得授权的执行环境和资源。
- **故障沿既有职责上交。** Worker／Reviewer 交 Leader；Leader 交 Operator；Operator 由用户处理。

## 阅读地图

可直接打开 [离线阅读页面](index.html)，在浏览器中连续阅读全部正文；Markdown 文件可分别编辑或交给 Task Leader。

| 阅读目标 | 文档入口 |
|---|---|
| 阅读工作关系、完整分层图与模块映射 | [总体架构](architecture/01-overview.md) |
| 理解用户、Operator、Leader 和 Draft | [职责与交互](architecture/02-authority-and-interaction.md) |
| 理解哪些信息保存、哪些可以丢弃 | [事实、配置与持久化](architecture/03-state-and-configuration.md) |
| 理解运行时组合及热重载 | [执行与实现替换](architecture/04-runtime-and-replacement.md) |
| 理解资源、插件和自扩展 | [能力与资源](architecture/05-capabilities-and-resources.md) |
| 按真实过程检查设计 | [端到端工作逻辑](architecture/06-working-flows.md) |
| 实现某一个模块 | [模块索引](modules/README.md) |
| 查阅字段及工具契约 | [接口说明](contracts/README.md) |
| 分配迁移工作 | [实施路线](implementation/README.md) |
| 执行验收 | [验收场景](reference/acceptance-scenarios.md) |

## 文档职责

`architecture/` 定义产品逻辑和系统责任；`modules/` 定义模块边界、输入输出、状态及实现原则；`contracts/` 提供最小类型与能力目录；`implementation/tasks/` 定义独立任务；`implementation/designs/` 给出每个任务的实施方案；`reference/` 汇总跨模块验收与术语。

这些文件相互引用，但不形成新的运行时对象。Task 文档是可交给 Leader 的实施输入，技术方案是该任务的实现约束与参考路径，不是强制工作流。

## 使用范围

默认部署是一位用户、一个 Home、一个 Controller 和当前受支持的存储。插件化以清晰接口和生命周期为基础，不要求微服务化。受信任模块可同进程运行；需要隔离的可执行扩展使用明确授权的执行环境。

实施任务完成后，Yui 应保持完整可用。必要时可以暂时保留两份实现，由同一个入口选择；它们共同使用唯一的持久化事实，不启动两个 Controller 并行管理同一个 Home。

## 文档检查

在解压目录运行 `python tools/check_docs.py` 可检查文件引用、任务依赖、验收索引和内容清单。有 TypeScript 编译器时，可额外按[接口说明](contracts/README.md)执行类型检查。这些检查只验证文档和契约结构；真实 Agent、资源权限、热重载和数据迁移必须按实施验收实际验证。

## 阅读版与源文件

`index.html` 是全部 Markdown 的静态阅读版，带工作关系、逻辑分层、模块映射、事实流和热重载边界的直达入口。Markdown 和契约文件是独立维护的源文件。

修改正文后，运行 `python tools/build_html.py` 重新生成阅读版；构建脚本使用本机 Pandoc 和 Python 的 Beautiful Soup。随后运行 `python tools/check_docs.py --write-manifest --typecheck --write-result` 更新清单并检查文档与类型。HTML 中的架构图仍是可选择、可复制的文本，不依赖在线图片、字体或脚本。
