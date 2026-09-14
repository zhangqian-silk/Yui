<p align="right"><a href="./task-discovery.md">English</a> | <strong>简体中文</strong></p>

# 有界任务发现

Agent 使用 `yui task list --json` 发现候选任务，再读取目标
Task Context 和原始 Message。目录是当前事实的只读视图，不是摘要数据库、
Context 快照、消息确认、执行判断或验收结论。

目录是唯一列表契约，不再提供 `--view` 选择或 `--verbose` 全历史列表。
交互选择器保持完整的 `{id,title,status}` 数组，只读取这些窄字段。
Web 通过 `GET /api/dashboard` 使用同一查询；单个 Task 的详情接口继续保留
执行、观测、用量和远端交付字段。目录查询本身不改变持久记录。

## 查询和分页合同

```sh
yui task list --project project-1 --status active --limit 20 --json
yui task list --attention openInputs --json
yui task list --search "候选标题" --json
yui task context task-1 --json
yui task context inspect task-1 --store task --ref task-1 --digest <digest> --json
yui task message show task-1/message-1 --json
```

`--project` 接受精确 Project ID。搜索按 SQLite 子串匹配 ID、标题、标签和
Project 名称：ASCII 不区分大小写，非 ASCII 字符按字面比较。缺省范围排除
归档 Task；`--all` 或 `--status archived` 纳入归档。计数明确属于该范围，
不泄漏不可见的全局总数。状态、搜索、Project 和关注分类只筛选 `total`
及任务行，不缩小范围内的关注汇总。

缺省每页 20 项，最多 100 项。成功 JSON 响应连同 CLI envelope 不超过
32 KiB；摘要最多 512 UTF-8 字节，标题最多 256 字节，裁剪明确标记。
ID、digest 和 cursor 不裁剪。必要元数据过长时返回有界错误，不成功返回
无法前进的空页。Brief 缺失会明确显示。

顺序是 `(createdAt,id)` 升序，ID 按 SQLite binary 排序。后续请求带
`--cursor <nextCursor>`，并保留全部筛选参数和 limit。null cursor 表示结束；
字节预算可能使实际条数少于 limit。首页固定最大匹配创建键，较新创建键
留到刷新后读取。各页仍读取当前状态：生命周期和筛选成员变化可能影响枚举；
这不是冻结快照，不会因为无关运行时事件而作废游标。

每个任务和关注样本携带真实 Task Context ref：
`taskId,store,refId,revision,digest`。digest 覆盖原 Task，不是裁剪预览或
Brief。当前 Brief 通过 Task Context 读取；Context inspect 可校验 digest
后展开原文。digest 变化会拒绝旧引用；引用不赋予权限，也不表示需求已读。

## 不扫描全历史也不遗漏关注入口

每页（包括筛选后无匹配的空页）都返回同一授权目录范围的当前关注事实。
每类包括记录/信号数量、涉及 Task 数量、最多四个精确 Task ref、
省略的 Task ref 数量，以及枚举全部相关 Task 的筛选入口：

启动该关注查询时清除先前的状态、搜索、Project 筛选，并保留其 `all` 标记，
从而保持声明的目录范围，包括此前明确纳入的归档任务。

| 分类 | 当前存储事实 |
| --- | --- |
| `openInputs` | 未解决 InputRequest |
| `pendingOperations` | queued/running durable Job |
| `unknownOperations` | unknown-needs-attention Job |
| `executionSignals` | active/draft Task 中的活跃 Run、open WorkItem 或仍含当前复制执行组的 accepted WorkItem、未解决或失败 Integration、pending/running/failed Review、Leader failure、pending/processing Leader mailbox |

`executionSignals` 是保守的发现入口，**不是**详情的执行状态分类器。
健康的活跃工作也会被包括，从而不会因为分页而藏住运行身份、停滞、
工作失败或恢复相关的关注入口，也不必先扫描所有 Task 历史 Event。
这些计数不是失败计数；请打开任务读取精确执行状态和来源记录。
不解析报告正文推导状态。Web 明确标示这些事实并提供分类导航。
已选详情不因分页、筛选或刷新而丢失；只有详情读取可以确认目标不存在。

Task Leader Session 只能发现自己的 Task。Assignment-scoped Worker 和
Reviewer 使用既有授权 Run Context，目录会在计数前拒绝其全 Task 发现请求。
非 Operator 的 Global Session 和不完整的受管身份也会被拒绝。
历史 Leader 的诊断读取保持原 Task 范围。游标绑定范围及参数，不是凭证。
读取不会消费 Message、确认 Job、唤醒 Role 或查询外部 provider。

## 成本边界

SQLite 在现有目录及状态索引上聚合窄事实，再选取当前页。
不会在 JavaScript 中解码全部 Task 正文、Run、Message、Event，不会先
构造所有重型 Overview 再删字段，也不逐 Task 构造 Context。
仅当前页和有界关注样本会解码原 Task，并计算精确 ref。

输出和物化行有界；数据库工作量仍随授权 Task 和相关索引行增加，
搜索可能在 SQLite 内检查 Task/Project JSON。精确引用仍需承担选中
Task 原正文大小的成本。这些是本机成本边界，不是恒定时间或模型效果承诺。
