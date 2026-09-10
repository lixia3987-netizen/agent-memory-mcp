# 性能修复实施与验证 · 0.2.6

日期：2026-09-10。两阶段 SQL、统计覆盖索引和有界只读搜索线程均已进入正式代码。代码提交 **9c19cb8** 的 Windows/Linux 各 145 项测试、5 万/10 万条基准及 release-gate 全部完成；[push 工作流](https://github.com/lixia3987-netizen/agent-memory-mcp/actions/runs/34463321642) 与 [PR 工作流](https://github.com/lixia3987-netizen/agent-memory-mcp/actions/runs/34463325906) 均成功。随后仅补充报告及证据文件，不改变已测代码。

## 已实施

1. **FTS 两阶段查询**：一条 SQL、同一快照与评分时间，完整过滤/评分后物化 rowid/score 页面，最后读取正文和 snippet。外层 CROSS JOIN 从小页面开始，按 rowid 读取 FTS，保留 MATCH 上下文和稳定排序。没有固定 100 条的提前召回截断。英文、中文、混合短词和全短词路径均适配。
2. **统计覆盖索引**：实测 memory_stats 在 5 万条、未启用模型时约 250ms；原执行计划按内容 hash 顺序反复读取正文所在数据页。schema 105 增加 `(namespace,project,deleted_at,expires_at,id,content_hash)` 索引，让记忆和派生计数可直接使用覆盖索引；原 scope、hash、删除和到期过滤不变。升级先自动备份，原迁移不修改。
3. **单个只读搜索线程**：10 万条同步搜索仍会拖延轻量请求，因此 MCP/CLI 词法搜索、hybrid 的 lexical 模式及供应商失败后的 lexical 回退改用独立 SQLite 只读连接。主线程保持协议、写入与统计。只在线程首次被用到时启动；无网络和外部服务依赖。

线程默认最多接受 20 项工作（执行 + 排队），从提交起默认 30 秒期限。排队超时移除；执行超时向调用方返回可重试 DATABASE_BUSY，但旧线程未真正退出前保留执行槽，不启动替代线程。关闭拒绝新工作并排空已接受的任务，随后关闭线程连接。MCP 客户端断开仍受 HTTP 与线程两层工作预算约束。

新增配置 `search.workerEnabled=true`、`workerQueueLimit=20`、`workerTimeoutMs=30000`，均有默认值。同步嵌入式调用 `memory.search()` 保留；异步接口是 `memory.searchAsync()`。真正 hybrid 的向量/图谱融合仍保留现有同步词法阶段，本轮不宣称已完成整个 hybrid 的响应性优化。

## 本地实测

Linux / Node 24.19.0 / SQLite 3.53.3 / AMD EPYC 9V74（可见 9 个逻辑 CPU）。以下均为 30 次 warm-cache 样本的 P95，单位 ms；旧新结果逐次相同。

| 查询/操作 | 5 万旧 → 新 | 10 万旧 → 新 |
| --- | ---: | ---: |
| SQLite，高命中率英文 | 325.72 → **63.62** | 660.85 → **126.58** |
| topic0042，选择性英文 | 0.88 → 0.88 | 1.72 → 1.58 |
| 长期记忆，中文长词 | 56.98 → 58.42 | 117.35 → 126.98 |
| AI 大模型，混合短词 | 72.85 → 77.08 | 141.49 → 150.93 |
| AI 模型，全短词 | 118.97 → 67.96 | 235.89 → 140.28 |
| 统计 SQL，原 hash 索引计划 → 覆盖索引 | 253.53 → **25.02** | 697.64 → **49.18** |
| HTTP 搜索同时的 memory_get | 322.89 → **7.78** | 707.51 → **4.19** |
| HTTP 搜索同时的 memory_stats | 350.18 → **30.26** | 761.05 → **80.17** |
| 服务事件循环延迟 | 316.67 → 32.34 | 692.06 → 59.47 |

英文高命中率 P95 降低约 80.5%/80.8%；本机达到 5 万条普通 FTS ≤150ms、并发轻量请求 ≤100ms 的目标。中文长词/混合短词未明显提速，局部有约 3–8% 固定开销或测量波动，不能宣称所有查询均加速。

线程启用后的服务进程 RSS 为约 135MiB/140MiB，原同步对照约 114MiB/109MiB；这是查询后工作集，**不是空闲内存验收**。数据库与 WAL 约 108MiB/206MiB。CPU/缓存/调度影响绝对数字，跨平台数据分别判断。

[完整本地分布与执行计划](performance/search-linux.json)。[同时间戳控制实验](performance/fts-tied-control-linux.json) 是统计索引/线程投入前的诊断样本：5 万/10 万英文 FTS 47.09→49.78ms、95.99→99.23ms，说明旧 top-page 有利输入时优化收益会消失；其 HTTP 数据属于旧统计路径，不当作最终版本表现。

## Windows / Linux CI 实测

以下取代码 9c19cb8 的 push 工作流；两平台各 145/145 测试通过，类型/构建、doctor/init、真实 MCP smoke 和规模基准均成功。Ubuntu Node 24.20.0，Windows Node 24.19.0；Windows SQLite 3.53.3。硬件和完整原始分布由各自 Actions artifact 记录，本表不套用本机 CPU 参数。

| 平台/条数 | 英文 FTS 旧 → 新 P95 | 并发 get 旧 → 新 P95 | 并发 stats 旧 → 新 P95 |
| --- | ---: | ---: | ---: |
| Ubuntu / 5 万 | 391.63 → **76.39ms** | 396.96 → **3.73ms** | 429.85 → **42.60ms** |
| Windows / 5 万 | 351.41 → **78.41ms** | 355.73 → **17.31ms** | 391.52 → **61.06ms** |
| Ubuntu / 10 万 | 783.84 → **152.59ms** | 781.73 → **3.70ms** | 845.40 → **73.29ms** |
| Windows / 10 万 | 696.51 → **154.25ms** | 784.06 → **16.91ms** | 858.95 → **105.19ms** |

**判定：5 万条普通 FTS ≤150ms 两平台均达标；5 万条并发轻量请求 ≤100ms 均达标。** 扩展到 10 万条，Windows 并发 stats 105.19ms 略超新增 100ms 建议目标，不能标成全部达标；10 万条普通 FTS 约 153–154ms，也不能套用 5 万条的 150ms 指标宣称全部规模达标。

Windows 统计 SQL 原 hash 索引计划 → 覆盖索引：5 万 791.98→34.80ms，10 万 1912.34→74.73ms。事件循环 P95：5 万 356.78→48.04ms，10 万 762.31→93.06ms。中文/短词、HTTP 搜索本身和其他 P95 数据均保存在 [CI 指标摘要与 artifact 元数据](performance/ci-9c19cb8.json)。

原始 CI 分布：[Ubuntu artifact](https://github.com/lixia3987-netizen/agent-memory-mcp/actions/runs/34463321642/artifacts/10146600576)、[Windows artifact](https://github.com/lixia3987-netizen/agent-memory-mcp/actions/runs/34463321642/artifacts/10146862289)。Artifacts 按 GitHub 保留期到期；仓库内摘要保留 commit/job/artifact ID 和校验摘要，本地完整分布另已纳入版本控制。

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

## 后续性能工作顺序

1. 先在用户真实 Windows 设备和数据上复测 10 万条 stats；若持续超过响应目标，优先将只读统计纳入独立的有界执行器，并评估与搜索共用队列的等待，或对派生表为空做短路计数。不要为一次 runner 波动引入无版本缓存。
2. 单独分析真实 hybrid 的向量候选、图谱遍历和同步词法融合阶段，建立带过滤/版本失效的结果对照后再移出主线程；不把本次 memory_search 指标当作 hybrid 指标。
3. 增加真实语料、长正文、多读多写和图谱规模的负载矩阵，再决定是否需要额外索引/增量聚合。当前仍使用 SQLite，无需迁移外部向量数据库。

## 0.2.7 合并后复验补充

代码 `2bdb5ee` 的 [Windows/Ubuntu CI](https://github.com/lixia3987-netizen/agent-memory-mcp/actions/runs/34469688900) 完成同一脚本及 153 项功能测试，release-gate 成功。完整旧/新对照见 [复验报告](REVIEW-v0.2.7.md)，所有查询的日志摘要、任务和 artifact 元数据见 [ci-v0.2.7.json](performance/ci-v0.2.7.json)。本轮没有改动搜索或基准实现。

- Ubuntu 50k/100k 英文 FTS P95：397.37→77.66ms / 803.70→152.67ms。
- Windows 50k/100k 英文 FTS P95：688.41→159.98ms / 829.45→197.37ms。
- Windows 50k/100k 并发 get：424.50→17.35ms / 861.07→17.60ms；并发 stats：465.01→64.75ms / 942.12→122.80ms。

本轮 Windows 50k FTS 超过 150ms 建议值、100k 并发 stats 超过 100ms 建议值。收益保持，但不能宣称跨轮稳定达标。历史 0.2.6 数据继续保留作为独立测量，不以较快的旧记录替换本次结果。下一轮实际设备复测需同时纳入 50k FTS 的延迟稳定性和 100k stats。
