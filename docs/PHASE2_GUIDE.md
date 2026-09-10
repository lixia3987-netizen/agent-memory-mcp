# 二期使用指南 · 0.2.4

## 直接开始使用

沿用一期的 Node.js 24、数据目录和 stdio 客户端配置即可。模型相关功能默认关闭，知识图谱、时间事实、文本去重、合并、策略和维护无需外部服务。

```powershell
pnpm install --frozen-lockfile
pnpm build
pnpm test
node dist/index.js doctor
node dist/index.js serve
```

旧数据库自动升级为 schema 105；升级前生成快照。停止旧进程后再升级，不要让 0.1 和 0.2 交替操作同一数据库。保留 Node.js 24，不需要引入 Python、JDK 或 native npm 编译依赖。

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

未传 at 时，relation_search/graph_neighbors/graph_path 默认排除来源已过时的事实。显式传 at 时，这三个接口与 memory_at_time 一样默认保留关联旧正文版本的历史事实；均可显式 include_stale=false 收紧，或 include_stale=true 保留。deleted/inactive 筛选及区间边界独立生效。`memory_at_time` 返回的是**关系事实**，不是所有 Memory 正文的历史版本。

冲突策略：

- `preserve`：同一源实体、predicate、重叠时间内出现不同目标时，两边保留、标记 conflict、置信度最多 0.5。这是冲突候选，不代表系统证明它们必然互斥。
- `supersede`：必须显式提供一个旧 relation ID，事务化替代。其他重叠替代项仍作为冲突保留。
- `parallel`：明确允许同一时间并存，例如项目同时使用多项技术。

修改 valid_to/status、刷新来源或恢复关系时，只把本次修改新产生的重叠标为冲突；已存在且未标冲突的重叠保留 parallel 意图。已有的、仍重叠的冲突不能通过改 status/attributes 清除。重新激活、恢复或刷新失效来源会重新参与冲突检测。检测双方必须拥有未删除的实体与当前有效来源，排除 stale、过期/删除来源、跨域及 superseded 事实；历史查询仍可显式查看。历史冲突标记与降置信度不自动消解。

关系 attributes 的普通字段仍限制 16 KiB；系统 conflict_with 单独允许最多 1000 个 UUID（约 39 KiB），不占普通字段额度。实体属性上限不变。超过重叠事实或引用数量上限会报错并回滚。

实体唯一性依据 scope + type + 标准化名称，aliases 用于查找。别名同样按 NFKC、大小写和空白规范化去重，保留首次拼写与输入顺序，返回数组与落库一致。实体重复添加时返回原记录；要追加别名请用 entity_update。关系绑定 source_memory_id 时必须同 scope，系统记录该次正文 hash。普通 Memory 更新会让旧派生事实从“当前事实”中隐藏，但不删除历史。

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

memory_find_duplicates 不修改数据。text 使用按 Unicode 码点切片的字符三元组 Dice，先做 NFKC/大小写/空白规范化，不拆分 emoji 的 UTF-16 代理对（并非按字素簇分词）；semantic 使用**已经缓存**的同模型向量，不额外调用模型；hybrid 取文本/语义相似度的较高值。默认候选数量 1000；`duplicates.maxCandidateBytes` 默认 8 MiB，按候选 Memory 序列化后的 UTF-8 字节计量。它独立于 `embedding.maxVectorBytes`（默认 32 MiB 原始向量 BLOB），两者都不是进程 RSS 上限。结果分别返回 `text_truncated`、`vector_truncated`；任一受限时 `truncated=true`。建议从候选中确认，不把阈值当作事实正确性的保证。

memory_merge 先预览：

```json
{"namespace":"work","project":"demo","target_id":"KEEP_ID","source_ids":["SOURCE_ID"],"dry_run":true}
```

确认后以同样参数和返回的 proposal_token 提交：

```json
{"namespace":"work","project":"demo","target_id":"KEEP_ID","source_ids":["SOURCE_ID"],"dry_run":false,"proposal_token":"RETURNED_64_CHARACTER_TOKEN"}
```

默认拼接正文并合并标签；也可显式传入整理后的 content/title。预览后任一记录内容或元数据变化，旧 token 失效。一次最多 20 个来源，只支持同 scope 内活跃记录。提交事务中保留原快照、软删除来源、更新目标，并转移关联，metadata 记录来源 ID/source/时间。普通恢复可恢复来源记录；没有自动“撤销整次合并”工具。显式 purge 关联记录时，相关合并快照按外键一并清理。

从 0.2.5 起，只有原样拼接且策略未改写正文的合并才迁移仍有效的关系，并核对各来源和目标的合并前 content_hash。stale、已结束、inactive、已删除关系及删除端点不刷新证据；历史查询仍可追溯原来源。已 supersede 但尚未到结束时间的事实继续遵守原区间。

显式整理 content 或策略脱敏改变正文时，旧关系不会自动获得新正文的 hash；需要重新 enrichment 或显式复核来源关系。显式普通实体链接仍按合并规则处理；enriched 派生链接在正文被改写时不转移。此修复不自动纠正旧版本已经刷新过 hash 的关系；若曾对带关系的记忆合并，请依据原正文/快照重新核验。

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

Enrichment 没有隐式后台任务，也没有系统级定时任务；任务由显式维护操作执行。0.2.6 的只读搜索线程独立于 Enrichment，仅处理显式词法查询。网络调用按 timeout/retries 限制，失败任务可重新 enqueue。进程中断后，未过期租约先等待，过期后可重新领取。

