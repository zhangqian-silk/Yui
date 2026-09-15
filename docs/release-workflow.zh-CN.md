<p align="right"><a href="./release-workflow.md">English</a> | <strong>简体中文</strong></p>

# 获授权的发布操作

发布工作流是一段被显式选择、获授权的外部发布效果序列——pull request、CI 确认、
合并、版本 tag、npm 发布、全新安装冒烟、CLI 更新、Controller 替换、Project 迁移和
后置验证。它是一个专用的外部效果设施，而不是 Yui 的 Task 规划或 Agent 执行模型。
Agent 选择一个预先声明的计划，设施从持久状态驱动该计划：每次转换都在下一次外部调用
之前持久化，因此崩溃、超时或被撤销的 grant 都不会让发布陷入猜测。

两个 Task 级记录族支撑它：

- **CapabilityGrant**（`capability-grant-N`）——权威。一个具名的授权者把 grant
  限定到若干动作、参数边界、一个过期时间、一个使用次数和一个不可逆上限。
- **ReleaseWorkflow**（`release-workflow-N`）——计划及其进展：一个确切来源（仓库 +
  钉住的 commit，可选一个 artifact）、一份不可变的有序步骤计划，以及每步一条持久记录。

引擎（`src/release/releaseWorkflowEngine.ts`）负责持久状态转换和工作流锁；`yui task workflow` 和
`yui task grant` 命令驱动它。每个外部系统都位于 `ReleaseWorkflowPorts`
（`src/release/releaseWorkflowPorts.ts`）之后。可用临时 SQLite 和确定性的外部端口测试
恢复逻辑，无需真实 GitHub、npm、git、Controller 或模型效果。

## 1.0 前的契约清理

当前开发步骤先清退运行时兼容分支，尚未执行最终 1.0 基线切换，也不发布版本或重置
存储编号。存储 `27→28` 只规范化可明确识别的单条 Role 调度去重键，旧迁移账本、
Message、Task 结果和不确定外部效果保持不变。普通打开要求存储 33；已有 Home 只通过
显式升级入口前进，不增加运行时双读。

这是一次 1.0 前的破坏性变更：

- `message send` 统一使用 `--intent`；CLI 与 capability API 不再接受 `--wake-policy`
  或 `wakePolicy` 参数，Draft 编辑保留原提交意图。
- 内部命令集成实现 `notifyMailboxChanged`；Task-only 通知适配器及其调用已统一。
- ACP peer 必须回报 `configOptions`，不再走 `modes`／`set_mode` 路径。
- Release 恢复要求精确 Home 与安装 prefix。缺少固定目标的效果保持 unknown，
  身份不完整的 handover lock 保持围栏。
- 开发 link/unlink 要求当前登记文件，不搜索或接管旧 NVM 登记，不重建孤立链接。
- GC 不再发现旧 deployment 布局或重建已删除 worktree；不受支持的 quarantine
  证据保留，不会被当成当前 move 回执清除。
- `task activate` 只消费已有请求；没有请求就不采用资源。请求创建、延后准入和
  原子工作区采用仍分开，并复用同一个现行执行边界。
- 删除 `task integration queue` 及其状态机。Agent 选择每个 WorkItem 结果的顺序与
  策略，逐项调用原子 Integration；保留精确检查、目标 CAS 和完成义务。

存储 `28→29` 在删除活动队列表前，将每条旧 payload 原样保存在
`integration.queue-retired` Task 事件中，并保留原队列 ID。事件编号越过已有计数器
和历史最大 ID。此操作不验收交付、不生成 Integration、不重放工作；已有 Integration
与 Job 保持不变。通过 `task event list <task>` 和引用的 WorkItem/Integration
判断剩余工作；队列退役不代表未完成的 Integration 已结算。

存储 `29→30` 将 Run-linked wake 的完整原文移入 `wake.run-link-retired` Task 事件。
现有通知保留 ID、投递状态和引用，使用 wake schema 2；Run 终态不再消费通知。
引用待退役 wake 的活动 Run、受管重试或未决 claim 会同时阻止预检和迁移；
迁移不停止执行、不编造接受。Global Session 没有受控 binding 时统一显式保存
`providerBinding: null`。

