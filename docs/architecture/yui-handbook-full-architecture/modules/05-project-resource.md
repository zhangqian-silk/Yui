# Project 与 Resource：背景、环境和工作成果

**层次位置：Capability Plane 与 Execution Plane。** 项目知识、资源查询和产物读取是公开能力；环境准备与具体资源动作属于执行实现。必要归属和结果经 Kernel 保存，不增加 Task 领域类型。

分层位置与完整工作关系见[总体架构](../architecture/01-overview.md)。

## 1. Project 的最小职责

Project 保存持续工作的背景，而不是再建立一个任务平台。内容为稳定 ID、名称与说明、知识、资源引用及默认能力配置。一个 Task 可以引用零个、一个或多个 Project。

Project Knowledge 保存跨 Task 有用的信息。Task 内临时判断放在 Brief 或 Decision；是否值得沉淀由 Leader／Operator 选择，不自动把所有聊天写入长期知识。

Core 不定义 software、research、document 的 Task 分类。Git、浏览器、资料处理等能力可以同时用于一个 Task；Bundle 只帮助安装和配置。

## 2. Resource identity

Resource 的通用记录保存 ID、类型、展示名称和非敏感定位元数据。具体插件负责它的真实地址与版本语义。例如本地目录、仓库、文档或数据库连接各有不同要求。

不同别名可能指向同一实际对象。需要并行写保护的具体插件应规范化身份，不能只比较用户填写的字符串。无需为完全不同的资源设计一套万能锁语言。

资源默认动作来自对应能力，如 diff、查询或发布。是否读取、写入或产生外部副作用在能力描述中声明，但 Core 不要求所有资源都实现统一 CRUD。

## 3. 资源授权

Project 引用不等于 Resource grant。Role 说明或插件 manifest 也不提供实际访问权。执行入口根据调用者和目标解析已授权的资源。

凭据通过引用和运行环境传入，不写进 Brief、Candidate、日志或配置快照。插件配置需要地址等参数时，限制仍由实际环境执行，而不是认为一个 permissions 字符串已经隔离网络。

用户选择 trusted-local 时，可以使用现有本地环境，但界面应明确其访问假设。需要更强隔离的自动代码使用已经验证的环境；框架不为缺少某种环境自动创造权限。

## 4. Environment 准备与采用

Environment 描述实际执行的 cwd、文件、挂载、网络、凭据引用和隔离方式。它可以复用一个授权本地目录，也可以由插件创建临时 worktree 或沙箱。

需要创建资源时先 prepare，返回临时引用和准备结果，再由调用方采用到 Task／Turn。采用前重新确认相关目标、授权及资源配置仍适用。没有采用的临时资源可以清理。

准备成功但启动 Agent 失败，不说明环境不存在；采用成功的事实继续保留，Leader 决定重试启动或换方法。不能靠回滚 Task lifecycle 隐藏已实际创建的外部环境。

无环境需求时采用空计划合法，不要求每个 Task 都有目录。

## 5. Draft 与正式环境

规划可使用只读资源或临时 scratch。需要跑实验时由实际授权环境决定能做什么。规划所得文件可保存为 Artifact 并用于说明，不自动视为 delivery 工作区。

激活后，Leader 可以显式复用已保存材料或复制实验结果，不要求机械地重做同一探索。正式结果需有明确来源，而不是整个临时目录未经确认直接成为最终交付。

## 6. Artifact 与内容保存

```text
Artifact
  id / displayName / mediaType?
  locator or contentRef
  optional digest / externalVersion / receiptRef
  provenance
```

可变外部链接标为参考资料，并附观察时间。需要对一版结果评审时，固定内容摘要、外部不可变版本或独立副本；完成动作则引用可核验回执。

Artifact 不是执行环境。历史报告可独立于生成它的进程和插件读取。删除临时目录之前，确保其结果已保存到稳定位置，或明确标记后续不可读，不能继续声称 Candidate 内容完整。

## 7. 具体软件能力

Git repository、worktree、ChangeSet、checks 和 integration 可以由资源插件实现。现有成熟机制无需抽象成新的领域状态机，只通过明确接口和结果引用供 Leader 调用。

检查失败、冲突或目标变化返回具体文件／版本和已有输出。Leader 决定修复、重新生成结果或改方案。Git 动作保护自己的实际写入条件，不将一次冲突自动升级成整个 Task 永久失败。

非软件 Task 使用同一 Task／Candidate 模型，成果可能是报告、数据文件或动作回执。它无需加载 Git 插件才能结束。

## 8. 占用、取消与清理

Role 配置改变和 Turn terminal 不是所有资源已停止写入的证明。只有进行冲突操作时才需要相关停止或隔离证据。可以直接使用独立资源绕开等待，不必全 Task 停住。

清理按资源所有权和引用执行。用户拥有的目录不因为 Task 结束被自动删除；共享原生服务不被当作某个 Turn 的子进程杀掉。具体插件知道哪些句柄和文件是它实际创建的。

## 9. 能力不可用时的数据读取

资源插件离线时，已保存的描述、报告和回执仍然可以读取。需要实时查询或再次写入时才返回 capability unavailable。Context 不因缺少 Git 或浏览器插件而拒绝显示 Task 的目标与结果。

## 10. 验收要点

无 Git Task、空环境、固定产物、参考链接标注、授权检查、显式实验材料采用、实际资源清理与历史结果独立读取。对应场景为 S04、S13、S23、S26、S27、S28、S29、S37。
