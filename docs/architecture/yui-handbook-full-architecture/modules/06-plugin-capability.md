# Plugin 与 Capability：发现、实现和替换能力

**层次位置：Capability Plane 与横向 Plugin Fabric。** 本模块管理包、配置、能力描述和注册；唯一实例生命周期由 Kernel Host 提供。能力目录是可重建视图，注册贡献可以覆盖展示、上下文、工具和 Endpoint 等层次。

分层位置与完整工作关系见[总体架构](../architecture/01-overview.md)。

## 1. 外部接口

Agent 的基本操作是 search、describe、call。扩展操作是 create、validate、activate、disable，reload 或扩大作用域属于管理操作。

`search` 默认查询当前可见目录和明确配置的来源，不自动联网下载或执行任意包。发现名称只是第一步，调用前还需读取契约和当前可用 Provider。

## 2. Descriptor

CapabilityDescriptor 包含 name、contractVersion、input／output schema、effect、必要授权说明和 Provider 引用。实现必须声明自己实际提供的内容，不能仅列一个名字。

核心管理命名空间由可信内建实现提供。Task-local 代码可以贡献新能力，不能用同名注册覆盖 task.complete、权限管理或正在承载自身的 Endpoint。

Registry 记录可见 Provider 并可重建；持久化的根是启用配置和实现来源，不是再保存一份可独立写的“目录真相”。

## 3. 选择与调用

显式 Provider 选择优先；否则只有唯一兼容且可见实现时直接选择。Global／Project／Task 决定可见性和配置来源，不按加载顺序形成隐式覆盖。

调用入口校验 schema、身份、目标和所需授权。执行前取得确切 Provider 句柄；调用结束释放。无副作用查询不建完整操作账本，本地修改复用业务事务，外部操作按 Kernel 记录。

插件委派其他能力仍使用原调用者的授权。通过受权入口执行的每一步都有必要回执，父插件输出格式失败时仍能知道已完成部分。直接代码执行本身不提供无限权限，实际环境必须对应所选择的信任方式。

## 4. 包与实例

manifest 保存 id、version、apiVersion、entrypoint、provides、requires、permissions、reloadMode。包是代码或声明式内容；实例是某次 scope 和配置下的加载。

代码产物需要可明确定位。验证报告绑定被测试的实际内容摘要，激活时检查是否仍是同一份内容。版本号只是名字，不能代替内容一致性。

SDK 不强制搭建包市场或签名基础设施。它首先应使一个本地独立目录能够验证并注册，无需改 Yui 源码。

## 5. 声明式优先

Skill、Role 模板、简单映射和已有工具组合优先作为数据。能够由现有文件／脚本能力一次完成的工作，不一定需要插件。

需要可执行代码时，Agent 在被授权的开发环境写 source 和 tests，不能直接写当前安装目录或把未验证的模块 import 进 Controller。构建与测试同样受运行信任边界约束。

验证报告只证明已执行的测试及环境，不证明未来任意输入安全，也不授予新权限。

## 6. 激活与注册事务

激活先解析 manifest、依赖和可见性，建立临时实例及完整贡献集合。初始化只做注册准备，不执行业务发布、发送或数据修改。全部准备成功后发布目录变化。

失败释放候选实例的 effects，当前能力保持可用。系统无需为 source、build、stage 等每一步建立长期任务状态机；源码和报告本身已能表达开发进度。

Task-local 插件默认只在该 Task 使用。提升到 Project／Global 是受权配置操作，保留来源，不自动授权所有其他任务访问其资源。

## 7. 与 Runtime 的不同更新边界

一个新文档转换工具可以在当前 Agent Session 下一次桥调用中立即使用。一个新的 Endpoint 协议实现则通常作用于新 Session。两种更新不需要绑成“插件变化就重启所有会话”。

宿主在旧调用或 Session 结束前保留其实际使用的实现。普通 disable 阻止新独立调用；已有句柄按原承诺结束。撤回授权时，新的受控副作用立即受限制，不能因为持有旧 generation 就永久获得旧权限。

不要求通用 live handover。需要时通过关闭旧 Session、打开新 Session 和读取 Context 完成接手。

## 8. Agent 自扩展完整性

自扩展成功的标准不是 plugin loaded，而是原 Task 已经使用新能力取得有用结果。

Leader 可以在同一 Task 内反复修改和验证，不因为失败自动创建开发 Task。缺少授信或网络凭据时向 Operator／用户提出具体请求。Leader 本身不可用交 Operator；Operator 的问题由用户处理。

稳定的 Yui CLI 或能力桥在启动时就可用，不让 Agent 先安装元工具才能安装第一个插件。若 Runtime 只能在下一 Turn 使用新信息，明确采用下一 Turn，不虚构当前模型已经收到更新。

## 9. 代码与历史保留

活跃调用、活跃／明确计划续用的 Session、未决操作和用户固定引用决定哪些产物继续保留。历史 Candidate 只保存结果和来源，不默认固定所有旧依赖。

代码删除后历史仍可读；再次执行需要重新安装可用实现，这是能力请求而不是结果读取的前提。

## 10. 验收要点

能力契约和歧义、scope 不扩权、validation 产物匹配、初始化无业务效果、同 Session 动态调用新工具、普通停用与撤权、历史代码清理。对应场景为 S25、S28、S29、S30、S31、S32、S33、S34、S35、S37。