存储 `30→31` 将 Review scope 统一为显式值：有效旧 WorkItem Review 的缺失／null
scope 转为 `work-item`，Task-final 候选证据和原迁移账本不变。新建和重试均显式写入 scope。

存储 `31→32` 从当前 WorkItem 移除 `historicalState`，移除前将完整原始 payload
原样保存在 `work-item.execution-state-retired` Task 事件。当前状态、工作范围、
Candidate 和执行组不变，不生成 Run 或验收。未知历史形态会报错，记录和迁移账本不前进。

存储 `32→33` 清退 Leader 过渡／预算配置以及 VerificationPlan 的模式。
活动计划显式补上 schema 版本，实际检查保持不变；已退役 Knowledge 原文保留。
Integration 显式补入 `rerunChecks: false`，缓存 Artifact 移除试运行复用计数。
原配置可从显式升级备份恢复。这是已确认的行为变更，不将三种旧模式声称为等价。

已接纳且仍为 `running/validating` 的计划验证会阻止预检和迁移，需先用旧版本完成
结算；不会把运行中的 Job 改标为新证据契约。验证计划摘要使用 v3，使旧缓存不再被
自动复用，不重写历史 Job／Integration 结果或删除其日志。旧计划解析冻结在迁移
目录中，早期迁移保持原有语义。

Scheduler 核心读取和持久化操作成为必需接口，缺少 Session／Event 读取不再被当作
空证据，也不能跳过错误持久化。执行及 Web 投影直接读取当前 Store；
消息入队必须读取 Task 生命周期。精确投递结算仍独立，不增加会丢失迟到证据的归档门槛。

Task 列表及 `/api/dashboard` 只保留有界目录；调用方去掉 `--view compact`，
详情使用单 Task 读取。Scheduler 目录索引是必需接口，不再兼容缺失时的全量扫描。
额外 `schema.json`／`state.json` 不覆盖 SQLite 版本，也不用于开发 Home reset；
升级保留无关文件。非空 Home 缺少数据库时仍拒绝初始化。
不认识的 writer lease 明确诊断，不接管、不删除。

`controller status` 固定输出身份信息，存储矛盾仍返回非零健康退出码；
`YUI_STATUS_IDENTITY` 不再选择另一套契约。升级侧直接复用资源采集器读取生命周期，
无需让旧 Home 先通过当前 schema 的健康校验。

现行边界进一步收敛：

- Project／Artifact 文件锁及 handover lock 要求精确进程代际证据。owner 缺失、
  格式不完整或 OS 身份不可读时保持围栏；仅凭年龄不能证明创建者退出，不再用
  PID-only 存活判断代替身份确认。
- PR head 查询只调用 `gh pr list --head ... --state open`。仅有效空数组证明不存在；
  传输失败、身份格式错误和多个匹配都不允许继续创建。
- 已有 Git 操作缺少原 Integration 进度回执时不再被接管。保留文件并明确诊断；
  有精确回执的正常冲突／Job 续作仍受支持。

发布前应先收敛旧执行，对不受支持的锁、链接和隔离资源做显式清理。归属与处置尚未
确定时保留原记录，运行时不替 Agent 选择恢复方案。

后续基线切换必须先验证到目标格式的桥接或导出，再用一个干净基线替换旧初始化和迁移链，
之后才能删除基线之前的迁移及历史夹具。存储基线只重置一次，不在发布 `1.0.0` 时再次
重置。未知版本拒绝、精确进程／Host 身份检查与持久审计证据仍应保留。版本 tag、真实
Home 迁移和发布效果需要各自的发布授权。

## 授权模型

每一次（再）提交一个步骤，都在外部调用**之前**通过 `checkGrant(grant, request, now)`
（`src/grant/capabilityGrant.ts`）。步骤 kind 就是 grant 动作：一个 grant 列出它授权的
步骤 kind，例如 `--action npm-publish --action version-tag`。该判定是 fail-closed
的——每个拒绝都带一个机器可读原因并停止这次运行：

