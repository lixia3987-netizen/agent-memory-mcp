# 0.2.3 审查修复记录

日期：2026-09-10。基于 main 的 1d49a76 复核本轮 8 项反馈。

| 用户编号 | 复核及修复 | 回归证据 |
| --- | --- | --- |
| 1 | conflicts 复用 relations 的作用域、实体删除和来源有效性筛选；传入的未落库更新也校验自身来源。失效或封存事实不再修改新事实 | stale、来源删除/过期、实体删除、刷新来源及 enrichment apply |
| 2 | 比较编辑前后的重叠集合，只标新增重叠；原有未标记重叠保留 parallel 意图，原有且仍重叠的显式冲突继续保留 | 缩短 parallel 区间不改状态/置信度，延长只标新相交的未来事实；status/attributes 编辑不能清除仍存在的冲突 |
| 3 | llm.maxAttempts 默认 3，范围 1–100；超限 failed，claim 拦截并退休旧超限任务及过期最终租约。显式重启终态可重置预算，pending/running 不重置 | 持久故障、恢复、单条 run、租约边界、旧版超限任务、其他 project、真实 HTTP 429/500 与熔断 |
| 4 | exact 文件 hash 命中后，必须比较策略处理后的输入正文 hash 与目标当前 content_hash；显式恢复不被快路径短路 | A→B→A、多次回退、dry-run 无写入、同内容再次导入跳过 |
| 8 | 含汉字时，长度 ≥3 的词使用 trigram MATCH，短词以参数化字面子串条件补齐 AND；全短词扫描过滤后的 scope | AI 大模型、AI 模型、标题与正文跨字段、scope/TTL/删除/tags/分页、% 字面量 |
| 5 | 未加引号凭据及 Bearer/Basic 值类排除单双引号，保留外层内容结构 | 脱敏后 JSON.parse 成功，普通引号及既有带转义的引号值用例 |
| 6 | relation attributes 普通字段仍限制 16 KiB，系统 conflict_with 独立允许最多 1000 个 UUID；实体属性限制不变 | 450 条冲突写入成功，普通属性仍拒绝超限，1000/1001 引用边界 |
| 7 | 保留软删来源记录；update 跳过且不修改软删记忆，计入 skipped。只有显式 deleted_at:null 才恢复，并校验活跃去重 | 删除后修改来源不复活/不改正文，显式恢复及 exact hash 恢复，重复内容恢复失败并回滚 |

## 设计说明与边界

SQLite 官方说明：[FTS5 trigram](https://sqlite.org/fts5.html#the_trigram_tokenizer) 的 MATCH 不匹配少于三个 Unicode 字符的子串。因此仅把 every 改为 some 仍会被 AI 这个短词阻断。此修复保留所有词的 AND 语义，不丢弃短词。全短词中文查询需要扫描，建议大库加入长词索引锚点或缩小作用域；尚未验证规模性能。短词支持 ASCII 大小写折叠，不提供完整 Unicode 分词/归一化。

关系更新以已有、未标记的重叠作为 parallel 意图；重新激活、恢复或刷新失效来源产生的有效重叠视为新增。历史冲突引用及降置信度不自动撤销。conflict_with 为系统字段，现在校验 UUID 数组；任意自定义普通属性仍为 16 KiB。重叠候选和引用均有限额，超限事务回滚。

任务预算计算的是执行次数，包含租约重领和熔断期间的尝试；一次执行内部仍受 HTTP retries 限制。达到上限不会自动重入队；处理供应商问题后可显式 enqueue/run 重启。批量工作遇到可重试供应商故障仍立即停止本轮，避免烧完整个队列。退休旧超限任务没有调用供应商，不计入本轮 execute 的 failed 数量。

导入采用保护删除意图的规则：update 跳过软删记录，既不恢复也不悄悄改写。显式 deleted_at:null 才恢复；全新导入的历史删除快照仍保留删除状态。copy 仍是明确创建副本的选择。

## 验证与兼容

- 新增 18 项回归测试；最初 14 项修复前全部失败、修复后全部通过。
- 本地 typecheck、build、全量测试通过：112 通过 / 0 失败 / 0 跳过。[代码 cf0c35c 的 Ubuntu/Windows CI 与 release-gate](https://github.com/lixia3987-netizen/agent-memory-mcp/actions/runs/34446416011) 均通过，详见 [VALIDATION.md](VALIDATION.md)。
- 版本 0.2.3；不新增依赖、不修改已发布迁移，schema 保持 104。
- 无需补配才能启动；可选 llm.maxAttempts 已加入二期配置示例，默认 3。
- 不批量改写既有事实或记忆；原来已误标的冲突不会自动撤销。
