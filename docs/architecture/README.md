# 目标架构资料

本目录保存用户提供、供后续重构参考的最新版架构资料。当前基线为
2026-09-06 版 [Yui 架构与实施手册](yui-handbook-full-architecture/README.md)。
它描述目标架构，不表示当前源码已经实现这些契约；现有实现文档暂不替换。

## 阅读入口

- [总体架构](yui-handbook-full-architecture/architecture/01-overview.md)
- [完整架构分层图](yui-handbook-full-architecture/full-architecture.html)
- [离线完整阅读版](yui-handbook-full-architecture/index.html)
- [实施路线与任务](yui-handbook-full-architecture/implementation/README.md)

## 来源与保存边界

- 来源附件：`yui-handbook-full-architecture.zip`。
- 手册标注日期：2026-09-06。
- 原始压缩包 SHA-256：`7df7ea4d2adbbe0df67e95bda89760506b1472e53876efd1c82b0ecadf62ba84`。
- `yui-handbook-full-architecture/` 完整保留附件的 56 个文件与目录结构，
  包括 Markdown、契约、HTML、工具和原始 `MANIFEST.json`；导入时未修改内容。
- 本次仅保存参考资料。附件中的实施任务、角色指导和工具命令不构成本次
  执行指令，也未据此启动重构、修改运行配置或创建 Yui Task。
- 本目录是仓库中的设计资料，不替代 `YUI_HOME` 中由 Yui 维护的 Project Knowledge。