| 原因 | 含义 |
| --- | --- |
| `grant-missing` | 没有 grant 记录绑定到该工作流（引擎级）。 |
| `grant-revoked` | 该 grant 已被 operator 撤销。 |
| `grant-expired` | 墙钟已过该 grant 的 `expiresAt`。 |
| `grant-uses-exhausted` | 该 grant 的 `maxUses` 已被消耗。 |
| `grant-action-not-allowed` | 步骤 kind 不在该 grant 的动作中。 |
| `grant-parameter-missing` | 步骤缺少一个受约束参数。 |
| `grant-parameter-value-not-allowed` | 一个受约束参数的取值越界。 |
| `grant-irreversibility-exceeds-ceiling` | 该步骤比 grant 的上限更不可逆。 |

附加规则：

- **每次获授权提交消耗一次。** 引擎在成功判定与外部调用之间记录一次 grant 使用，
  因此一个 `maxUses` grant 会在那次将要超额的尝试上 fail closed。
- **不可逆步骤需要一个已确认的前缀。** 一个标记为 `irreversible` 的步骤额外要求此前
  每个步骤都是 `succeeded`；否则该步骤以 `prerequisite-not-confirmed` 失败并停止运行。
  这正是让 `npm-publish` 不会跟在一个失败的 PR 之后运行的机制。
- **拒绝会被记录。** 当一个待处理步骤被拒绝时，引擎会启动并把该步骤失败，日志里带上
  这次拒绝，因此 `workflow status` 能准确显示授权在哪里停下。
- **重新绑定。** 一个被撤销、过期或过窄的 grant 不会让工作流走进死胡同。签发一个新
  grant 并用 `yui task workflow resume <task> <workflow> --grant <new-grant>` 恢复；
  跨越这次重新绑定，计划、来源和所有已确认的步骤证据都不可变。

## 稳定的 Task-final Review 合同

兼容的 CLI 包更新和 Controller 替换不改变一个活动 Task 的 final-review 能力。受管
Session 使用普通的 `yui` 命令，兼容性由协议和存储身份检查，一个替换 Leader 呈现由
持久 Task 证据已确立的合同。不需要任何版本感知的 Operator 动作。Candidate 和
Task-final 的 ReviewRound 记录必须全部携带那唯一的合同。冲突的记录 fail closed；
不存在重新绑定事件、恢复命令或第二套合同状态机。

## 常驻 Agent Host 升级兼容

存活 Host 保持原 Endpoint 实现，先把准确的 Session/attempt/nativeTurn 事实写入现有
持久 Inbox，再联系 Controller。只有当前 Controller 解析 Run 归属、校验权限、工作区、
生命周期与历史关联并提交结果。Inbox 文件不代表接受；提交后才确认消费，断线或丢失
ACK 不会重放用户输入或模型工作。

启动事实从已兑现的 launch payload 取得准确 Run 身份，不把 Run 固定到长期 Session
环境。即使冻结的 Run 工作区不同于 Role 默认值，登记前的证据也能保留；后续活动和
终态仍只按各自的原生输入身份解析归属。

支持边界为控制协议 `yui-agent-host/v5`、事件来源协议 `yui-agent-host-events/v1`、
Controller RPC 版本 4。声明 `storage=controller-owned` 的 Host 不打开 Home 数据库，
包括进程归属、原生账号位置和执行环境校验。Home 22 声明 Inbox 的新增来源字段，
不改写有效历史事实与业务记录。后续版本要么保留该线协议，要么在修改存储前拒绝不兼容
的存活生产者。刷新 Session CLI wrapper 或新 `doctor` 成功都不能证明旧 Host 兼容。

`upgrade`、`update` 的目标版本预检及 release activation 独立检查存活 Host。
没有此能力的 legacy Host（包括 idle）以及兼容响应不确定的 Host 都阻止采用；
在既有隔离/静默交接边界再次检查，先于迁移或发布切换。检查不会 kill、替换或 reload
Host。先让原有工作结束并保留原始未决输入/结果证据，再由获授权的 Operator 在安全
边界选择 Session 替换或清理，之后重试。安装新代码不能修改已加载的 legacy Host 内存，
也不能回收它从未持久投递过的终态。

`task role status`、`task role list` 和 `task role session inspect` 在持久 Run 状态旁
显示 Host 上报观测。原生结果待落库或已知上报故障需要关注，但不代表 Provider 失败、
Run 已结束或业务已验收。Host 诊断只检查自己已投递文件的身份是否存在，不解析或隔离
其他生产者的新格式事件。

## CLI 与 Controller 发布边界

