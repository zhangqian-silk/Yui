# Task：任务事实与交付责任

**层次位置：Capability Plane。** 本模块提供任务事实的查询与原子修改。记录经 Kernel 持久化，Context／Surface 消费查询结果，Execution 提供执行证据；Task 本身不运行决策模型。

分层位置与完整工作关系见[总体架构](../architecture/01-overview.md)。

## 1. 定位与数据边界

Task 模块保存用户目标和工作事实，暴露原子编辑及验收能力。它不运行模型、不选择工作顺序，也不假设所有结果都通过 Git 交付。

核心记录包括 Task、Brief、Decision、WorkItem、Candidate、Review 引用和验收／完成说明。Message 与 Role 通过公开接口关联；Turn 结果由 Execution 保存，Task 不复制一份相同结果正文。

```text
Task → Brief / Decisions
     → WorkItems → Candidate → Artifact / Turn result
     → completion note
Review → Candidate + Reviewer Turn
```

## 2. Task 生命周期

生命周期是 draft、active、completed、cancelled。它描述用户是否计划、执行或结束该目标，不表达每种内部活动。

Draft 可以进行对话、编辑与授权的规划实验。Active 允许正式交付。Completed 表示受权负责人明确确认结果；Cancelled 表示明确停止追求该目标。历史内容仍然可读。

结束任务会停止新的自动派发，不证明旧进程已经停止。迟到结果进入原记录，不自动重开 Task。需要继续时由用户／Operator／受权 Leader 显式重开，并明确选择哪些待处理工作继续，不重放全部历史通知。

## 3. Brief 编辑

Brief 内容保持通用自由文本。更新接口支持只修改指定字段，并附 expectedRevision；发生并发修改时返回当前版本与冲突字段，使 Agent 能重新读取后继续。

currentFocus 可以用于进度和下一步关注点。修改它与修改方案都不会自动撤销 Candidate 或 WorkItem acceptance。重要选择用 Decision 表达，Core 不做语义分类。

可以保存修改来源和必要历史，便于用户查看规划怎样形成。历史用于理解，不参与另一个调度状态机。

## 4. WorkItem

WorkItem 是 Leader 确认值得独立负责的一项工作，包含 objective、acceptance、可选依赖和 assignee。Requirements 较长时可保存在正文或引用材料，不必重复 Task 的全部字段。

状态为 open、accepted、retired。运行与等待由 Turn 或执行请求派生；一次失败不把责任本身永久标成 failed。

依赖用于 Leader 声明“这项工作需要那个结果”，不是让 scheduler 自主设计 DAG。执行准入根据已经声明的依赖检查是否有可用结果。若 Leader 调整策略，可以修改依赖并重新提交执行请求。退休不暗中把依赖转接到其他 WorkItem。

同一 WorkItem 的 ordinary 执行避免无意重复写入；需要多路时显式使用 group。WorkItem 的编辑不会在运行中偷偷改写已经发出的 Assignment。

## 5. Assignment 与执行快照

一次派发保存实际交代的目标、上下文、Role 配置引用和资源范围。该信息可以存在 Turn 的 input snapshot 中，不必建立独立服务或表。

Leader 修改当前 WorkItem 后，原执行快照仍是事实。它可以继续、停止或接受补充指令，由 Leader决定。框架不根据全部 revision 变化自动取消运行。

## 6. Candidate

Candidate 表示明确提交的一版结果。必要字段是所属 Task、可选 WorkItem、来源 Turn 或受权导入、简短说明及 Artifact 引用。提交后内容和来源不可变；新版本结果创建新 Candidate，而非覆盖已被讨论的版本。

Artifact 可以是原始 Turn 输出、文件、外部版本或动作回执。没有额外文件的工作也可以把明确的结果文本作为产物，不应因为缺 Git commit 而无法提交。

Candidate 不拥有运行时，也不决定代码保留。其来源保存 Agent、插件版本等可解释元数据即可，不要求完整旧依赖包永久存在。

## 7. 验收与 Review

Leader 选择 Candidate 并接受 WorkItem，可附说明和 Review 引用。Core 验证权限、引用属于同一目标以及记录可读，不解析结果质量。

Review 关联一个 Candidate 和实际 Reviewer Turn。Reviewer 的原始结果只存在 Turn；Review 不维护另一份 verdict 文字，也不自动 reject 或生成修复任务。

要求变化后，Leader 可以明确说明旧结果仍满足需求并继续使用。Framework 不需要交付版本失效传播。需要撤回接受时保留历史验收，当前 WorkItem 回到 open，但不会自动重做已经消费过结果的其他工作。

Task 级 direct 结果可以直接形成完成说明及引用，不强制创建一个假的 WorkItem 或 Candidate。用户明确要求独立 Review 等硬条件时，由相应显式要求和能力验证处理，不把它设为所有 Task 的默认门禁。

## 8. 原子能力

主要能力为 task.create/edit/activate/complete/cancel、brief.read/update、decision.record、work.create/edit/retire/dispatch/accept、candidate.submit/read、review.request/read。具体 CLI 层次可以沿现有命令组织。

这些能力返回记录或操作引用，不在返回前等待整个任务闭环。派发和评审请求交给 Execution；结果由通知让 Leader 读取。

## 9. 验收要点

Draft 编辑可恢复；进度不触发结果失效；当前方案变化由 Leader判断；Review 不复制输出；direct Task 无额外流程也能完成；取消或重开不复活旧未知请求。对应场景为 S01、S02、S04、S05、S06、S07、S08、S13、S40。
