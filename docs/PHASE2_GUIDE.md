# 二期使用指南 · 0.2.1

## 直接开始使用

沿用一期的 Node.js 24、数据目录和 stdio 客户端配置即可。模型相关功能默认关闭，知识图谱、时间事实、文本去重、合并、策略和维护无需外部服务。

```powershell
pnpm install --frozen-lockfile
pnpm build
pnpm test
node dist/index.js doctor
node dist/index.js serve
```

旧数据库自动升级为 schema 104；升级前生成快照。停止旧进程后再升级，不要让 0.1 和 0.2 交替操作同一数据库。保留 Node.js 24，不需要引入 Python、JDK 或 native npm 编译依赖。

## 新增工具

| 工具 | 功能与关键参数 |
| --- | --- |
| `memory_restore` | 恢复软删除，id + scope |
| `memory_stats` | scope 内记录/图谱/向量/任务数量，及数据库级工具耗时、错误、导入汇总 |
| `memory_search_hybrid` | query，mode=lexical/semantic/hybrid，兼容一期 Memory 过滤条件 |
| `memory_reindex` | 显式向量生成；ids 或 limit/after_id；force 可重新计算 |
| `memory_find_duplicates` | 以 id 为目标，text/semantic/hybrid，threshold、max_candidates、limit |
| `memory_merge` | target_id、source_ids、可选 content/title；默认预览，提交要 proposal_token |
| `memory_enrich` | id，action=run/get/enqueue/apply |
| `entity_add` | name、type、aliases、attributes |
| `entity_search` | 名称/别名 query、type、分页 |
| `entity_get` | id + scope，include_deleted 可选 |
| `entity_update` | id、updates，支持名称/类型/别名/属性和 deleted |
| `entity_link` | memory_id、entity_id、role、confidence；unlink=true 解除关联 |
| `relation_add` | 源实体、predicate、目标实体、生效时间、来源和冲突策略 |
| `relation_search` | 当前事实/历史列表、来源/关系过滤、at 时间点 |
| `relation_update` | 更新置信度/属性/状态/结束时间/来源绑定，或软删除与恢复 |
| `graph_neighbors` | entity_id、direction、max_depth、max_nodes、可选 at |
| `graph_path` | source_entity_id、target_entity_id、方向与遍历限制 |
| `memory_at_time` | 按 at 查询有效关系事实，保留已被替代的历史 |
| `memory_maintenance` | 显式维护，默认 dry-run；物理 purge 仍仅在 CLI |

所有这些操作都沿用 namespace/project 默认值。图谱、合并、维护限定一个精确 scope，不跨项目连边。Memory 混合搜索允许 all_projects=true，但该模式关闭图谱补充；纯语义及词法仍按整个所选 namespace 过滤。

## 知识图谱和时间事实

先分别调用 entity_add，并记录返回的 entity.id：

```json
{"namespace":"work","project":"demo","name":"Project A","type":"Project"}
```

```json
{"namespace":"work","project":"demo","name":"Yjs","type":"Technology","aliases":["Y.js"]}
```

以实际 ID 替换示例值，调用 relation_add：

```json
{
  "namespace":"work",
  "project":"demo",
  "source_entity_id":"PROJECT_ENTITY_ID",
  "predicate":"USES",
  "target_entity_id":"YJS_ENTITY_ID",
  "valid_from":"2026-06-01T00:00:00+08:00"
}
```

之后迁移到 OT，可创建 OT 实体并明确替代旧关系：

```json
{
  "namespace":"work",
  "project":"demo",
  "source_entity_id":"PROJECT_ENTITY_ID",
  "predicate":"USES",
  "target_entity_id":"OT_ENTITY_ID",
  "valid_from":"2026-10-01T00:00:00+08:00",
  "conflict_strategy":"supersede",
  "supersedes":"OLD_RELATION_ID"
}
```

在同一个短事务中生成新事实、关闭旧区间并设置 superseded_by。旧事实保留，区间采用 **[valid_from, valid_to)**。未来生效的替代不会提前隐藏当前事实。新生效时间必须严格位于旧区间内部；已被替代的区间不能直接重新打开。