全局 `yui` 命令是稳定的用户与受管 Session 接口。对普通命令，它不跟随
`runtime/active-release.json`：那个指针选择的是 Controller 发布，而不是 CLI 包。这让
CLI、Operator Session 和 Controller 替换保持兼容，而不必把每个命令钉在一个不可变构建上。

一个源码 checkout 或以其他方式未经验证的本地 CLI 不是这个已发布接口。当 `YUI_HOME`
已经命名了一个活动发布时，这样的 CLI 会在打开存储之前失败，并报告它的构建/来源、
持久的 Home 身份以及它的调用类别。`make install-local` 仍默认使用 checkout 隔离的
`output/dev/home`；把那个 launcher 显式指向一个发布拥有的 Home 会被拒绝。

一个显式的 `yui release activate <release-id|build-id>` 是唯一的例外。全局 CLI 校验
已安装的目标发布及其匹配的冒烟回执，然后把未改动的激活参数委派给那个目标的
`dist/cli.js`。因此目标发布拥有完整的交接协议和超时层级。一次无目标的激活、help、
`--json` 以及其他每个命令都留在全局 CLI 上。激活不新增另一条普通 CLI 路由路径。

## 步骤目录

计划是一个固定、预先声明的操作子集。每个计划条目有一个 id（工作流内唯一）、一个
kind、可选 params，以及一个可选的不可逆级别（`none` | `reversible` | `irreversible`）。

| Kind | 外部效果 | 权威身份 |
| --- | --- | --- |
| `pr-create-or-reuse` | 创建发布 PR，或复用一个针对该 head 的开放 PR。 | `pull-request` 号 |
| `ci-confirm` | 读取该来源 ref 的 CI 结论；仅在 `success` 时成功。 | — |
| `merge` | 合并具名 PR（默认 squash）。 | — |
| `version-tag` | 创建并推送带注释的版本 tag。 | `git-tag` 名 |
| `npm-publish` | 把 tarball 发布到 registry。 | `npm-package` 版本 |
| `fresh-install-smoke` | 从 registry 安装并运行已发布的包。 | — |
| `cli-update` | 通过既有更新编排器更新 Yui CLI/Controller home。 | `controller-home` |
| `controller-replace` | 停止并重启 file-task Controller。 | — |
| `project-migrate` | 通过既有的 project 命令运行 Project 迁移。 | — |
| `post-verify` | 运行一个任意的验证命令。 | — |

步骤可以引用更早的证据：一个 param 值为 `$externalId:<step-id>` 时，会在运行时解析为
被引用步骤已确认的 external id，因此一个 `merge` 步骤可以消费 `pr` 步骤产生的 PR 号，
而 operator 事先并不需要知道它。对一个未确认步骤的引用会让运行失败，而不是猜测。

## 恢复与 resume 语义

一次运行总是从 **resume 游标**开始：第一个状态非终态（`succeeded` 或 `skipped`）的
计划步骤。没有“从头再来”——已确认的步骤绝不重跑。

因为每次状态转换都在下一次外部调用之前持久化，所以任意一点的进程退出都是可恢复的：
重新调用 `run`（或 `resume`），引擎就从第一个未确认步骤继续。`--max-steps <n>` 限定
单次运行；一次在工作流中途耗尽预算的运行返回 `budget-exhausted`，下一次调用继续。

在途步骤通过**权威身份查询**解决，绝不盲目重新提交：

- 一个留在 `running` 或 `unknown` 的步骤，先按其记录的 `externalIdentity` 查询。
  - `exists` → 该步骤到达 `succeeded`，且**没有第二次提交**（`unknown` 被确认，
    `running` 被完成）。
  - `unknown` → 运行以结果 `unknown` 停止；在其命运不可知期间，该步骤绝不被重新提交。
  - `absent` → 效果从未落地，因此该步骤被重试（一个 `running` 步骤会记录这次恢复尝试）。
- 一个**没有** external identity 的 `running` 步骤在记录提交结果之前就崩溃了。一个
  不可逆步骤无论如何都通过端口查询（适配器咨询其持久幂等存储）:`exists` 不经第二次
  提交确认该步骤，`unknown` 以 `unconfirmed` 停止，只有权威的 `absent` 才恰好重试该
  步骤一次。一个可逆步骤总是落到重试，并沿用同一个幂等键。