llm.maxAttempts 默认 3，允许 1–100，限制一个任务跨多轮维护的执行次数；它与单次 HTTP 请求的 retries 分开计算。批量 enrichment 遇到 retryable 故障时停止本轮：未耗尽预算则恢复 pending 并返回 deferred=1，达到上限则转 failed 并计入 failed。熔断期间的执行也消耗任务预算，避免无限 pending。不可重试错误直接 failed，正文版本冲突仍为 stale。

claim 同时退休旧版已超限的 pending 任务和已过期的最终租约，保护仍有效的租约及其他作用域；回收过期租约也计入 attempts。work 不自动重启 failed；显式 enrich --action enqueue 或 run 可以重启 failed/stale 并重置预算。对 pending/running 重复 enqueue/run 不重置 attempts。失败原因保留为安全错误码。系统没有后台自动重试，下一轮维护仍须显式执行。

## 策略、Importer、维护与可观测性

导入新增记录时应用默认 TTL/importance；导入更新时，来源未提供这些字段就保留现值，显式 expires_at=null 表示永不过期。合并后的 updated_at 不得早于 created_at。

policy 支持 rejectTypes/rejectSources/rejectNamespaces、minimumImportance、maxContentBytes、defaultTtlDays、typeDefaults、duplicateThreshold 和秘密检测。默认保留一期 importance=5 与无 TTL 的语义，不自动提高 decision 的重要度；示例可自行配置。

secretDetection 默认为 true、secretAction 为 reject。凭据检测不再要求值至少 8 字符，支持标点和引号内空格，脱敏区分凭据内部引号与外层字符串边界。有效 JSON 只重写变更的字符串片段，保留外层结构、排版、未修改的转义和大整数原文。未加引号的值以空白、逗号、分号或结构闭合符为界，内部引号属于值；开头带引号却未闭合时保守隐藏剩余值。redact 模式针对 Memory 正文/标题/metadata 脱敏；metadata 的敏感键直接隐藏整个值（包括短字符串、数字和容器）；图谱属性及 LLM 输出中匹配的秘密仍拒绝。规则检测不能保证识别全部秘密。自定义 regex 是本机可信配置，应使用简单、有界模式。策略覆盖新增、更新和导入；不会批量改写历史数据库。

0.2.5 将独立 token 字段加入受保护名称，与 password/access_token 一样作用于正文赋值、JSON 和嵌套 metadata，大小写不敏感。token_count/tokenizer 和普通“token”术语不作为敏感字段。旧库不会自动扫描或改写；旧版存入的 token 明文在后续写入校验时可能被拒绝，应先移除真实值或显式采用 redact 处理。

内置凭据规则只豁免完整的 [REDACTED] 值（包括引号包裹及 Authorization scheme），metadata 敏感键也允许这个精确占位值。redact→reject 后，原有脱敏记录的更新、import-update、merge 继续可用；占位符后缀、邻接的新凭据和自定义 secretPatterns 仍照常校验。JSON 结构保留针对内置凭据脱敏；会匹配 JSON 语法字符的自定义正则不保证此性质。

```powershell
node dist/index.js importers
node dist/index.js maintenance --action graph-check --namespace work --project demo
node dist/index.js maintenance --action expire --namespace work --project demo --apply
node dist/index.js maintenance --action orphans --namespace work --project demo --apply
node dist/index.js maintenance --action fts-rebuild --apply
node dist/index.js maintenance --action vacuum --apply
node dist/index.js stats --namespace work --project demo
```

Importer 接口包含 id/version/extensions/detectVersion/parse；内置 JSON、Markdown、Claude Code。开发者可以在 bootstrap 后用 app.imports.register(adapter) 注册自定义模块；MCP 不会加载任意本地代码。空 frontmatter 可直接导入，结束标记必须独占整行，取第一个关闭标记；保留 CRLF/BOM 兼容及错误 YAML 拒绝。没有臆造 Cursor/Codex/Hermes 的内部记忆格式适配器，获取实际格式后再实现。

维护 expire/orphans 默认预览，提交后软删除。orphans 只处理无任何关系和链接的实体，保留历史连接。FTS rebuild 与 vacuum 作用于**整个数据库**，应在空闲时显式执行。物理 purge 继续是独立 CLI 命令，要求 --yes/--before。原来源记忆被 purge 时，其来源关系会退休，避免删除后被当作无来源活跃事实重新出现。

metrics 仅存本地，结果通过 `metrics_scope: "whole_database"` 明确标记操作指标的范围：scope 内 Memory/entity/relation/embedding/enrichment/job 数量，以及数据库级工具调用数、错误数、平均/最大耗时和最近导入汇总。派生统计 embeddings/enrichments/pending_jobs 仅统计当前 scope 中未删除、未过期且正文 hash 仍匹配的来源；embeddings 按所有模型的有效存储行计数。软删或到期不物理删除这些行，恢复有效状态后可重新计入。导入指标最多保留最新 100 行（ID 有缺口也按行数计算），查询返回最近 10 行。指标写入失败不会改变业务操作结果。不会上传遥测，当前不是完整 Prometheus 或性能分析系统。

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

HTTP 客户端取消已接收的工具请求后，任务仍会在现有 Provider timeout/retries 等限制内完成；客户端断开不代表写入回滚。该任务在真正完成前继续占用并发名额，随后关闭 transport 并释放；不会因为反复取消绕过上限。正常停服会等待这些任务结束后再关闭数据库；进程强制终止不属于优雅停服。
