<p align="right"><a href="./provider-runtime.md">English</a> | <strong>简体中文</strong></p>

# Provider 运行时

原生对话属于用户和 Provider。Yui 只添加自己的 Role Skill 和 Session Manifest
指针，通过结构化的原生协议投递范围受限的输入，并记录精确的执行证据。它不镜像
完整 transcript，也不要求每次用户交互都经过 Yui。

## 组件与连接

| 执行组件 | 连接方案 | 受管传输 |
| --- | --- | --- |
| `codex-cli` | `codex` | 经字节转发代理的 App Server WebSocket |
| `claude-code-cli` | `claude` | 持久的 stream-json 进程 |
| `claude-agent-sdk` | `acp` | 基于 stdio 的 ACP 桥接 |
| `unknown-acp-agent` | `acp` | 基于 stdio 的 ACP，产品身份未确认 |

可执行文件名不证明其产品身份。组件选择一个连接方案；协议不推断正在运行的是哪个
产品。

## Host 与 Endpoint

Controller 拥有持久的输入选择和观察处理。AgentHost 拥有其一次性连接并串行化请求。
AgentEndpoint 暴露 open/resume、submit/steer、inspect、events、cancel、detach 和
退出观察。Driver 把协议证据映射进通用的观察/错误词汇。

Endpoint 提交区分 accepted、pending、not-submitted 和 unknown。接受需要与确切的
被拥有输入相关联的 Provider 证据：一个原生回执，或一个在独占串行流上的响应。写入
的字节、PID 或 tmux 面板都不证明接受。

Session、attachment 和 AgentRun 身份彼此不同。一个 Session 可以跨越多个显式 Run
和普通原生对话。Goal 是 Session 级别的 Provider 证据，不是 Yui 的 Task 完成状态。

## Codex 与 Claude Code

受管 Codex 连接到共享的原生 daemon。Host 拥有自己的代理和 WebSocket，而不是那个
daemon 或原生线程。直接的原生客户端可以使用同一段对话；Yui 等待原生可用并关联自己
的输入，而不是把另一个客户端的终端当作自己的结果。

global Codex Role 保留原生 TUI。轻量交互 Host 观察 TUI 确切的 thread start/resume
身份，并把保留工作区、Role 设置、Manifest 指针和范围受限的 CLI 环境套用到同一个
原生启动请求上。仅有远程 TUI 标志不构成对服务器工作目录的权威；不创建第二个 Thread
或 daemon 范围的配置。仅有一个存活面板不建立已认证的 Session；一个死掉的面板在显式
动作前作为保留证据。

受管 Claude Code 使用持久的 stream-json 进程、精确的 user-message 关联以及一次
在途的本地输入。它的第一条 main assistant 响应在最终结果之前确认接受；init、用户
回显和子响应都不确认。message UUID 抑制重复观察，不用于标识原生 Turn。Yui 拥有的
通用 Role 上下文使用私有文件；Project Skill 仍是由 Agent 发现的原生 Project 材料。