- 一次**没有** external identity 的超时把该步骤标记为 `unknown`（unconfirmed），因此
  它绝不被盲目重新提交；在 resume 时它以 `unconfirmed` fail closed。
- 一个 `failed` 步骤在下一次运行时被重试；它的 `attempts` 计数和日志按尝试增长。

运行结果：`succeeded`、`failed`、`unknown`、`unauthorized`、`unconfirmed`、
`budget-exhausted`。每个都带一个机器可读的 `stopReason`（例如 `unknown:publish`、
`unauthorized:grant-revoked`、`budget-exhausted:verify`）以及该次运行尝试过的步骤 id
列表。

## 幂等键合同

每个步骤的幂等键在**创建时预先声明**且永不改变：

```text
<taskId>/<workflowId>/<stepId>
```

该键被传给该步骤的每一次 `executeStep` 调用，包括在一次确认为 absent 的超时之后的
重试。端口合同要求 `executeStep` 在同一键下是幂等的：一次重试尝试不得产生第二次
副作用。引擎不会盲目为 `unknown` 步骤调用 `executeStep`，而是先按记录的身份查询。
核心测试用真实 SQLite 和确定性端口检查不确定效果查询、已确认步骤复用和 grant 次数耗尽。
这证明这些引擎边界，不代表真实外部服务或所有发布适配器的幂等性已被验证。

## Operator 指南

Session 权威依据当前持久绑定检查。Telemetry 按 Role/AgentRun 分组，进程 owner 使用
PID/start 身份。存储变更遵循[唯一的显式升级边界](sqlite-control-plane-design.zh-CN.md);
普通命令绝不改写 Home schema。

grant 的签发与撤销是不可逆权威操作。它们需要当前已登记的全局 Operator 对话。它的
原生 session ID 必须与持久的活动 session 绑定匹配：Codex 命令在存在时使用
`CODEX_THREAD_ID`，否则使用 `YUI_NATIVE_SESSION_ID`;Claude 使用 `YUI_NATIVE_SESSION_ID`。
Host generation 和启动时的 Agent 标签不是调用者身份。通过另一个入口恢复同一段对话
不撤销其权威。一个未登记、被替换或已结束的对话没有这种权威。一个受管的 Task Agent
不能自签发或自撤销 grant，清空子进程环境也不赋予用户权威。被记录的授权者/撤销者
绑定到那个 Operator session（`operator:<agent-id>`）；不存在可伪造的 `--granter`/`--by`
标签。

```sh
# 1. Operator session 为发布链签发权威。
yui task grant issue task-15 \
  --action pr-create-or-reuse --action npm-publish --action post-verify \
  --irreversibility-ceiling irreversible

# 2. 针对确切来源和预先声明的计划创建工作流。
#    npm-publish 步骤需要一个内容寻址的来源 artifact：不可变的工作流来源以后
#    永远无法再获得它，因此没有 --source-artifact 的计划在创建时即被拒绝。
yui task workflow create task-15 \
  --grant capability-grant-1 \
  --source-repo acme/widget --source-commit abc1234deadbeef0000000000000000000000000 \
  --source-artifact widget-1.0.0.tgz@sha512-<base64-integrity> \
  --step pr:pr-create-or-reuse \
  --step publish:npm-publish --step-irreversibility publish=irreversible \
  --step-param publish:tarball=./dist/widget-1.0.0.tgz \
  --step verify:post-verify --step-param verify:command='yui --version'

# 3. 运行（或 resume）并检查。
yui task workflow run    task-15 release-workflow-1
yui task workflow resume task-15 release-workflow-1 [--grant capability-grant-2] [--max-steps 1]
yui task workflow status task-15 release-workflow-1

# 4. 随时撤销权威；下一个步骤以 unauthorized 停止。
yui task grant revoke task-15 capability-grant-1
```

`workflow status` 渲染每个步骤的状态、尝试次数和已确认的 external id，因此 operator
能准确看到一次发布在哪里停下以及为什么。

## 真实资源边界

真实执行只通过 `yui` CLI 发生，它接上真实适配器（`createReleaseWorkflowPorts`）。该
适配器是既有原子操作——`gh`、`npm`、`git`、CLI 更新编排器、Controller stop/restart 和
`project migrate`——之上的一层薄壳，并且只在一个人类授权者签发了对每个步骤都通过
`checkGrant` 的显式 CapabilityGrant 时才运行。一个本地测试请求绝不替代那份权威。