调用 memory_at_time 查询过去：

```json
{"namespace":"work","project":"demo","at":"2026-08-01T00:00:00+08:00"}
```

当前 relation_search 默认排除已删除、inactive 及正文来源过时的事实。memory_at_time 默认保留与旧正文版本关联的事实，避免修改原记忆后历史消失；可显式 include_stale=false 收紧。graph_neighbors/graph_path 指定 at 时同样按历史事实遍历。`memory_at_time` 返回的是**关系事实**，不是所有 Memory 正文的历史版本。

冲突策略：

- `preserve`：同一源实体、predicate、重叠时间内出现不同目标时，两边保留、标记 conflict、置信度最多 0.5。这是冲突候选，不代表系统证明它们必然互斥。
- `supersede`：必须显式提供一个旧 relation ID，事务化替代。其他重叠替代项仍作为冲突保留。
- `parallel`：明确允许同一时间并存，例如项目同时使用多项技术。

实体唯一性依据 scope + type + 标准化名称，aliases 用于查找。实体重复添加时返回原记录；要追加别名请用 entity_update。关系绑定 source_memory_id 时必须同 scope，系统记录该次正文 hash。普通 Memory 更新会让旧派生事实从“当前事实”中隐藏，但不删除历史。

实体/关系删除使用 updates.deleted=true，恢复用 false。有关联的 Memory 不能直接搬到另一个 project：先用 entity_link unlink=true 解除链接，并通过 relation_update updates.source_memory_id=null 明确移除来源绑定。`enriched` 是自动抽取链接的保留 role，正文变化后这些链接失效。

图遍历默认最多 200 个节点、2000 条边，深度最多 3。返回 truncated 表示达到边界；路径不存在可能是受当前边界影响，不代表整个数据库无路可达。

## 可选语义检索

配置入口是 JSON 文件，示例见 ../examples/config.phase2.json。先配置实际服务地址与模型，然后将 embedding.enabled 改为 true。

```json
{
  "embedding": {
    "enabled": true,
    "baseUrl": "https://provider.example/v1",
    "model": "YOUR_EMBEDDING_MODEL",
    "apiKeyEnv": "AGENT_MEMORY_EMBEDDING_API_KEY",
    "timeoutMs": 15000,
    "retries": 1,
    "batchSize": 16,
    "maxCandidates": 5000,
    "maxVectorBytes": 33554432
  }
}
```

`provider.example` 是占位地址，必须替换。baseUrl 是 API 根路径，程序追加 `/embeddings`。支持使用 OpenAI-compatible 协议的云服务、企业接口或本地服务；不需要安装额外模型 SDK。维度默认从响应推断，也可配置 dimensions 作一致性校验（不会请求服务自动缩短向量）。

```powershell
$env:AGENT_MEMORY_EMBEDDING_API_KEY = "YOUR_KEY"
node dist/index.js reindex --config "C:\AgentMemoryData\config\config.json" --namespace work --project demo --limit 100
node dist/index.js search --config "C:\AgentMemoryData\config\config.json" --namespace work --project demo --query "存储方案" --mode hybrid
```

首次语义查询前需显式建立索引，不会在 memory_add 中自动调用模型。memory_reindex 默认只补缺失或过期的向量；`force:true` 重新生成已有向量。大批量返回 next_cursor 时，用 after_id（CLI 为 `--after-id`）继续；重建期间发生修改的旧结果会被丢弃，下次补建即可。

向量以 Float32 BLOB 保存，按 provider + model 隔离，且附正文 hash。模型接口调用不在数据库事务中；返回批次数量、索引、维度和数值都经过验证。正文变化会删除旧向量，过期/软删除记录默认不参与检索。

hybrid 使用 RRF 融合词法、语义和图谱相关 Memory，再作轻微重要度/新近度加权。默认最多检查 5000 个向量且受字节预算限制，融合候选上限为词法 100、语义 300、图谱 100；不是大规模 ANN 索引。结果包含 candidate_count/truncated 等信息。没有配置、没有当前向量、接口不可用时自动回退 lexical，并返回原因。配置或数据库损坏不会伪装为正常空结果。

