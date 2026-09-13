<p align="right"><a href="./project-refresh.md">English</a> | <strong>简体中文</strong></p>

# Project refresh

`yui project refresh <project>` 按 Project 配置的 remote 和 stable branch 刷新
规范 checkout。stable 与 development branch 必须一致。操作全程持有 per-Project
maintenance fence；不会刷新 Task 工作区或改写其记录的基线。

## 两个独立事实

checkout HEAD 与本地 remote-tracking ref 是不同的观察。refresh 将精确分支获取到
唯一临时 ref，比较获取到的提交与远端 advertised commit，仅允许从原 HEAD 在干净的
稳定分支上 fast-forward。配置为 `HEAD` 时解析远端 symbolic HEAD，不猜默认分支。

当且仅当一个既有 Git remote 及其 fetch 映射管理安全的 tracking 目标时，refresh
同时将该目标更新到已验证的提交。HEAD 已最新也执行这一检查，修复会让普通 Git
错误显示 `ahead` 的陈旧 tracking ref。

映射使用 Git 生效的 fetch URL（包括 `insteadOf` 解析），支持完整 ref 名称的
精确或单星号 fetch refspec，并处理负向排除。不假定 `origin` 或
`refs/remotes/<remote>/<branch>`。已配置的 `refs/remotes/` 目标缺失时可以创建。
多个匹配 remote/URL、多个目标、其他来源也管理同一目标、不支持的 refspec、
本地分支/标签目标和符号引用目标，均明确标为未管理。push URL 不证明 fetch 身份。

只允许修改唯一映射目标。fetch 不顺带更新其他 tracking refs、不获取/修剪标签、
不递归获取 submodule、不写入 `FETCH_HEAD`，也不改 remote/upstream 配置。
只读 tracking 观察复用相同映射证明；无法唯一确证时不返回 tracking 匹配。

## 结果与竞争

- `fromCommit`、`toCommit`、`changed` 描述 HEAD；`changed: false` 不代表没有
  发生 tracking 修复。
- `tracking.status` 为 `updated` 或 `current` 时，目标已同步，并包含精确 ref
  和新旧对象 ID。
- `tracking.status: unmanaged` 带有原因。HEAD 仍可刷新成功，但不声称 tracking
  一致。
- 操作开始后失败，沿用非零的 `RUNTIME_ERROR` 通道。JSON 的 `details.refresh`
  保留实际观察到的 HEAD、可用时的已验证提交和 tracking 结果（受管目标为
  `failed`）。缺失或不可读的观察可为 null。文本错误也说明实际部分结果。
  变更前的前置条件失败可以不带部分结果。

refresh 在更新前后复查映射、干净状态、分支与 HEAD。Git ref 事务同时验证稳定分支，
并以捕获的旧值（或不存在）比较后写入 tracking 目标。本地 ref 竞争、映射变化、
checkout 分歧或 fetched/advertised 不一致都会显式失败。ff 之后 tracking 更新失败，
HEAD 保留实际的新提交；不会回滚或覆盖竞争方的 ref。不自动重试、重放，也没有后台
同步器。

清理临时 ref 时比较已知 fetched 对象后才删除。清理失败报告保留的 ref；获取中断或
失败可报告供检查的精确临时命名空间。这些是 Git 诊断，不是持久 Task 进度或新恢复协议。

maintenance fence 串行化 Yui 维护，不锁住任意外部 Git 命令或用户编辑。检查和 Git
锁约束本次观察，不承诺观察之后本地或远端不再变化。只有当前分支 upstream 指向此次
刷新的 tracking ref，普通 `git status` 才会消除相应虚假 `ahead`。不同或缺失的
upstream 保持原样，不作这一承诺。

## 采用边界

本操作不新增 Yui 持久 schema 或迁移。安装实现代码不等于刷新真实 Project；
正常获授权的 refresh 才应用此行为。Task 完成、集成、发布和归档仍是独立操作。
