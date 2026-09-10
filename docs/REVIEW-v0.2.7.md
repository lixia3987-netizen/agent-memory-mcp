# PR 合并后完整检视与校验 · 0.2.7

日期：2026-09-10。

## 结论

一期和二期已交付核心功能已达到本地使用及小规模试运行阶段。现有 27 个 MCP 工具均通过编译后服务的官方 SDK 调用；新增验证打通了启用 embedding/LLM 后的检索、图谱应用、整库恢复和失效处理。模型默认关闭时，基础记忆功能独立可用。

这次确认的是实现和已执行环境中的行为。真实供应商输出质量、用户 Windows 10/11 客户端接入、10 万实体/50 万关系以及真实语料混合搜索的性能尚未验收，因此不能将“测试通过”解释为全部最终目标均已完成。

## 合并与验证范围

- [PR #1](https://github.com/lixia3987-netizen/agent-memory-mcp/pull/1) 已合并，合并提交 `55c0cb38d1dab41c4f8bf470ce07b62a605a1dac`；合并前核对最新 HEAD `819b78a` 的 Windows、Ubuntu 和 release-gate 均成功。
- 本次从 main 重新运行检查；附带 ZIP 是原始需求与架构文档，并非当前源码。检视依据是仓库源码、原始 REQUIREMENTS/ARCHITECTURE、当前 README/PHASE2_GUIDE 和实际执行结果。
- 已逐字节核对 ZIP 中 REQUIREMENTS 与仓库文档一致，原始 ARCHITECTURE 与 ARCHITECTURE-v1.0 快照一致；配置示例和示例导入数据均通过当前编译后解析器。
- 检视覆盖配置及 DTO、秘密策略、CLI/MCP/HTTP、所有业务服务、三个 SQLite 仓储、迁移/事务、异步搜索线程、导入适配器、Provider、日志及错误处理；复核跨 scope、TTL、删除/恢复、来源 hash、租约和失败回滚。
- 原有测试及旧查询对照全部保留；测试数据只在临时目录和本机 HTTP 端点内生成。没有连接真实模型或读取用户记忆数据库。

## 本轮发现与修复

**P2：脱敏后未重新校验字段上限，允许写入不满足 DTO/策略的记录。**

在合并基线上，配置 `maxContentBytes=1024`，输入 `'password=a '.repeat(60)`：原文 660 字节，落库正文 1,200 字节；输入长度小于 512 的重复凭据标题，落库长度达到 799。短密钥 metadata 同样可在替换成 `[REDACTED]` 后突破 16 KiB。过大的持久记录会导致导出再导入失败，并使策略声明与存储结果不一致。

修复在 [policy.ts](../src/domain/policy.ts) 的脱敏分支重新执行配置正文上限和公共正文/标题/metadata schema。原文与转换后内容都必须通过；失败以验证错误返回并由事务回滚，不截断或静默丢字段。适用于新增、更新、导入和合并预览/提交。没有改动 schema 105、既有迁移、依赖或搜索实现。

[policy-output.test.ts](../tests/integration/policy-output.test.ts) 增加 4 项回归：配置限额与原子更新、标准字段限额、导入/合并回滚、有效脱敏记录的 JSON/Markdown 往返及 redact→reject 更新。修复不扫描或改写旧记录；旧版本若已写入超限字段，需显式缩小该字段后再写入或导入。

**P2：来源时钟超前时，普通编辑可破坏时间顺序。**

实测导入 created_at 为 2099-01-01、updated_at 为 2099-01-02 的合法记录后，仅编辑 importance，旧实现把 updated_at 写成 2026 年本机当前时间，早于创建时间。删除/恢复有同一问题，未提供时间字段的导入更新则可能因合并后倒序而失败。

新增 [memory-time.ts](../src/services/memory-time.ts)，隐式更新时间取本机当前时间、创建时间和原更新时间中的较晚值，保持单调；删除时间仍使用实际事件时间。调用点涵盖普通更新、删除、恢复、合并及缺失时间的导入更新。显式提供的倒序导入时间仍拒绝，来源时间不被悄悄覆盖。[memory-time.test.ts](../tests/integration/memory-time.test.ts) 的 3 项测试覆盖这些流程、dry-run 及失败回滚。

## 功能覆盖矩阵

| 预期功能 | 实际检验及关键证据 | 状态 |
| --- | --- | --- |
| 一期 8 工具兼容及 CRUD | 编译后 stdio 调用；更新 FTS、持久化重开、错误返回；`contract/mcp`、`integration/memory` | 通过 |
| namespace/project 精确隔离 | ID/筛选/图谱/仓储写入防跨域；null 与 all_projects 分开；`memory`、`graph`、`review-regressions` | 通过 |
| 搜索、中文混合短词及分页 | 词法字段命中、字面 FTS、全部过滤、稳定分页；新旧完整 SearchHit/score/snippet 对照；`search-equivalence`、`review-v023` | 通过 |
| 时间顺序与来源时钟 | 原始时间保留、隐式更新单调、显式倒序拒绝、删除事件时间；`memory-time`、`review-v022` | 通过 |
| TTL、软删除、恢复、显式 purge | 过期去重、搜索隐藏、恢复冲突、审计、派生统计与图谱生命周期；`memory`、`policy-maintenance`、`review-v022/v024` | 通过 |
| JSON/Markdown 导入导出 | 原 ID/时间/metadata/删除状态往返；dry-run 回滚、skip/update/copy、来源幂等与回退；`import-export`、`review-v022/v023` | 通过 |
| Claude Code 及适配器接口 | 目录范围、项目映射、heading key/frontmatter、版本检测及自定义注册；`import-export`、`policy-maintenance`、`unit/importers` | 通过 |
| 配置、路径与文件保护 | CLI/env/file 优先级、未知键/空路径/IO 错误、allowlist、junction/symlink、读取增长与限额；`domain`、`io-review-v022` | 通过 |
| 备份恢复与迁移 | schema 3/104 升级、升级前快照、互斥/重试/回滚、损坏原库恢复至新路径；`database`、`phase2-upgrade`、`cli` | 通过 |
| 多进程与同步事务 | 四进程 WAL、busy 分类、嵌套回滚、异步回调拒绝；`concurrency`、`review-regressions` | 通过 |
| 异步搜索线程 | 预算含运行中任务、deadline、关闭排空、启动失败及禁用回退；`async-search` | 通过 |
| Embedding 索引 | 真实本机 HTTP 批次/乱序索引、维度/数值/模型、CAS/hash、分批游标；`providers`、`intelligence`、`enabled-workflow` | 通过；真实模型待验 |
| 语义/混合搜索与回退 | 超越字面匹配、RRF/图谱、跨项目显式查询、TTL/删除/筛选、503 后词法回退；`intelligence`、`enabled-workflow` | 通过；真实召回质量待验 |
| 实体/别名/关系/遍历 | 类型及别名去重、链接、防跨域、循环/方向/深度与截断、路径；`graph`、`review-v022/v023` | 通过 |
| 时间事实与冲突 | [from,to) 边界、future supersede、parallel 编辑不误伤、stale 过滤、来源修改后历史保留；`graph`、`review-v022/v023/v025` | 通过 |
| 去重与合并 | 文本/缓存语义候选、Unicode 码点、预览 token 过期、源快照及证据 hash；`intelligence`、`review-v024/v025` | 通过；有候选预算 |
| LLM 建议与显式 apply | JSON/实体端点验证、缓存、原文不变、apply 幂等、正文改变后禁止应用；`providers`、`intelligence`、`enabled-workflow` | 通过；真实供应商待验 |
| 持久 enrichment 任务 | 重启、租约/过期租约、CAS、瞬时失败保留、最大次数与显式重入队；`phase2-upgrade`、`review-v022/v023` | 通过；需显式运行 worker |
| Policy、维护及指标 | 凭据/占位符/JSON、变换后限额、expire/orphans/FTS/vacuum、统计/100 条指标保留；`policy-output`、`policy-maintenance`、`review-v024/v025` | 通过 |
| CLI 和诊断 | 编译后 help/version、doctor/init、导入/导出、恢复、purge 防误操作；`cli`、CI 独立命令 | 通过 |
| 本地 HTTP MCP | 官方 SDK、令牌/Host/Origin/大小/并发、接收与执行期限区分、取消容量恢复及停服排空；`contract/http`、`http-lifecycle` | 通过；仅 loopback |

证据均位于 [tests](../tests)；矩阵中的简称对应相应 `.test.ts`，不是仅检查工具是否列出。

## 新增整链路验证

[enabled-workflow.test.ts](../tests/contract/enabled-workflow.test.ts) 不向服务注入假 Provider 对象，而是启动编译后的独立 stdio 进程，通过官方 MCP Client 调工具，服务按配置访问本机 HTTP 接口。

验证顺序包括：中文/空格路径启动 → 添加两个项目数据 → 建索引及未变更复用 → 语义/混合检索及项目过滤 → LLM run/cache/apply → 原 Memory 逐字段不变 → CLI 备份/恢复至新路径 → 重开后向量/提取/图谱仍可用 → 改正文后派生索引与当前事实失效但旧时间事实可查 → 重建索引 → 503 时回退词法 → 原数据库保持原内容。

这个用例补足了既有 27 工具 contract 主要测试“模型关闭”路径的缺口。本机接口返回确定性向量/JSON，用于验证协议及数据流，不证明某个真实模型理解、提取或排序准确。

## 执行证据

| 检查 | 结果 |
| --- | --- |
| 合并前最新 PR HEAD | [34464719771](https://github.com/lixia3987-netizen/agent-memory-mcp/actions/runs/34464719771)：Windows/Ubuntu/release-gate 成功 |
| 合并后基线本地 | `pnpm check`：145/145，0 失败、0 跳过 |
| 合并提交主分支 CI | [34467865771](https://github.com/lixia3987-netizen/agent-memory-mcp/actions/runs/34467865771)：Windows/Ubuntu/release-gate 全部成功 |
| 0.2.7 本地 | Node 24.19.0，pnpm 11.19.0，TypeScript 5.9.3；typecheck/build 通过，153/153，0 失败、0 跳过 |
| 新增工作流 | 编译后进程、真实 stdio/HTTP、原生 CLI 备份恢复，成功 |
| 0.2.7 主分支 CI | 代码提交 `2bdb5ee5eb99e342d443211a9520b56d27931afa`，[34469688900](https://github.com/lixia3987-netizen/agent-memory-mcp/actions/runs/34469688900)：Windows/Ubuntu 各 153/153，0 失败、0 跳过；安装、typecheck、build、doctor、init、stdio smoke、规模基准及 release-gate 全部成功 |

CI 使用 Node 24.20.0；Windows runner 的实际系统是 Windows Server 2025。本地使用 Node 24.19.0。已核对两平台原始任务日志中的测试计数。后续交付提交仅更新文档/证据，运行源码、测试、依赖、配置和基准脚本与已验证代码提交一致。

### 本次性能复验

下表均为 P95 毫秒，同轮旧→新对照，默认递增时间语料、3 次预热和 30 次计时；HTTP 对照同时发起搜索及 get/stats。

| 指标 | Ubuntu 5 万 | Ubuntu 10 万 | Windows 5 万 | Windows 10 万 |
| --- | ---: | ---: | ---: | ---: |
| 英文 FTS | 397.37 → 77.66 | 803.70 → 152.67 | 688.41 → 159.98 | 829.45 → 197.37 |
| 并发 memory_get | 401.22 → 4.62 | 784.51 → 4.27 | 424.50 → 17.35 | 861.07 → 17.60 |
| 并发 memory_stats | 439.65 → 42.42 | 856.47 → 82.65 | 465.01 → 64.75 | 942.12 → 122.80 |
| 统计 SQL 执行计划 | 345.33 → 37.38 | 734.50 → 71.19 | 995.89 → 38.00 | 2721.28 → 87.52 |

**性能收益仍成立，但全部建议目标未通过。** 本轮 Windows 5 万条英文 FTS 为 159.98ms，超过 150ms 建议值；10 万条并发 stats 为 122.80ms，超过新增 100ms 建议值。历史运行的对应值分别约 78ms/105ms，说明跨轮稳定达标尚未成立；本次不将差异直接断言为环境问题或代码回归。中文长词、混合短词和窄查询的全部旧/新摘要也保留，未只选择改善明显的查询。

日志摘要、代码 SHA、任务 ID 和 artifact 校验值已保存在 [ci-v0.2.7.json](performance/ci-v0.2.7.json)。每次采样及执行计划在该 Actions run 的两个 `search-benchmark-*` artifact 中，当前标注到期日为 2026-12-09。

CI 的性能脚本验证结果等价并保存原始分布/执行计划。门禁成功表示脚本与正确性断言完成，不代表所有延迟或 RSS 目标自动达标。

## 使用和规模边界

1. 无 API Key 时可直接使用基础记忆、FTS、导入导出、手工图谱、文本去重及维护。Embedding/LLM 需要按 PHASE2_GUIDE 配置各自端点/模型；HTTP 另外需要令牌。
2. 真实云/本机模型、用户 Windows 10/11 和 Claude/Cursor/Codex/Hermes 客户端尚未联调。CI 中 Windows 原生 Node 验证与用户实际安装是不同证据。
3. 当前向量检索按数量/字节预算读取并做余弦计算，可能截断，未实现 ANN。真正 hybrid 的词法融合阶段仍同步。10 万实体/50 万关系、实际大维度向量和重导入并发的 P95/RSS 尚未验收。
4. 已完成 5 万/10 万 Memory 的合成 FTS/统计/HTTP 基准，最新结果见上表。Windows 5 万 FTS 与 10 万并发 stats 本轮未达到建议值；真实语料、写入 P95、启动/空闲及持续负载 RSS 也需在实际设备验收，详见 [PERFORMANCE_PLAN.md](PERFORMANCE_PLAN.md)。
5. `memory_export` 导出 Memory；图谱、向量、任务、合并快照应使用整库备份。`memory_at_time` 查询时间关系事实，不是任意旧 Memory 正文版本。
6. 任务按显式 run/maintenance 执行，没有自动后台调度；只提供已有明确格式的 JSON/Markdown/Claude 适配器；远程公网 HTTP 不在当前支持范围。

本轮不改变数据库选型或依赖。优先完成真实客户端/模型小样本联调，再依据实际规模评估向量检索和图遍历优化；不因合成基准通过而跳过这两项验收。