默认 HTTP 仅允许 loopback；外部 endpoint 要用 HTTPS，企业内部明文 HTTP 如确有需要可显式 allowInsecureHttp=true。默认不跟随重定向。超时、有限重试、响应大小限制和暂时熔断均可配置。熔断只累计耗尽重试的可重试故障（如 429、5xx、网络超时），400/401/422 等不可重试错误和调用方取消不会增加熔断计数。Key 只通过指定环境变量读取，不保存进数据库或日志；未配置 apiKeyEnv 时可连接无需鉴权的本地服务。

## 去重与合并

memory_find_duplicates 不修改数据。text 使用字符三元组 Dice；semantic 使用**已经缓存**的同模型向量，不额外调用模型；hybrid 取文本/语义相似度的较高值。默认候选数量 1000；`duplicates.maxCandidateBytes` 默认 8 MiB，按候选 Memory 序列化后的 UTF-8 字节计量。它独立于 `embedding.maxVectorBytes`（默认 32 MiB 原始向量 BLOB），两者都不是进程 RSS 上限。结果分别返回 `text_truncated`、`vector_truncated`；任一受限时 `truncated=true`。建议从候选中确认，不把阈值当作事实正确性的保证。

memory_merge 先预览：

```json
{"namespace":"work","project":"demo","target_id":"KEEP_ID","source_ids":["SOURCE_ID"],"dry_run":true}
```

确认后以同样参数和返回的 proposal_token 提交：

```json
{"namespace":"work","project":"demo","target_id":"KEEP_ID","source_ids":["SOURCE_ID"],"dry_run":false,"proposal_token":"RETURNED_64_CHARACTER_TOKEN"}
```

默认拼接正文并合并标签；也可显式传入整理后的 content/title。预览后任一记录内容或元数据变化，旧 token 失效。一次最多 20 个来源，只支持同 scope 内活跃记录。提交事务中保留原快照、软删除来源、更新目标，并转移关联，metadata 记录来源 ID/source/时间。普通恢复可恢复来源记录；没有自动“撤销整次合并”工具。显式 purge 关联记录时，相关合并快照按外键一并清理。

## 可选 LLM 增强

配置 llm.enabled/baseUrl/model/apiKeyEnv，格式与 embedding 类似。程序调用 `/chat/completions` 并要求 JSON 对象输出。不同供应商可能需要适配具体模型的 JSON 输出能力；当前只做了本地兼容接口联调，没有验证你的真实供应商。

```powershell
$env:AGENT_MEMORY_LLM_API_KEY = "YOUR_KEY"
node dist/index.js enrich --id "MEMORY_ID" --action run --namespace work --project demo
node dist/index.js enrich --id "MEMORY_ID" --action get --namespace work --project demo
node dist/index.js enrich --id "MEMORY_ID" --action apply --namespace work --project demo
```

run 生成摘要、类型/标签/重要度建议、实体关系和冲突提示；结果经过严格 schema 和秘密信息检查。get 读取结果。**apply 只将已校验的实体与关系写入图谱，不改写原始 Memory 正文、类型、标签或重要度。** 重复 apply 幂等。模型输出中的关系端点必须来自本次实体列表，无法解析或包含秘密的输出拒绝落库。

调用失败不会撤销原记忆。正文在请求中途变化时，过时结果丢弃。任务记录保存在 SQLite，包含状态、次数和租约令牌；多个 worker 不会同时领取同一未过期租约。enqueue 可在未配置模型时先排队，之后重启并配置模型再执行：

```powershell
node dist/index.js maintenance --action enrichment-jobs --namespace work --project demo --limit 20
node dist/index.js maintenance --action enrichment-jobs --namespace work --project demo --limit 20 --apply
```

没有隐式常驻 worker，也没有系统级定时任务；worker 由显式维护操作执行。网络调用按 timeout/retries 限制，失败任务可重新 enqueue。进程中断后，未过期租约先等待，过期后可重新领取。

## 策略、Importer、维护与可观测性

