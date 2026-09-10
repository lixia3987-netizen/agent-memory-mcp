# 本地验证记录 · 0.2.4

验证日期：2026-09-10。正式发布验证尚未完成。

| 项目 | 结果 |
| --- | --- |
| 平台 | Linux |
| Node.js | 24.19.0 |
| pnpm | 11.19.0 |
| TypeScript | 5.9.3 |
| MCP SDK | 1.30.0 |
| pnpm typecheck | 通过 |
| pnpm build | 通过 |
| pnpm test | **124 通过 / 0 失败 / 0 跳过** |
| 最终全套测试耗时 | 约 3.93 秒，仅代表此测试套件 |
| Windows | [代码 21cb926 的 CI](https://github.com/lixia3987-netizen/agent-memory-mcp/actions/runs/34456011313)：124 通过 / 0 失败 / 0 跳过；doctor/init 与 smoke 通过 |
| 远端汇总 | Ubuntu、Windows、release-gate 均 success |
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
| integration/review-v024.test.ts | redact→reject 的 update/import/merge、占位符边界、自定义规则、裸值/引号/转义组合/大整数 JSON、派生统计软删/恢复/TTL/作用域、100 行保留与 ID 缺口、emoji 阈值、空 frontmatter 与正文分隔符 |
| integration/review-v023.test.ts | 失效事实、parallel 更新、新重叠、来源刷新/LLM apply、任务次数/租约/作用域、真实 HTTP 429/500 与熔断、导入回退/软删/恢复、JSON 脱敏、450 条冲突引用和 1000 引用上限、混合中文查询 |
| integration/review-v022.test.ts | 凭据标点/短值/容器、TTL 到期与边界、导入合并/默认值/回滚、关系重检/历史/别名、enrichment 临时与永久故障 |
| integration/io-review-v022.test.ts | imports 拼写、所有路径来源、配置 IO 分类、读取增长上限、迁移无写锁备份/并发提交重拍/双连接迁移竞争 |
| unit/domain.test.ts | 类型/大小/时间/规范化/排序/配置优先级/安全错误映射 |
| unit/importers.test.ts | Markdown frontmatter、代码围栏、分段稳定、Claude 来源、非法输入 |

本次相对 0.2.3 新增 12 项测试。最初 11 项在未修复代码上全部失败，修复后通过；额外加入 24 组引号/转义组合，校验 JSON 可解析、无秘密残留、重复脱敏及 reject 兼容，另校验敏感 JSON 容器/数字/布尔值。空 frontmatter 额外覆盖正文中的后续分隔线，避免跳过首个关闭标记。

最终执行 pnpm check（typecheck → build → test），124 通过、0 失败、0 跳过；测试耗时 3927.337027ms，只代表测试套件。已核对 [代码 21cb926 的 CI 日志](https://github.com/lixia3987-netizen/agent-memory-mcp/actions/runs/34456011313)：Ubuntu 与 Windows 均 124 通过、0 失败、0 跳过，测试耗时分别约 7.92 秒和 13.88 秒；doctor/init 的 schemaVersion 为 104、integrity 为 ok，smoke 与 release-gate 通过。后续仅提交验证文档，源代码与测试不变。Windows 测试资源逆序关闭、测试上限 60 秒、矩阵 job 上限 15 分钟继续保留。

运行命令：

```text
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test
```

未验证：用户 Windows 10/11 实机环境与实际客户端、大型数据库 P95/RSS、长时并发压力、真实供应商模型质量。Windows CI 通过不代表这些验证已完成。