由 tag 触发的 `publish.yml` 工作流是唯一维护的发布冒烟。它复用那个通过了 core CI 的
确切 commit，只增加发布所需的产物装配、全新安装和 provenance 检查。

该工作流通过 npm Trusted Publishing（OIDC）认证，因此发布身份存在于 tag 之外的两处：
`repository`、`bugs` 和 `homepage` 由 `assemble-runtime-package.mjs` 从源 `package.json`
逐字复制进已发布 manifest，而该包的 npm Trusted Publisher 条目点明 GitHub owner、
仓库、工作流文件和环境。npm 在接受 provenance 之前会区分大小写地将 `repository.url`
与正在构建的仓库比较。因此重命名或转移 GitHub 仓库时，必须连同重命名一起更新这些 URL
和 npm Trusted Publisher 条目；否则下一个 tag 会走到 `npm publish` 并在那里失败——此时
tag 和已过门的构建都已成功。

## 适配器安全加固

真实适配器（`createReleaseWorkflowPorts`）在引擎的 grant 检查之外再施加额外防护：

- **Tarball 选项注入。** 一个看起来像选项的 tarball 路径（以 `-` 开头）在任何子进程
  ——`tar -xOf` manifest 检视和 `npm publish`——看到它之前就被拒绝，因此一个精心构造的
  路径永远不会被当作 flag 解释。
- **Tarball TOCTOU。** 在校验冻结的 `source.artifact.integrity` 之后，被校验的字节被
  快照到一个工作流私有、只读的临时文件。`tar -xOf` manifest 检视和 `npm publish` 都
  读取该快照，而不是活的 tarball 路径，因此校验之后对原文件的替换不能改变所发布的内容。
  步骤完成时移除该快照。
- **钉住的外部命令。** 适配器在构造时通过 `resolveExecutable` 把它 shell 调用的外部
  命令（`gh`、`git`、`npm`、`tar`、`sh`）解析为绝对路径，只走一次调用者的 `PATH`。每次
  子进程调用都使用解析后的路径，因此之后的 `PATH` 变化（或被操纵的工作目录）不能把一次
  发布效果重定向到另一个二进制。一个无法解析的命令返回一个合成失败（exit 127），不调用
  任何二进制。
- **钉住的 cli-update 激活目标。** 在不可逆的更新效果之前，适配器把确切的激活目标——
  Home 加上全局 npm 前缀（`bin/yui`）——持久化到 Home 下的一个持久文件
  （`release/cli-update-identity/<idempotency-key>.json`）。一次硬退出的恢复查询（一个
  没有记录身份的步骤）读取这个文件并调用那个钉住的目标；如果该文件不存在（进程在预效果
  持久化之前退出），查询返回 `unknown`，而不是从 resume 调用者的 `npm prefix --global`
  或 `PATH` 推导目标，因此 resume 环境中的另一个安装不能替这个步骤背书。
- **Controller 生命周期校验。** 一次 `cli-update` 恢复查询会证明替换后的 Controller
  确实拥有目标 Home：它运行 `yui --json controller status`（`YUI_HOME` 钉在记录的 Home
  上），并要求一个 `current` controller 资源，其 `yuiHome` 解析到那个 Home，然后运行
  `yui --json controller identity`，并要求已认证的 Controller 身份与已激活的产物匹配：
  Node.js 可执行路径、由钉住的全局二进制派生的确切 Controller 入口点，以及包版本。仅有
  二进制健康（doctor、`--version`）绝不确认这次交接，任何不可证明的状态都返回 `unknown`。
  这适用于带身份的查询和硬退出查询（一个没有记录身份的步骤）两者。
- **npm integrity 比较。** 一次 `npm-publish` 恢复查询不止步于已发布版本：它通过
  `npm view <pkg>@<version> dist.integrity` 取 `dist.integrity`，并与冻结的
  `source.artifact.integrity` 逐字节比较。匹配则确认该步骤；同一版本但字节不同是一个
  冲突，返回 `unknown`（绝不确认，绝不重新发布）；一个缺失的版本是 `absent`。
