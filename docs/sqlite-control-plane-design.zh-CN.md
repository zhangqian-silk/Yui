<p align="right"><a href="./sqlite-control-plane-design.md">English</a> | <strong>简体中文</strong></p>

# SQLite 控制面存储

Yui 只有一个权威产品 Store：WAL 模式下的 `YUI_HOME/yui.db`。`schema_migrations`
中连续且带校验和的最高一行，就是当前发行版接受的那一个 Home 存储版本。

## 权威

- `yui.db` 拥有 Task、WorkItem、AgentRun、Message、Decision、结果、Project
  Knowledge 引用、受管工作区记录、运行时绑定、mailbox、持久事件和配置。
- Provider Session、transcript、进程、缓存、telemetry 和运行时观察服务于执行
  与诊断，不替代持久的 Task 事实。
- 数据库之外的配置和诊断不定义另一个存储版本，也不允许启发式地重建 Task 真相。

## 准入

普通命令只有在同时满足以下条件时才打开 Home：

1. `yui.db` 存在，且其迁移账本是一个有效的不可变前缀。
2. 账本头恰好等于运行中 CLI 的当前存储版本。
3. 当前记录校验与引用完整性均通过。

落在 CLI 支持区间内的更旧 Home 无法通过普通准入，但被归类为可升级。
`yui doctor` 和 `yui upgrade --dry-run` 会报告有序的升级路径而不改动 Home。
显式的 `yui upgrade` 是唯一的独立变更边界：它让 Controller 静止、备份
`yui.db`、以事务方式套用所有缺失迁移，并校验当前模型。更新的、低于最低版本的、
不完整的或损坏的 Home 一律 fail closed。不存在运行时归一化、修复 worker、
文件 Store 回退、双读写路径或第二套迁移权威。

## 写入与并发合同

- 每次修改是一个 SQLite 事务。
- WAL 加 `synchronous=FULL` 提供持久提交边界。
- `home_meta.revision` 是全 Home 范围的 CAS/revision，供需要冻结
  read/modify/write 边界的调用者使用。
- 类型化列支持按身份和状态建索引查询；完整且经校验的记录负载仍是持久的领域表示。
- mailbox 认领、精确的 AgentRun 终结、活动指针移除、结果持久化以及下游唤醒创建，
  在它们构成同一条产品事实时以事务方式耦合。
- 幂等键与唯一约束保护可重复的外部效果确认，不构成第二套工作流状态机。

## AgentRun 与 Session 边界

AgentRun 是一次明确请求的执行。它记录相关的可见输入和原始结果，而不是隐藏的
推理过程或完整工具轨迹。一个 Provider Session 可以包含多个 Run、普通原生对话
和通知。原生对话和通知不会自动创建 Run。只有精确关联的原生终态才结算该 Run；
WorkItem 与 Task 的验收权威仍归 Leader。

## 更新行为

`yui update` 暂存一个确切的包，并要求那个暂存二进制把 Home 判定为当前、可迁移
或受阻。随后它停止那个确切的 Controller、激活同一个包、在需要时运行暂存发行版
的完整迁移链、校验已安装二进制与当前 Home，再启动替换后的 Controller。

每次持久 schema 或负载变更都追加一条不可变、连续的存储迁移。CLI 同时发布
`storageVersion` 与 `minimumStorageVersion`；处在该闭区间内的每个有效 Home 都能
直接升级到当前版本，无需安装中间发行版。当前版本及最低支持版本统一由
`src/storage/storageVersions.ts` 声明，并由 CLI 身份读取暴露。
低于该下限的 Home 不是迁移输入，保持原样不动。目标二进制的
`upgrade --update-preflight` 与 `--update-apply` 结果形态，以及由父进程持有的
交接锁证明，对从存储版本 1 起发布的每个 updater 都保持向后兼容，因此一个旧的
源码 CLI 仍能驱动一个新得多的目标的完整迁移链。
