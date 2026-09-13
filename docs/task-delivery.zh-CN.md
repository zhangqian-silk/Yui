<p align="right"><a href="./task-delivery.md">English</a> | <strong>简体中文</strong></p>

# Task 交付与资源生命周期

## 生命周期与规划

Task 生命周期是 `draft / active / completed / cancelled / archived`。Draft 保存
意图、Project 绑定、规划讨论和可变需求。它在创建时不采用可写的交付工作区。

激活会校验当前 Role、依赖、Project 范围和资源，准备物理工作区，并原子地采用
状态/所有权。准备失败会让 Task 停在 Draft，附带一个失败请求和投递给 Leader 的
诊断。延迟激活保留确切意图并等待原生静止，无论它是在规划 Run 中还是在后续讨论中
被请求的。

Task type 描述被请求的结果，而不是强制的执行者。Leader 直接负责有界工作，或分派
有独立价值的 WorkItem。直接执行没有 Group。复制是为了在同一个冻结 Assignment 上
进行独立尝试而被显式请求的，随后由 Leader 选择综合。

## 受管工作区

稳定的 Project checkout 是只读参考。Task main 是一个逻辑上的多 Project 根，带有
按 Project 划分的 Git worktree。对单个 Project，Agent 的正常 cwd 是其受管 Git 根；
对多个 Project，根加上原生的附加目录机制暴露明确的 Project 集合。

一个隔离的 WorkItem 为可写 Project 拥有独立 worktree，为其余 Project 提供 Task-main
上下文。写范围是显式的，且只能由获授权的 owner 扩大。Review 拥有一个单独的冻结
工作区，不能变成 Develop 或 Integration 来源。验收或退役不释放 WorkItem 的持久
工作区。Task-main 准备会保留一个 Role 保留的 WorkItem/Review cwd，直到显式清理或
重新分派。决策支持类读取观察当前 Git head，而不准备工作区或迁移 Session。

启动前，实际 Git 血缘必须由已记录的基线派生而来。落在该血缘之外的 reset 是物理
漂移，而不是猜测或修复所有权的理由。一个显式采用的环境可以选择不同的原生 cwd，
而受管工作区仍是 Git/控制所有权记录。

## Candidate、Review 与 Integration

Provider 终态保存确切的原始 Run 结果。它不验收 WorkItem。Leader 评估结果，并为
隔离代码捕获不可变的、按 Project 划分的 ChangeSet。治理 Candidate 为 Review 和
Integration 提供来源；Producer 不独立进入这两条路径中的任何一条。

Integration 在候选 worktree 中套用固定 ChangeSet，运行已配置的检查，然后只有在
目标 head 仍匹配时才推进目标。冲突、检查失败、目标移动或拒绝都保留证据，绝不推进
目标。Agent 在保留的工作区内选择重试或手动解决。

当检查是一个 DurableJob 时，Integration 在运行期间保留那个确切的 jobId。Job 结算
后，`task integration continue <task>/<integration>` 消费其结果并执行带守卫的收尾。
这个直接操作不依赖单独 integration 队列中的条目。

Review 遵循适用的 Candidate 规则或 Task-final 合同以及冻结的 head。确切的 main
Reviewer Run 持有报告；执行成功不等于语义通过。验收归 Leader。即使默认审查策略
被关闭，用户明确要求委派或获取独立 Review 仍是验收的一部分。`next-action` 报告已
存储的事实和备选项；它不能削弱 Task Contract，也不能推断“没有记录 WorkItem”就
意味着请求了直接执行。

## 完成与远程交付

完成会检查当前的 WorkItem、最新捕获/集成的结果、适用的 Review 合同以及确切的、
干净且已提交的 Task-main 快照。当有一条新的 user/Operator 消息仍在等待 Leader
投递时，它也会拒绝完成。当前原生轮次必须结束，待处理的通知才能到达；随后 Leader
读取原始消息并重新评估完成。这派生自既有的 Message 和 mailbox 投递，而不是第二套
确认或工作流状态。终态工作区清理在完成时可以只是建议。普通归档要求清理已结算；
明确授权的 force 归档可以保留下文所述的未解决资源。被选作结果的 Artifact 必须是
固定的、存在的且 Task 局部的。

发布记录一个远程 PR/MR 引用。被报告的合并、独立验证的合并以及确切的 Task-head
覆盖是彼此独立的事实。Task 完成不证明其中任何一项。远程交付从确切的发布/head
证据读取，而不从标题或分支名推断。

取消意图不证明运行时已停止。user/Operator 可以重开已取消的 Task；Leader 可以重开
已完成的 Task。重开需要全新的显式输入/工作选择，绝不重放先前的交付请求。

## 归档

归档需要针对确切的 completed 或 cancelled（retired）Task 获得独立的 user/Operator
授权。完成本身不授予归档权限，普通归档批准也不授权 force。显式选择一种处置：

```sh
yui task archive <task> --integrated
yui task archive <task> --abandon
# 仅在明确授权 force 后使用，并保留所选处置：
yui task archive <task> (--integrated|--abandon) --force
```

### 普通归档

活动工作与输入必须已了结，受管资源干净且可安全移除。WorkItem 结果必须已集成或
有意放弃；Review、Lane 和 Integration 资源必须已结算。使用 `--integrated` 时，
每个需要代码交付的 Project 都要求确切的已合并 head 覆盖及已验证的 Publication
证据。`--abandon` 记录有意不交付，而不是已验证合并。

缺失或陈旧的覆盖、未解决的执行或脏 worktree 会阻止普通归档。先解决报告的事实，
再显式重试；不会隐式 reset 或强制删除。

### 明确授权的 force 归档

`--force` 不只是覆盖合并验证要求。它先提交归档并停止新的 Task 调度，再尝试安全的
前台清理。缺失或陈旧的交付证据、未合并结果、未解决的执行和清理失败会成为警告及
保留资源引用，而不阻止这次归档提交。权限、合法生命周期、精确资源身份和强制审计
持久化仍严格检查，失败时拒绝相应操作。

Force 不验证合并、不验收工作、不证明物理静止、不丢弃脏数据，也不隐含 `--abandon`。
它保留所选处置及原始 Publication/完成证据。未验证的本地提交和无法安全释放的资源
仍有明确 owner 且可追溯。清理失败不回滚归档；迟到的运行时事件仍作为来源证据，
不恢复 Task 或结算未知输入。

### 清理前先读结果

`yui task show <task> --json` 暴露 `data.archive.warnings`、
`data.archive.retainedResources` 和 `data.archive.cleanupEvents`。
`yui task context <task> --json` 保留原始记录与事件；
`yui task remote-delivery <task> --json` 单独报告交付。警告包含历史清理尝试；
保留引用描述当前所有权，不是第二套清理队列。

归档结果中的 `archived=true` 证明已归档，不证明清理全部成功。即使 `cleanupFinished`
也只代表前台清理已走完，不代表资源全部移除。重复归档只报告当前事实，不重放清理。
检查后通过显式的精确 owner 资源操作进行安全清理；不隐含后台重试或更广泛的删除
权限。两条归档路径都保留 Task 历史与恢复信息。已归档的 Task 不能重开。

清理前用每个命令的 `--help` 查看它确切的权限和选项；阅读一份生命周期文档不授权
一次外部写入。
