# 0.2.1 代码审查核对与修复

日期：2026-09-08。基于交付的 0.2.0 源码逐项复核读者反馈；行号会随修改移动，下表用文件和符号定位。

| 反馈 | 核对结论 | 处理与验证 |
| --- | --- | --- |
| CLI purge 绕过 MemoryService | 确认 | 新增 MemoryService.purge 和 purgeSchema，校验确认、截止时间和范围；CLI 经过 service，MCP 不增加物理删除工具。测试未确认、非法日期、跨项目及活动记录保留。 |
| bootstrap 通过 GraphService 取 repository | 确认 | 组合根直接实例化 graphRepository 并注入所需 service；GraphService 将 repository 改为 private readonly。Hybrid/Maintenance 通过 GraphService 方法调用，不再读取其内部仓储。 |
| restore 文件恢复 else-if 不可达 | 确认 | 删除重复分支；仍由 bootstrap 前的文件恢复路径处理损坏数据库。既有损坏数据库恢复测试继续覆盖。 |
| textSimilarity 没有引用 | 不成立 | DuplicateService.find 已导入并调用它计算字符三元组 Dice。保留实现，既有近重复识别测试继续覆盖。 |
| doctor 从未探测 FTS | 需修正 | 原版 openDatabase 启动时已实际创建 FTS5/trigram 临时表，成功启动后 doctor 才返回 true。现在抽出 probeFts，每次 doctor 再执行临时写入及 MATCH 查询，分别返回 fts5/trigram；测试缺失能力及清理。 |
| version.ts 重复硬编码版本 | 确认 | 运行版本读取相对模块路径定位的 package.json，源代码和 dist 都使用同一版本来源；CLI 帮助与源版本一致。 |
| HTTP 30 秒会终止长工具任务 | 超时语义需修正 | Node requestTimeout 限制接收请求，不限制收到正文后的工具执行。改成 http.requestTimeoutMs / headersTimeoutMs 可配置字段。实际 HTTP 测试将接收期限设为 50ms，工具执行跨过此期限后仍成功。客户端超时独立存在。 |
| idExists 没有 scope | 有意的全库主键检查 | 导入必须检查目标范围外的 ID 冲突，不能改成仅查当前 scope；重命名 hasGlobalIdCollision 并注明用途。跨 namespace/project 的 update 拒绝、copy 换 ID 的测试通过。 |
| link/mergeLinks 没有 scope | 确认仓储防线不足 | 上层原本已先查同 scope；现在仓储也要求 scope，并在同步事务中验证两端。merge 校验目标当前 hash/活动状态，允许已软删除的源记录；关系及实体转移继续受范围约束。直接调用仓储的跨域测试证明数据不变。 |
| markApplied 没有 scope | 确认仓储防线不足 | UPDATE 使用关联 Memory 的 namespace/project、当前 content_hash、活动状态及有效期约束，返回是否实际应用。测试错误范围、旧 hash、删除、过期和重复应用。 |
| metrics 没有 scope | 有意的全库操作指标 | 重命名 recordGlobalToolMetrics / recordGlobalImportMetrics，结果新增 metrics_scope: whole_database。知识计数继续按 scope；工具调用和近期导入汇总仍为全库。namespace/project 不能用于隐藏这些全库指标。 |
| 去重 8 MiB 与向量预算不一致 | 两类数据预算本来不同；硬编码可改进 | 新增 duplicates.maxCandidateBytes，默认 8 MiB，计算序列化 Memory 字节；向量仍用 embedding.maxVectorBytes。新增独立截断字段并汇总到 truncated，测试两种预算分别触发。两项预算均不是 RSS 上限。 |
| 配置权重与架构草案不一致 | 确认文档偏差 | 保留已实现的 importanceBoost/recencyBoost 和排名行为，修订架构 §30，存档原始架构；未实现的三个 Weight 字段不做伪兼容映射。search 校验改为 strict，未知字段明确失败。 |
| 重复 where/memoryWhere | 确认 | MemoryRepository 删除私有副本，与图谱和智能仓储共用 memoryWhere；既有 scope、TTL、FTS、标签和导出回归覆盖筛选行为。 |
| IntelligenceRepository.stats 返回类型松散 | 确认类型可改进 | 使用具名 IntelligenceStats、ToolMetric；三个计数转为 number，集合字段明确类型。其内容包含集合，不能整体改为 Record<string,number>。 |
| 不可重试 4xx 也计入熔断 | 确认 | 只累计耗尽重试的可重试错误；调用方取消不计数。测试连续 401/400/422 后正常调用成功、无额外重试；原 503 重试和网络超时熔断测试保留。 |
| 实例级事务 depth/异步交错 | 当前调用均同步，属于契约缺口 | 嵌套状态改为连接级 WeakMap，支持不同仓储实例共享连接。类型禁止 Promise 回调，运行时在调用前拒绝 AsyncFunction，返回 thenable 时回滚同步部分。测试跨实例嵌套提交、局部回滚、外层回滚及 dry-run。 |
| Embedding 维度懒推断竞态 | 当前实现无所述交错 | await 之后读取 dims、校验整批及写回之间没有异步让出点。同一实例以首个有效响应固定维度，后续不再写回相同值；用受控并发响应反转顺序，验证不兼容维度被拒绝且已推断维度保留。 |
| docs/README 索引遗漏 | 确认 | 补齐当前使用指南、状态、验证、本次审查及历史文档，并注明阅读顺序。 |
| 扩展核对：importOrigin 可解析到已移出 scope 的记忆 | 新确认的问题 | 来源查询同时验证当前 Memory scope，避免在原项目再次导入时被错误当作已导入而跳过；添加移动后重新导入回归。 |

## 并发和超时边界

SQLite 事务回调必须同步完成，也不得启动脱离回调的异步工作。运行时拒绝返回 Promise 只能回滚同步执行部分，无法取消不守契约的调用方自行安排的后续任务；不能把它当作任意 JavaScript 的隔离沙箱。所有现有模型请求都在事务之外，完成后使用短事务和版本校验落库。

Embedding 维度的无交错结论针对当前单个 JavaScript 实例。若以后把解析/校验改成异步、跨 Worker 共享状态，须重新审查。显式配置 dimensions 仍然受同样的响应校验。

HTTP 接收期限、Provider 单次请求期限、MCP 客户端工具期限是不同边界。客户端断开或超时不等于服务端取消工作。长批次建议使用 CLI 或分批游标，不能仅调大 HTTP 接收期限解决客户端超时。

## 验证结果

Linux / Node.js 24.19.0 / pnpm 11.19.0：类型检查和构建通过，全量 73 项测试通过（比 0.2.0 新增 15 项），0 失败、0 跳过。配置示例通过 doctor 的写入、FTS5/trigram、schema 104 和完整性检查。

## 兼容与交付

- 应用版本更新到 0.2.1；数据库 schema 保持 104，无新增迁移。
- 原有 27 个 MCP 工具保留。新增诊断、去重截断和指标范围字段，不改原字段含义。
- 新增 duplicates/http 配置均有默认值。已有有效 0.2.0 配置继续可用；原先被静默忽略的未知 search 字段会报错。
- TypeScript 内部仓储接口有所调整；自定义适配器需更新 scope 参数、全库方法名及统计类型。
- 原始 REQUIREMENTS.md 未改动；原始 ARCHITECTURE.md 原样存档为 ARCHITECTURE-v1.0.md。
- 当前本地验证结果见 [VALIDATION.md](VALIDATION.md)。Windows 实机、真实模型和大规模性能仍未验证。
