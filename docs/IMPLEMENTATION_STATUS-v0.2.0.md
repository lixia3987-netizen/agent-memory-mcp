# 实现状态：0.2.0

日期：2026-09-08。基于用户提供的一期/二期需求和架构，以及已交付的 0.1.0 继续实现。

## 本次结果

二期核心代码已实现，保留一期 8 个工具，总计 27 个 MCP 工具。Linux 本地类型检查、构建和 58 项测试通过。Windows 原生、真实供应商模型和规模性能尚待验证，因此尚未满足正式 Release 的全部完成定义。

| 阶段 | 状态 | 实现与证据 |
| --- | --- | --- |
| 一期兼容性 | 已实现并回归 | 原 8 工具、隔离、FTS、导入导出、维护、备份与恢复继续可用 |
| P2-0 Provider 抽象 | 已实现 | 可替换 EmbeddingProvider/LlmProvider；默认关闭 |
| P2-1 Embedding 存储 | 已实现并测试 | Float32 BLOB、模型隔离、维度校验、正文 hash 失效、CAS 写入、游标分批重建 |
| P2-2 Hybrid Search | 已实现并测试 | lexical/semantic/hybrid、RRF、可选图谱上下文、筛选与失效回退 |
| P2-3 Entity / Relation | 已实现并测试 | SQLite、实体别名、scope 隔离、关联、软删除与恢复 |
| P2-4 图查询 | 已实现并测试 | 有向/无向 BFS、路径、深度 ≤ 3、节点/边上限和截断状态 |
| P2-5 时间事实 | 已实现并测试 | 当前事实、指定时间、历史区间；来源正文修改后仍能查旧事实 |
| P2-6 Conflict / Supersede | 已实现并测试 | 明确保留、并行或替代；历史保留、区间边界和未来生效 |
| P2-7 智能去重 | 已实现并测试 | 文本 Dice / 缓存向量、候选报告、合并预览 token、原快照与来源保留 |
| P2-8 LLM Enrichment | 已实现并测试 | HTTP JSON 输出校验、显式图谱 apply、正文保护、持久任务与租约 |
| P2-9 Importer 插件接口 | 已实现并测试 | extensions / detectVersion / parse / register；JSON、Markdown、Claude Code |
| P2-10 Policy / Maintenance / Metrics | 已实现并测试 | 秘密规则、大小/来源/类型/TTL 等策略；维护与本地指标 |
| P2-11 可选 HTTP | 已实现并测试 | 官方 SDK 无状态 Streamable HTTP、loopback、令牌和 Host/Origin/大小/并发限制 |
| P2-12 Windows 完整回归 | **待执行** | 继承 Ubuntu/Windows Node 24 CI；当前环境没有 Windows |

## 数据升级

保留已发布迁移 1/2/3，追加 101/102/103/104。当前 schemaVersion 为 104。升级前自动备份，事务内迁移，失败回滚并拒绝写模式。测试覆盖带真实一期 Memory 的 schema 3 升级、原字段不变、升级前 v3 备份和失败回滚。

默认配置兼容一期。新增秘密检测默认拒绝匹配的凭据，但不会扫描/改写存量记录。已经建立图谱链接的 Memory 不允许静默移动 project，需要先显式解绑。

## 本地验证

- Node.js 24.19.0 / TypeScript 5.9.3 / pnpm 11.19.0 / Linux。
- 官方 MCP TypeScript SDK 1.30.0，未新增需原生构建的依赖。
- pnpm typecheck、pnpm build、pnpm test 通过。
- 58 项测试通过，0 失败、0 跳过；详见 VALIDATION.md。
- 真实 stdio/HTTP MCP 客户端和本地模拟供应商 HTTP 联调均通过。
- 所有测试使用临时数据，不调用真实云模型，不读写用户的记忆数据。

## 明确边界

1. 未在 Windows 执行，未连接用户的真实 Embedding/LLM；模型质量、费用、限流、专有格式尚未验证。
2. 未执行 5 万/10 万条 Memory、10 万 Entity/50 万 Relation 的性能基准，不能宣称达到原文档 P95/RSS 目标。
3. 默认向量检索是受数量与内存预算约束的本地余弦计算，不是 ANN 或 SQLite 向量扩展；结果可截断。
4. memory_at_time 查询关系事实，未实现所有 Memory 正文的通用版本历史；合并原快照另行保存。
5. memory_export 继续为 schemaVersion 1 的 Memory 导出。完整图谱/向量/任务/合并快照使用整个数据库 backup/restore。
6. LLM apply 只写派生图谱，不自动改写原 Memory 字段；不会自动破坏性消解冲突或合并。
7. Importer 通过代码注册，没有动态安装任意模块。Cursor/Codex/Hermes 的原生记忆格式尚未获得，不提供猜测实现；可先用通用 JSON/Markdown。
8. HTTP 仅限 loopback 且要求令牌，当前没有远程公开部署能力，也没有 SSE 常驻订阅。
9. Enrichment 任务持久化并可恢复，但没有隐式后台常驻 worker 或系统定时任务；由 run/maintenance 显式触发。
10. 图谱 orphan 维护使用软删除，保留历史链接；物理 Memory purge 仍独立且要求 CLI 显式确认。
11. 秘密信息规则不是完整 DLP，自定义正则属于本机可信配置。日志不包含正文、Key 或供应商原始错误内容。
12. SDK 参数协议错误沿用 SDK 的错误格式；业务错误使用结构化 AppError。

## 后续验证

优先执行目标 Windows 的 pnpm install --frozen-lockfile、typecheck、build、test，并验证实际客户端接入；然后配置真实模型跑小规模联调，最后按实际数据库规模测性能。当前未创建/推送远程仓库或发布 npm 包。

历史记录：IMPLEMENTATION_STATUS-v0.1.0.md、VALIDATION-v0.1.0.md。使用说明：PHASE2_GUIDE.md。
