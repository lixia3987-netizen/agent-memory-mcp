# FTS 性能修复方案

日期：2026-09-10。状态：**完成基准和只读 SQL 原型，生产查询尚未替换**。对应独立审查 R4；实现位置为 src/infra/sqlite/memory-repository.ts 的 search()。

## 目标与证据

保留 SQLite、Node.js 24 和 FTS5，先优化现有词法查询。此问题不要求新增外部向量数据库或改变模型配置。

目标为原需求建议的“5 万条普通 FTS P95 ≤150ms”，同时保留全部词 AND、scope、TTL/软删除、标签等过滤、BM25/重要度/新近度权重、分页与稳定排序。这是建议目标，不把一次单机通过当作所有环境 SLA。

Linux / Node 24.19.0 / AMD EPYC 9V74，可见 9 个逻辑 CPU。50,000 条唯一中英混合正文，另加 100 条独立写入样本；相同 namespace、null project。SQLite 匹配 50,000 条，topic0042 匹配 50 条。原审查 30 次采样的高命中率查询 P95 约 318ms。

之后对同一数据库建立只读连接，固定评分时间，每个变体预热 3 次、采样 20 次，limit=10、offset=0：

| 查询 / SQL 变体 | P50 | P95 |
| --- | ---: | ---: |
| SQLite，当前完整查询 | 304.31ms | 312.02ms |
| SQLite，仍完整排序，仅投影 rowid/score | 56.27ms | 62.81ms |
| SQLite，物化选页后再取正文/摘要 | 68.42ms | **72.88ms** |
| topic0042，当前完整查询 | 0.44ms | 0.47ms |
| topic0042，物化选页原型 | 0.31ms | 0.47ms |

两个测量查询的完整返回字段、顺序、score、snippet 逐项一致。高命中率场景 P95 相对本次对照降低约 77%。证据支持优先把宽列投影/摘要从完整排序阶段移出；未做 CPU profile，不能把全部差值精确归因于某一个函数。

原型未进入应用 search()，也没有证明中文、所有过滤/分页或并发写入兼容。因此 0.2.5 仍将 R4 标为待实施，不能宣称正式查询已达到 72.88ms。

## 第一优先级：保持结果一致的两阶段 SQL

在同一条 SQL、同一读取快照内：先按原规则完整评分排序，只选择 rowid/score；应用 limit/offset 并物化这一页；再按 ID 读取正文及生成 snippet；最外层显式维持 score、updated_at、id 排序。

原型结构如下，省略部分必须保留完整业务条件，不能直接将此示意投产：

```sql
WITH ranked AS MATERIALIZED (
  SELECT m.rowid AS rowid, /* 原评分公式 */ AS score
  FROM memories_fts
  JOIN memories m ON m.rowid = memories_fts.rowid
  WHERE memories_fts MATCH ? AND /* 全部原过滤 */
  ORDER BY score DESC, m.updated_at DESC, m.id
  LIMIT ? OFFSET ?
)
SELECT m.*, snippet(memories_fts, -1, '[', ']', '…', 32) AS snippet,
       ranked.score
FROM ranked
JOIN memories m ON m.rowid = ranked.rowid
JOIN memories_fts ON memories_fts.rowid = m.rowid
WHERE memories_fts MATCH ?
ORDER BY ranked.score DESC, m.updated_at DESC, m.id;
```

- 中文长词仍走 memories_cjk，短词保留字面过滤；全短词没有 MATCH，需单独适配。
- 必须完整评分之后截取页面。先按 BM25 拿固定 100 条再加权会改变召回/排序，不是等价优化。
- 用 EXPLAIN QUERY PLAN 验证物化边界。当前原型外层仍可能扫描 FTS 命中集合；若继续调整连接顺序或按 rowid 获取摘要，需重新对照计划和结果。
- 优先一个 SQL。若拆成两个调用，必须用同一读取事务，防止中间发生更新/删除造成结果撕裂。
- 两阶段共用同一个 now；snippet 必须保留 FTS MATCH 上下文。最终还需测量解码、序列化与 MCP 开销。

### 第一阶段验收

| 维度 | 验收条件 |
| --- | --- |
| 结果 | 与原查询比较 ID 顺序、score、snippet 和返回字段；英文/中文/混合/全短词均覆盖 |
| 过滤 | namespace、project=null、指定 project、all_projects、tags/type/source、TTL 边界、软删/恢复、更新失效 |
| 排序/分页 | 同分稳定，原 BM25/重要度/新近度语义，offset/maxLimit 与不同字段命中 |
| 延迟 | 5 万条高命中率英文 P95 ≤150ms；选择性/中文无明显退化；至少 30 次采样并保留原始分布 |
| 平台 | Linux 与目标 Windows Node 24，记录硬件/数据规模/冷热缓存/SQLite 版本 |
| 回归 | 原 136 项与新增风险回归通过；不因这一步无故修改数据 schema |

## 第二优先级：事件循环响应性

第一阶段之后，测同进程并发 MCP 请求：一个高频词查询运行时，memory_stats/轻量读取是否被拖慢，并记录事件循环延迟。建议轻量请求 P95 ≤100ms 作为新增响应性目标，这是本方案提出的目标，不是已经通过的原始指标。

只有 SQL 优化后仍不满足该目标，再将大型只读搜索移入有界 worker_threads 执行器。每个 worker 持有独立只读 SQLite 连接，显式传递 scope/过滤/now/版本；主线程保留协议和写入调度。队列必须有长度限制、排队超时和停服排空，取消不能造成无界后台工作。

worker 涉及服务接口、连接与关闭逻辑，单独交付。它改善主线程响应，不自动使 SQL 更快；必须衡量额外 RSS、数据复制和读写竞争。

## 第三优先级：扩大负载验收

使用真实脱敏语料及可重复合成数据，覆盖 5 万/10 万 Memory、不同命中率/project 分布、长正文、并发读写与冷热缓存。图谱 10 万 Entity/50 万 Relation，以及 hybrid 本地 ≤500ms，建立独立基准，不能从英文 FTS 改善推导已通过。

第一阶段达标后，再根据测量决定额外索引或缓存；缓存必须包含 scope/过滤/数据版本和失效策略。当前没有证据需要先迁移数据库。

## 实施顺序

两阶段 SQL + 等价性回归 → 同一候选提交的 Linux/Windows 基准 → 达标后合入 → 按事件循环数据决定是否做 worker → 扩大到真实语料和 10 万条。

每步独立提交、可回退。报告区分原型数字、正式实现与目标平台验收，不把 72.88ms 的小范围实验当作已发布版本保证。
