# 接口与数据契约

## 使用方式

[model.ts](model.ts) 定义模块之间最少需要共享的结构；[examples.ts](examples.ts) 展示配置切换、结果引用、调用和插件配置；[capabilities.json](capabilities.json) 是设计级能力目录。

这些是目标接口，不是当前发布 SDK。接口展示哪些信息应有明确所有权，不要求建立相同名称的类、服务或数据库表。已有实现可以通过 adapter 满足契约。

## 设计边界

Task、Role、Turn 和 Candidate 是不同对象。Role 的当前配置可以更新，Session 和 Turn 记录实际使用的配置。Candidate 不引用一个可执行插件句柄；仅保留来源说明和结果引用。

`revision` 用于记录并发更新；它不具有自动判断业务过期的含义。接受操作不要求所有来源的 revision 与当前状态相同。

只读调用不需要持久化操作账本。外部操作需要 requestId 和可核对的处置。`effect` 与 `outcome` 分开，失败可以伴随已经发生的效果。

Endpoint 的本地 attemptId 与可选 nativeTurnId 分开。实现只能填入实际观察到的原生身份，不能用生成 UUID 冒充原生回执。

Plugin scope 仅有 global、project、task。Manifest 不能自行决定自己是受信任代码；运行信任由宿主根据实际授权和环境产生。

## 共享入口

能力目录使用名称、输入输出 schema、效果类型和 Provider 来源描述工具。核心模块内部可以使用 typed port；Surface 和外部 Agent 经同一可信入口认证，不在 capability input 中自带可生效的 actor 身份。

接口中的 `TrustedCallContext` 是宿主传入的对象。TypeScript 类型不构成安全机制，实际进程或协议入口必须验证身份与授权。

## 类型检查

在包根目录、有 TypeScript 编译器的环境中执行：

```sh
tsc --strict --noEmit --target ES2022 --module commonjs \
  contracts/model.ts contracts/examples.ts
```

类型检查只能确认声明和样例匹配。原生协议、存储迁移、权限、隔离和停止行为分别由[验收场景](../reference/acceptance-scenarios.md)验证。
