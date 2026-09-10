# Agent Memory MCP 文档索引

当前实现版本为 0.2.2，包含一期和二期核心能力。

| 文档 | 用途 |
| --- | --- |
| [项目 README](../README.md) | Windows 安装、启动、MCP 接入和升级 |
| [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md) | 当前已实现能力、边界及未完成验证 |
| [PHASE2_GUIDE.md](PHASE2_GUIDE.md) | 模型、图谱、时间事实、去重、维护与 HTTP 使用 |
| [VALIDATION.md](VALIDATION.md) | 当前版本的本地验证证据 |
| [REVIEW_FIXES-v0.2.2.md](REVIEW_FIXES-v0.2.2.md) | 本轮 15 项缺陷的修复、兼容变化与回归证据 |
| [REVIEW_FIXES-v0.2.1.md](REVIEW_FIXES-v0.2.1.md) | 前一轮代码审查的逐项核对、修复与兼容说明 |
| [REQUIREMENTS.md](REQUIREMENTS.md) | 用户提供的一期和二期完整需求，保留原文 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 架构设计；v1.1 更新了配置字段勘误 |
| [ARCHITECTURE-v1.0.md](ARCHITECTURE-v1.0.md) | 压缩包中的原始架构设计，保留原文 |
| [一期实现记录](IMPLEMENTATION_STATUS-v0.1.0.md) / [一期验证记录](VALIDATION-v0.1.0.md) | 0.1.0 历史快照 |
| [二期初版实现记录](IMPLEMENTATION_STATUS-v0.2.0.md) / [二期初版验证记录](VALIDATION-v0.2.0.md) | 0.2.0 历史快照 |

0.2.1 历史快照：[实现记录](IMPLEMENTATION_STATUS-v0.2.1.md)、[验证记录](VALIDATION-v0.2.1.md)。

开发阅读顺序：项目 README → IMPLEMENTATION_STATUS → PHASE2_GUIDE → 本次审查记录；再按需查阅需求、架构和验证记录。配置字段以 [config.ts](../src/app/config.ts)、[phase2-config.ts](../src/domain/phase2-config.ts) 及 [配置示例](../examples/config.phase2.json) 为准。

最终目标是 Windows 10/11 x64 原生运行，必需运行时为 Node.js 24.x；核心不依赖 Docker、WSL、虚拟机、外部数据库、Python 或 JDK。LLM、Embedding 和 HTTP 默认关闭。Windows 验证状态请以当前验证记录为准。
