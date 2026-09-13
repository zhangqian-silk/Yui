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
确认或工作流状态。终态工作区清理在完成时可以只是建议，但在归档时不行。被选作
结果的 Artifact 必须是固定的、存在的且 Task 局部的。

发布记录一个远程 PR/MR 引用。被报告的合并、独立验证的合并以及确切的 Task-head
覆盖是彼此独立的事实。Task 完成不证明其中任何一项。远程交付从确切的发布/head
证据读取，而不从标题或分支名推断。

完成 head 始终是不可变的验收基线。之后获授权的集成可能产生不同的发布候选
（例如远端 squash 前的 rebase 或 merge）。祖先关系和 Integration 成功都不能
证明验收行为未被撤销，也不验收额外增量。

对于已完成但未归档的 Task，先把精确候选记为 Publication 的 `localCommit`，
再读 `task publication diff <task>/<publication>`。此命令只读取 Task 自有的
本地 Git 对象，返回原完成记录引用、两端 commit/tree、完整差异（含二进制变更），
以及绑定这些事实的摘要。逐项核对删除、增加和冲突处理是否仍满足原需求；仅在原成果
保留、相关增量也已验收时，执行
`task publication adopt <task>/<publication> --reviewed-diff <sha256> --acceptance <text>`。
验收依据应解释上述判断及其验证/审阅证据；Core 核验固定身份和事实，不裁定代码语义。
如果已有本 Task 的 Integration 产出了该精确候选，在两个命令中都传入
`--integration <id>`，一并绑定其已提交证据。这只新增一个 Task 事件，不新增交付
状态表、Candidate 生命周期或 Git 操作，也不授权修改已完成成果。

`task publication verify` 仍是显式且须获授权的 provider 读取。它独立于 Task
验收，记录远端 source head、PR/MR 状态和 merge commit。head 不匹配或尚未合并时，
保存为 **reported** 并取代旧验证；provider 错误或外部身份不匹配则不写任何证据。
已合并的 provider 观察仅验证该 Publication 的精确本地候选；squash 不需要伪造
提交祖先关系。元数据/验证更新只有沿连续同候选的 Publication 血缘才能继承采用；
候选或所引用的 Integration 变化，不能悄悄复用旧决定。

CLI、当前 Leader Context 和 Web 从同一组事实推导覆盖，不联网、不写证据。展示
区分尚未交付、PR/MR 已合并但未覆盖、已覆盖合并但未验证、部分交付、已验证合并。
每个 Project 保留自己的验收 head、候选、采用引用和原因。缺失的历史 head 仍然
未知；旧精确 SHA 证据无需补造采用记录，归档也不能反推已交付。

取消意图不证明运行时已停止。user/Operator 可以重开已取消的 Task；Leader 可以重开
已完成的 Task。重开需要全新的显式输入/工作选择，绝不重放先前的交付请求。

## 归档

归档是一次单独的授权动作，发生在活动工作已了结、资源干净可移除之后。显式选择
集成交付或有意放弃。普通 integrated 归档要求每个代码 Project 的已合并且已验证
Publication 通过精确匹配或有效显式采用覆盖验收 head。证据不足时阻止此路径；
force 仍需单独明确授权，绝不证明覆盖成立。

受管的 WorkItem 资源必须在清理前被集成或有意放弃。Review、Lane 和 Integration
资源必须已结算。脏 worktree 留给 Agent 解决；不发生隐式 reset 或强制删除。Task
main 分支和持久 Task 记录保留恢复信息。已归档的 Task 不能重开。

清理前用每个命令的 `--help` 查看它确切的权限和选项；阅读一份生命周期文档不授权
一次外部写入。
