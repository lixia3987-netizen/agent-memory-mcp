# 性能修复实施与验证 · 0.2.6

日期：2026-09-10。两阶段 SQL、统计覆盖索引和有界只读搜索线程均已进入正式代码；145 项本地检查通过。5 万/10 万条正式基准和当前提交的 Windows/Linux CI 结果在本轮完成后补录。不能沿用旧原型的 72.88ms 作为正式实现数字。

## 已实施

1. **FTS 两阶段查询**：一条 SQL、同一快照与评分时间，完整过滤/评分后物化 rowid/score 页面，最后读取正文和 snippet。外层 CROSS JOIN 从小页面开始，按 rowid 读取 FTS，保留 MATCH 上下文和稳定排序。没有固定 100 条的提前召回截断。英文、中文、混合短词和全短词路径均适配。
2. **统计覆盖索引**：实测 memory_stats 在 5 万条、未启用模型时约 250ms；原执行计划按内容 hash 顺序反复读取正文所在数据页。schema 105 增加 `(namespace,project,deleted_at,expires_at,id,content_hash)` 索引，让记忆和派生计数可直接使用覆盖索引；原 scope、hash、删除和到期过滤不变。升级先自动备份，原迁移不修改。
3. **单个只读搜索线程**：10 万条同步搜索仍会拖延轻量请求，因此 MCP/CLI 词法搜索、hybrid 的 lexical 模式及供应商失败后的 lexical 回退改用独立 SQLite 只读连接。主线程保持协议、写入与统计。只在线程首次被用到时启动；无网络和外部服务依赖。

线程默认最多接受 20 项工作（执行 + 排队），从提交起默认 30 秒期限。排队超时移除；执行超时向调用方返回可重试 DATABASE_BUSY，但旧线程未真正退出前保留执行槽，不启动替代线程。关闭拒绝新工作并排空已接受的任务，随后关闭线程连接。MCP 客户端断开仍受 HTTP 与线程两层工作预算约束。

新增配置 `search.workerEnabled=true`、`workerQueueLimit=20`、`workerTimeoutMs=30000`，均有默认值。同步嵌入式调用 `memory.search()` 保留；异步接口是 `memory.searchAsync()`。真正 hybrid 的向量/图谱融合仍保留现有同步词法阶段，本轮不宣称已完成整个 hybrid 的响应性优化。

## 如何重现

```text
pnpm install --frozen-lockfile
pnpm check
pnpm benchmark:search
```

默认输出 `test-results/search-benchmark.json`。可通过 BENCHMARK_SIZES 设置递增规模（1000–100000，默认 50000,100000），BENCHMARK_SAMPLES 设置采样次数（至少 30，默认 30）。BENCHMARK_ORDER=tied 使用相同更新时间作为低开销对照；默认逐条递增时间，模拟不断追加更新的记录。各平台环境变量按本机 shell 设置。

- 创建全新临时库；50k 后继续加到 100k。同 namespace、null project、混合中英文、确定性 ID 和正文，模型关闭。使用 MemoryService.createRecord 同步小事务写入，结束后移除临时库。
- 每个查询 3 次预热、30 次旧新交替计时。测量编译后的服务参数校验、SQL 和解码；每次结果与冻结的 0.2.5 查询逐字段比较，含 score/snippet/顺序。第一调用单列记录，不称为真实冷盘测量。
- 统计分别测原 idx_memory_hash 执行计划与新覆盖索引，逐次验证计数相同。模型关闭意味着派生表为空，这不等于验证了大规模向量/增强表。
- HTTP 客户端与服务在不同进程。每次搜索进入后，客户端并发发出 memory_get 和 memory_stats；3 轮预热、30 轮采样。旧 FTS 为同步路径，新 FTS 用正式工作线程；**两个 HTTP 对照均使用新统计索引**，避免将统计改进混入线程收益。
- 原始 JSON 保存全部分布、SQLite/Node/CPU、RSS、文件大小及实际编译 SQL 的 EXPLAIN QUERY PLAN。CI 在 Ubuntu/Windows 执行相同脚本并上传 search-benchmark-* artifacts。

## 验收解释

5 万条常见英文 FTS P95 ≤150ms 是原建议目标；并发轻量请求 P95 ≤100ms 是本次新增目标。共享 CI runner 的速度有波动，CI 硬门禁验证结果一致性和正常完成；目标与实际数值单独判定，绿灯本身不等于性能 SLA。

等价性回归覆盖所有过滤、namespace/project=null/all_projects、TTL 临界、软删/恢复、更新/回滚、标题/标签/类型/项目命中、中英/混合/全短词、标点字面词、同分稳定顺序、100/101 内部候选、深分页及返回字段。线程另验证期限、容量、故障和关闭；schema 104 升级验证原记录与备份。

已发现收益依赖排序输入：同分、相同更新时间且按 ID 顺序命中时，旧 SQLite 查询可以跳过不少昂贵投影，两阶段不保证更快，少量固定开销也可能略增；持续追加新记录、每条候选都更新 top page 时，宽列/摘要成本更明显。报告保留这个边界。

## 剩余边界

真实脱敏语料、长正文和高并发多读多写、10 万 Entity/50 万 Relation、已填充的大规模向量及 hybrid 融合仍需单独负载验收。工作线程改善协议响应，不降低 SQL CPU；会增加查询后的常驻 RSS。用户 Windows 10/11 实机和实际模型客户端仍需联调，不把 Windows runner 当作用户设备。
