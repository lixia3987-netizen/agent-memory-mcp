# 本地验证记录 · 0.2.1

验证日期：2026-09-08。正式发布验证尚未完成。

| 项目 | 结果 |
| --- | --- |
| 平台 | Linux |
| Node.js | 24.19.0 |
| pnpm | 11.19.0 |
| TypeScript | 5.9.3 |
| MCP SDK | 1.30.0 |
| pnpm typecheck | 通过 |
| pnpm build | 通过 |
| pnpm test | **73 通过 / 0 失败 / 0 跳过** |
| 最终全套测试耗时 | 约 7.69 秒，仅代表此测试套件 |
| Windows | 尚未执行，提供 CI 矩阵 |
| 真实云模型 | 尚未联调；HTTP 合约使用本地模拟服务验证 |

## 测试文件与覆盖

| 文件 | 覆盖重点 |
| --- | --- |
| contract/mcp.test.ts | 真实构建产物 stdio 握手、全部 27 个工具、一期调用语义、业务错误、不泄露正文日志 |
| contract/http.test.ts | HTTP 显式启用、禁止远程绑定、令牌、Host/Origin、大小限制及真实 SDK 调用；接收期限之后的长工具调用仍能完成 |
| integration/database.test.ts | 迁移前备份、未知 schema、迁移回滚、备份恢复、不覆盖现有数据 |
| integration/phase2-upgrade.test.ts | 带一期存量数据的 v3→v104 迁移及 v3 备份；持久任务重启恢复 |
| integration/concurrency.test.ts | 四进程并发启动/读写，避免去重竞争 |
| integration/memory.test.ts | CRUD、持久化、scope、TTL、软删除、恢复、purge、FTS、中文、事务回滚 |
| integration/import-export.test.ts | JSON/Markdown 往返、dry-run、冲突策略、Claude 项目隔离、目录/大小/符号链接限制 |
| integration/cli.test.ts | 构建后 CLI、输出保护、purge 守卫、导出大小、损坏数据库恢复 |
| integration/graph.test.ts | 实体别名/去重/恢复、范围、时间边界、未来替代、历史来源变化、冲突、遍历、路径、失效事实 |
| integration/intelligence.test.ts | 禁用降级、语义匹配、筛选、向量 CAS/失效/批校验/游标、RRF 图补充、合并校验、LLM apply、失败与租约 |
| integration/policy-maintenance.test.ts | 写入策略、秘密拒绝/脱敏、维护预览/提交、派生链接失效、purge 不复活事实、Importer 注册与版本 |
| integration/providers.test.ts | 真实本地 HTTP 请求、向量索引重排、Key 不落库、重试/超时/熔断、LLM JSON 校验；4xx/取消不触发熔断、并发响应维度一致性 |
| integration/review-regressions.test.ts | 仓储跨域拒绝、markApplied 活动/版本约束、导入 ID 冲突及来源移动、service purge 守卫、跨仓储嵌套事务和异步契约、真实 FTS 探测、独立预算、统计范围及配置校验 |
| unit/domain.test.ts | 类型/大小/时间/规范化/排序/配置优先级/安全错误映射 |
| unit/importers.test.ts | Markdown frontmatter、代码围栏、分段稳定、Claude 来源、非法输入 |

额外验证：使用 `examples/config.phase2.json` 启动构建后的 doctor，writable/fts5/trigram 均为 true，schema 104、SQLite 3.53.3、integrity=ok、WAL；未启用模型调用。

本次相对 0.2.0 新增 15 项测试。针对性测试后执行了一次完整 typecheck/build/test，73 通过、0 失败、0 跳过，耗时 7690.890589ms。后续仅更新验证文档和打包，未改源码。

运行命令：

```text
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test
```

未验证：Windows 原生、大型数据库 P95/RSS、长时并发压力、真实供应商模型质量及不同产品客户端配置。不得将这些本地结果当作 Windows Release Gate 已通过。