global Claude Code 保留其交互界面和原生认证选择。Yui 转发已配置的环境和 settings
路径，不注入认证 helper，也不写入 onboarding/key 批准记录。原生确认与策略仍被强制。
参见[原生认证](roles-and-configuration.zh-CN.md#原生认证)。

主 Session 的工具 start/result 和模型活动为 Run 和无 Run 通知馈入同一份精确输入
观察。工具失败结束的是那一个操作，而不是整个 Agent 执行。缺失的活动证据保持未观察。
一个被拥有的 Claude 进程在没有结果的情况下退出会让其当前输入失败；有意取消则记录为
cancelled。二者都不编造原生 Turn ID。

原生观察在请求 Controller 套用之前就已持久排队。Controller 缺席、超时或传输丢失
会把这些确切事实留给正常的收件箱重放；它不会把一个健康的原生结果变成失败的 Host。
积极的 Controller 套用提示有一个很短的期限，因此一次中断不会为每个原生事件累积长
时间的同步等待。持久化或实际套用校验失败仍会作为错误浮现。终态输入证据随时间推移
仍是终态，独立于 Task 完成和之后的 Run。

受管输入使用结构化协议，而不是终端击键或 prompt 字形解析。终端 attachment 是一个
展示通道。

## ACP

ACP 协商初始化和 Session 能力，打开或加载一个确切的 Session，发送 prompt，观察更新
并映射终态/错误响应。认证要求和不受支持的操作保持显式。编解码器不得实现另一个
Task/Run Store，也不得编造原生 Turn ID。

model、effort 和权限请求依据 peer 提供的配置轴编译，并在套用后检查。setter 可以
改变其他轴；最终观察到的值在 prompt 之前仍必须满足请求的启动。
新建和加载 Session 都必须回报 `configOptions`（可以为空数组），配置只使用
`session/set_config_option`，不再支持 mode-only peer。仅确认调用、没有当前回报值
不能证明请求的配置已生效。未知的 ACP 产品不从另一个产品继承猜测的旁路模式。

Yui 区分三个配置层：

1. 期望的 Role/Agent 绑定；
2. 冻结的生效启动请求；
3. 实时的 Agent 自报配置，或 `unknown` / `unsupported`。

在已观察配置内，某个轴可以保持 `unobserved`。检查读取当前回报，不配置或提示 Agent。
被回报的模型名是 Provider 证据，不是后端模型身份的独立证明。

## 环境与替换

采用的执行环境保留其目录身份、access、preparation 和 grant。启动、resume 和 Yui
控制的提交都复核同一边界。期望环境的变更不会移动一个运行中的 Session，也不会静默
回退到受管 cwd。

只读采用需要适配器实际强制。empty 环境不能提供原生 CLI 的 cwd;scratch 或一个显式
采用的目录可以。trusted-local 环境不是通用 OS 沙箱。

一个 Session 固定其 Host 实际加载的 Endpoint 实现。新 Session 可以选择另一个实现；
已有引用在各自边界排空。排空期限只限定等待时长，不保证所有原生后代都退出。清理如实
报告未解决的所有权。

停止 Yui 的 attachment 不取消 Task、不抹除原生线程，也不证明共享执行已停止。冲突
资源释放之前必须先解决未知的原生效果。参见
[Session/Run](managed-turn-and-session-runtime.zh-CN.md)和
[Drivers](agent-runtime-drivers.zh-CN.md)。

Task Session 终止首先取消其确切的未结算输入，并在向 Host 发信号或释放占用之前要求
匹配的终态证据。Codex 使用原生中断；Claude 停止被拥有的执行进程。仅有一个中断确认
并不足够。若终态证据不可得，清理会明显受阻并保留原生输入身份；它不杀共享 daemon,
也不把未知执行标记为已停止。

专用 Claude 执行使用一个小型 Linux 子进程 subreaper。如果 CLI 死掉，内核会把它遗留
的孤儿工具重新挂到那个 owner 之下，包括创建了另一个进程会话的工具。该 owner 只对
自己的实际子进程发信号、回收它们，并在没有子进程后才退出。因此一个被杀的 CLI 不可能
在 Yui 报告其被拥有进程已结束的同时，还留下一个前台 Bash 工具在写入。排空失败仍是
一个活的所有权依赖，而不是虚假静止。这是 OS 进程托管，不是 Task 工作流，也不是关于
无关外部服务的断言。

专用进程的 PID/start 身份作为工程控制数据独立于 AgentHost 保留。恢复从不需要旧 Host
的内存连接。对 Codex，一个单独的元数据/控制客户端可以在不提交另一个 prompt 的情况下
检查并停止已记录的原生执行；未知接受可以在实际原生静止之后被放弃，而不编造原生 Turn
ID 或成功的 Run 结果。Codex 连接位置以及其原生握手回报的账号 Home 也在不含凭据的
情况下保留。恢复可以使用当前可执行代码，但在把缺失的 Thread 当作不存在之前会先验证
实际的原生账号。一个未经证明的连接不得把“未找到”变成停止回执。控制使用原生运行时
元数据，并在回执丢失时只取一页仅含元数据的 Turn，而不是加载整段对话。显式的 Session
停止会检查原生 Goal 和后台终端，即使 Yui 缓存的输入已经是终态。它绝不为恢复而启动
另一个模型 Turn。

## 验证边界

协议夹具可以在不调用模型的情况下确立分帧、配置、关联和范围受限的持久化。它们不证明
一个真实 peer 的工具权限、取消、并发或长时间运行行为。真实 peer 验证必须点明所测试
的组件、连接、配置和效果；它不意味着所有组件都支持等价行为。