policy 支持 rejectTypes/rejectSources/rejectNamespaces、minimumImportance、maxContentBytes、defaultTtlDays、typeDefaults、duplicateThreshold 和秘密检测。默认保留一期 importance=5 与无 TTL 的语义，不自动提高 decision 的重要度；示例可自行配置。

secretDetection 默认为 true、secretAction 为 reject。redact 模式针对 Memory 正文/标题/metadata 脱敏；图谱属性及 LLM 输出中匹配的秘密仍拒绝。规则检测不能保证识别全部秘密。自定义 regex 是本机可信配置，应使用简单、有界模式。策略覆盖新增、更新和导入；不会批量改写历史数据库。

```powershell
node dist/index.js importers
node dist/index.js maintenance --action graph-check --namespace work --project demo
node dist/index.js maintenance --action expire --namespace work --project demo --apply
node dist/index.js maintenance --action orphans --namespace work --project demo --apply
node dist/index.js maintenance --action fts-rebuild --apply
node dist/index.js maintenance --action vacuum --apply
node dist/index.js stats --namespace work --project demo
```

Importer 接口包含 id/version/extensions/detectVersion/parse；内置 JSON、Markdown、Claude Code。开发者可以在 bootstrap 后用 app.imports.register(adapter) 注册自定义模块；MCP 不会加载任意本地代码。没有臆造 Cursor/Codex/Hermes 的内部记忆格式适配器，获取实际格式后再实现。

维护 expire/orphans 默认预览，提交后软删除。orphans 只处理无任何关系和链接的实体，保留历史连接。FTS rebuild 与 vacuum 作用于**整个数据库**，应在空闲时显式执行。物理 purge 继续是独立 CLI 命令，要求 --yes/--before。原来源记忆被 purge 时，其来源关系会退休，避免删除后被当作无来源活跃事实重新出现。

metrics 仅存本地，结果通过 `metrics_scope: "whole_database"` 明确标记操作指标的范围：scope 内 Memory/entity/relation/embedding/enrichment/job 数量，以及数据库级工具调用数、错误数、平均/最大耗时和最近导入汇总。指标写入失败不会改变业务操作结果。不会上传遥测，当前不是完整 Prometheus 或性能分析系统。

## 可选 Streamable HTTP

默认仍为 stdio。HTTP 只支持 127.0.0.1、::1 或 localhost，当前没有远程绑定模式。需要配置 http.enabled=true 和令牌，且命令明确选择 HTTP：

```powershell
$env:AGENT_MEMORY_HTTP_TOKEN = node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
node dist/index.js serve --transport http --config "C:\AgentMemoryData\config\config.json"
```

`http.requestTimeoutMs`（默认 30000）限制接收完整请求的时间，`http.headersTimeoutMs`（默认 10000）限制接收请求头，后者不得大于前者。二者不会在请求体收完后终止 reindex/maintenance 等长任务。Provider 的 `timeoutMs` 限制单次模型请求；MCP 客户端另有自己的工具调用超时（项目锁定的官方 SDK 默认 60000ms），需要在客户端调整或使用 CLI/小批次及 `after_id` 游标。客户端超时或断开不保证服务端工作已停止，应检查索引进度后再决定是否重试。

默认地址 `http://127.0.0.1:3210/mcp`。客户端发送 `Authorization: Bearer <token>`。支持官方 SDK 的无状态 Streamable HTTP POST；GET/SSE 和 DELETE 会话端点返回 405。验证 Host、Origin、令牌、正文大小和并发请求数量。不要把该本地接口通过无保护的代理转发到公网。

## 备份和当前边界

memory_export 为兼容一期继续仅导出 Memory（schemaVersion 1）。完整图谱、时间事实、向量、合并快照、任务和指标都保存在 SQLite，使用 backup/restore 迁移完整数据库。手工图谱事实不一定能从 Memory 自动重建，应保留数据库备份。

本地测试覆盖真实 SQLite、官方 MCP stdio/HTTP 客户端和模拟供应商 HTTP 服务。Windows 实机、真实模型质量/费用/限流/专有响应格式、5 万/10 万记录性能及长时间运行仍需后续验证。
