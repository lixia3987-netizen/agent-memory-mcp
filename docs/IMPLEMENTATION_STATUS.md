# 实现状态：0.2.7

日期：2026-09-10。基于用户提供的一期/二期需求和架构，以及已交付的 0.1.0 继续实现。

## 本次结果

PR #1 已合并到 main（55c0cb3）。合并后的基线 145 项测试通过；本次按原始需求重新检视实现，修复脱敏后越过正文/标题/metadata 大小上限的问题，新增 4 项策略回归、3 项时间回归和 1 项启用模型的完整 MCP 工作流，当前本地 153/153 测试通过。完整覆盖矩阵、主分支 CI 结果和可用性结论见 [REVIEW-v0.2.7.md](REVIEW-v0.2.7.md)。0.2.7 不新增依赖、配置或迁移，schema 仍为 105。

同时修复未来来源时钟下的时间倒退：普通更新、删除、恢复和缺失时间字段的导入更新保持 updated_at 不早于创建时间及上次更新时间；显式倒序来源时间继续拒绝。

代码 `2bdb5ee` 的 [Windows/Ubuntu 主分支 CI](https://github.com/lixia3987-netizen/agent-memory-mcp/actions/runs/34469688900) 各 153/153 测试通过，doctor/init、smoke、50k/100k 基准及 release-gate 全部成功。Windows runner 为 Server 2025，用户 Windows 10/11 实机客户端和真实供应商仍待联调。当前可本地使用/小规模试运行，正式 Release 的全部验收仍未完成。

本轮 Windows 50k 英文 FTS P95 159.98ms、100k 并发 stats P95 122.80ms，超过相应 150/100ms 建议值；完整对照见复验报告。后续 0.2.6/0.2.5 小节保留历史实施记录。

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
| P2-12 Windows 回归 | **本轮 CI 通过，用户实机待验** | main 代码 2bdb5ee 执行 153 项测试、doctor/init、smoke 和 5 万/10 万条基准，全部成功 |

## 0.2.6 FTS 性能修订

- 一条 SQL 物化选页，先对全部合格记录评分，再按 rowid 读取页面正文和摘要；不提前截断候选。
- 外层固定从小页面开始连接，保留 FTS MATCH 上下文；英文、中文长词/混合短词及全短词均使用相同分页语义。
- 对照冻结的 0.2.5 查询，验证完整 SearchHit、分数、摘要、稳定排序、所有过滤和更新/删除/恢复/TTL。
- 新增 benchmarks/search.mjs 与跨平台 CI 基准，保存每次采样、执行计划及 HTTP 事件循环数据。新增 schema 105 覆盖索引，升级先备份；无新增运行依赖或必填配置。

- MCP/CLI 词法查询使用单个只读工作线程，预算默认 20、总期限默认 30 秒；执行超时后旧线程未退出前不启动替代线程，关闭会排空已接受任务。同步服务接口和真正 hybrid 融合仍保留同步词法阶段。
- schema 105 的覆盖索引避免统计反复读取正文页，保留已有统计过滤规则。

## 0.2.5 独立审查修订

- 合并仅给版本仍匹配且未退休的关系迁移来源；旧来源和目标的 stale 关系、已结束/删除/inactive 关系保留原证据。未来生效的 supersede 仍遵守原区间。
- 原样拼接且策略未改写正文时可保留有效关系；自定义正文或脱敏改写后，需要显式复核或重新 enrichment，不自动给旧关系换上新 hash。
- HTTP transport 在工具结果处理完后统一关闭、释放名额；客户端断开不绕过实际工作并发预算。shutdown 先等任务结束再关闭应用数据库。
- token 字段与 password 一样支持拒绝/脱敏，完整占位符、JSON 结构和普通 token 术语保持兼容。
- 无新增依赖、配置或 migration。已有错误合并产生的关系不自动修写，需依据原快照/正文重新核验。

细节见 [REVIEW_FIXES-v0.2.5.md](REVIEW_FIXES-v0.2.5.md)，性能工作单独见 [PERFORMANCE_PLAN.md](PERFORMANCE_PLAN.md)。

## 0.2.4 审查修订（历史）

复核本轮 7 个编号（2/6 同根因），修复完整脱敏占位符跨模式兼容、凭据内部/外层引号处理、派生统计有效来源、导入指标保留 100 行、Unicode 码点三元组和空 frontmatter。新增 12 项测试，包含更新/导入/合并、JSON 转义组合、恢复与 TTL 边界等，全量 124 项通过。无需新增配置或迁移。详见 [REVIEW_FIXES-v0.2.4.md](REVIEW_FIXES-v0.2.4.md)。

## 0.2.3 审查修订（历史）

修复本轮 8 项反馈，包括上轮 parallel 更新和 enrichment 重试回归。冲突只处理当前有效且新增的重叠，重试默认最多 3 次，来源 hash 与当前正文核对，软删更新跳过，中文长词索引与短词过滤组合，脱敏保留引号，关系冲突引用独立限额。新增 18 项回归测试，全量 112 项通过，schema 仍为 104。详见 [REVIEW_FIXES-v0.2.3.md](REVIEW_FIXES-v0.2.3.md)。

## 0.2.2 审查修订（历史）

复核并修复本轮 15 项问题：凭据检测与 metadata 脱敏、活跃去重排除过期记录、关系更新冲突及封存历史保护、imports strict 与路径/IO 校验、导入时间戳和缺失字段合并、enrichment 可重试任务保留、迁移备份锁范围、历史查询和别名一致性、受限文件读取。详见 [REVIEW_FIXES-v0.2.2.md](REVIEW_FIXES-v0.2.2.md)。

新增 21 项测试，本地全量 94 项通过；保留 schema 104 和既有依赖。另修复上次 Windows CI 暴露的测试资源清理顺序，并增加测试/CI 超时上限。本次 [Ubuntu/Windows Actions 与 release-gate](https://github.com/lixia3987-netizen/agent-memory-mcp/actions/runs/34430296053) 均通过，验证的是代码提交 897d6fb。

## 0.2.1 审查修订（历史）

本次复核全部读者反馈，修复 CLI purge 分层、不可达恢复分支、仓储 scope 校验、导入来源查询、熔断计数及重复筛选代码；增强同步事务契约、FTS 诊断、统计类型和配置说明。运行版本统一读取 package.json，GraphService 不再公开 repository。

新增 15 项回归测试，全量 73 项通过。textSimilarity 已有调用、Embedding 维度校验同步段无交错，以及 HTTP 接收超时的含义，均已核对并保留准确结论。完整逐项说明见 [REVIEW_FIXES-v0.2.1.md](REVIEW_FIXES-v0.2.1.md)。

从 0.2.0 升级不增加迁移，schema 保持 104。新增配置均有默认值；未知 search 字段现在明确报错。

## 数据升级

保留已发布迁移 1/2/3，追加 101/102/103/104/105。当前 schemaVersion 为 105。升级前自动备份，事务内迁移，失败回滚并拒绝写模式。测试覆盖带真实一期 Memory 的 schema 3 升级、原字段不变、升级前 v3 备份和失败回滚。

默认配置兼容一期。新增秘密检测默认拒绝匹配的凭据，但不会扫描/改写存量记录。已经建立图谱链接的 Memory 不允许静默移动 project，需要先显式解绑。

## 本地验证

- Node.js 24.19.0 / TypeScript 5.9.3 / pnpm 11.19.0 / Linux。
- 官方 MCP TypeScript SDK 1.30.0，未新增需原生构建的依赖。
- pnpm typecheck、pnpm build、pnpm test 通过。
- 153 项测试通过，0 失败、0 跳过；详见 VALIDATION.md。
- 真实 stdio/HTTP MCP 客户端和本地模拟供应商 HTTP 联调均通过。
- 所有测试使用临时数据，不调用真实云模型，不读写用户的记忆数据。

## 明确边界

1. Windows CI 以本次分支/提交结果为准；用户 Windows 10/11 实机与实际客户端尚未联调；未连接用户真实 Embedding/LLM，模型质量、费用、限流、专有格式尚未验证。
2. 旧查询 5 万条高命中率英文 FTS P95 约 318ms；0.2.6 已实施两阶段 SQL，新增 5 万/10 万 Memory 的可重现旧新对照及 HTTP 并发基准。最新复验 5 万条英文 FTS P95 Ubuntu 77.66ms / Windows 159.98ms，Windows 超过 150ms 建议值；Windows 10 万条并发 stats 122.80ms 也超建议目标，详见 PERFORMANCE_PLAN.md；10 万 Entity/50 万 Relation、真实语料和模型仍未验收，不能宣称达到全部 P95/RSS 目标。
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

接下来在用户目标 Windows 10/11 上确认安装及实际客户端接入；然后配置真实模型跑小规模联调，最后按实际数据库规模测性能。源码仓库为 [lixia3987-netizen/agent-memory-mcp](https://github.com/lixia3987-netizen/agent-memory-mcp)，Ubuntu/Windows CI 结果以 [GitHub Actions](https://github.com/lixia3987-netizen/agent-memory-mcp/actions) 为准。当前未发布 npm 包。

历史记录：IMPLEMENTATION_STATUS-v0.1.0.md、VALIDATION-v0.1.0.md、IMPLEMENTATION_STATUS-v0.2.0.md、VALIDATION-v0.2.0.md。使用说明：PHASE2_GUIDE.md。
