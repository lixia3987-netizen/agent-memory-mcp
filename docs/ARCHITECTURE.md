# 轻量化跨 Agent 长期记忆 MCP — 架构设计文档

> 文档版本：v1.1（0.2.1 配置勘误；原始版本见 ARCHITECTURE-v1.0.md）  
> 对应需求：Agent Memory MCP 一期 + 二期  
> 最终运行平台：Windows 10/11 x64  
> 核心运行时：Node.js 24.x  
> 可选环境：Python 3.12、JDK 21  
> 核心部署原则：No Docker / No WSL / No VM / No External DB Required

---

## 1. 架构目标

系统需要同时满足：

- 轻量；
- Windows 原生；
- MCP 标准接入；
- 多 Agent 共享；
- SQLite 单文件；
- 可迁移；
- 可测试；
- 可扩展；
- 一期不依赖 LLM/Embedding；
- 二期可选语义与图能力；
- 核心不依赖 Python/JDK；
- 允许 Codex Cloud/Linux 作为开发环境。

---

## 2. 总体架构

### 2.1 一期

```text
┌─────────────────────────────────────────────┐
│ MCP Clients                                 │
│                                             │
│ Claude Code / Cursor / Codex / Hermes       │
└──────────────────────┬──────────────────────┘
                       │ stdio MCP
                       ▼
┌─────────────────────────────────────────────┐
│ Agent Memory MCP                            │
│                                             │
│  MCP Transport                              │
│       ↓                                     │
│  Tool Router                                │
│       ↓                                     │
│  Memory Service                             │
│  Search Service                             │
│  Import/Export Service                      │
│  Policy / Validation                        │
│       ↓                                     │
│  Repository Layer                           │
│       ↓                                     │
│  SQLite Adapter                             │
└──────────────────────┬──────────────────────┘
                       │
                       ▼
                memory.db
             SQLite + FTS5
```

### 2.2 二期

```text
                     ┌──────────── LLM Provider (optional)
                     │
                     ├──────────── Embedding Provider (optional)
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│ Agent Memory MCP                                            │
│                                                             │
│ MCP Layer                                                   │
│   ↓                                                         │
│ Application Services                                        │
│   ├─ Memory Service                                         │
│   ├─ Search Service                                         │
│   ├─ Hybrid Search Service                                  │
│   ├─ Entity Service                                         │
│   ├─ Relation Service                                       │
│   ├─ Temporal Service                                       │
│   ├─ Enrichment Service                                     │
│   ├─ Import Service                                         │
│   └─ Maintenance Service                                    │
│                                                             │
│ Domain                                                      │
│   ├─ Memory                                                  │
│   ├─ Entity                                                  │
│   ├─ Relation                                                │
│   ├─ Fact/Temporal                                           │
│   └─ Policy                                                  │
│                                                             │
│ Infrastructure                                              │
│   ├─ SQLite Repository                                      │
│   ├─ FTS Index                                              │
│   ├─ Embedding Store                                        │
│   ├─ Graph Repository                                       │
│   ├─ Migration                                               │
│   └─ Backup                                                  │
└───────────────────────────────────┬─────────────────────────┘
                                    ▼
                                 SQLite
```

---

## 3. 技术选型

### 3.1 核心

```text
Language: TypeScript
Runtime: Node.js 24.x
Protocol: MCP
Database: SQLite
Search: SQLite FTS5
Package Manager: pnpm
```

### 3.2 SQLite Driver

首选：

```text
node:sqlite
```

理由：

- Node 24 内置；
- 避免额外 native npm module；
- Windows/Linux 安装行为一致；
- 不需要 node-gyp；
- 不携带平台相关 `*.node`；
- 更适合 Codex Cloud 开发 + Windows 最终运行。

启动时必须 capability check：

```sql
CREATE VIRTUAL TABLE __fts_test USING fts5(content);
DROP TABLE __fts_test;
```

如果 FTS5 不可用：

- `doctor` 明确报错；
- 一期正式运行默认 fail fast；
- 不静默退化为低质量 LIKE 搜索。

### 3.3 Python 3.12

仅作为可选能力：

- 离线导入工具；
- 实验性 NLP；
- 特定 Embedding/LLM Adapter；
- 数据迁移辅助脚本。

Core 不 import Python。

### 3.4 JDK 21

仅作为可选环境：

- Java 项目集成测试；
- 未来 Java Adapter；
- 企业环境已有 Java 服务桥接。

Core 不启动 JVM。

---

## 4. 项目目录结构

推荐：

```text
agent-memory-mcp/
├─ src/
│  ├─ index.ts
│  │
│  ├─ app/
│  │  ├─ bootstrap.ts
│  │  ├─ config.ts
│  │  └─ lifecycle.ts
│  │
│  ├─ mcp/
│  │  ├─ server.ts
│  │  ├─ transport/
│  │  │  ├─ stdio.ts
│  │  │  └─ http.ts              # 二期
│  │  └─ tools/
│  │     ├─ memory-add.ts
│  │     ├─ memory-search.ts
│  │     ├─ memory-get.ts
│  │     ├─ memory-update.ts
│  │     ├─ memory-delete.ts
│  │     ├─ memory-list.ts
│  │     ├─ memory-import.ts
│  │     ├─ memory-export.ts
│  │     └─ graph/                # 二期
│  │
│  ├─ domain/
│  │  ├─ memory/
│  │  ├─ entity/                  # 二期
│  │  ├─ relation/                # 二期
│  │  ├─ temporal/                # 二期
│  │  └─ policy/
│  │
│  ├─ services/
│  │  ├─ memory-service.ts
│  │  ├─ search-service.ts
│  │  ├─ import-service.ts
│  │  ├─ export-service.ts
│  │  ├─ backup-service.ts
│  │  ├─ hybrid-search-service.ts # 二期
│  │  ├─ graph-service.ts         # 二期
│  │  ├─ temporal-service.ts      # 二期
│  │  └─ enrichment-service.ts    # 二期
│  │
│  ├─ repositories/
│  │  ├─ memory-repository.ts
│  │  ├─ entity-repository.ts     # 二期
│  │  └─ relation-repository.ts   # 二期
│  │
│  ├─ infra/
│  │  ├─ sqlite/
│  │  │  ├─ database.ts
│  │  │  ├─ pragmas.ts
│  │  │  ├─ migrations/
│  │  │  ├─ memory-repository.ts
│  │  │  ├─ fts.ts
│  │  │  ├─ entity-repository.ts
│  │  │  └─ relation-repository.ts
│  │  ├─ providers/
│  │  │  ├─ embedding/            # 二期
│  │  │  └─ llm/                  # 二期
│  │  ├─ logging/
│  │  └─ backup/
│  │
│  ├─ importers/
│  │  ├─ importer.ts
│  │  ├─ json.ts
│  │  ├─ markdown.ts
│  │  ├─ claude-code.ts
│  │  └─ adapters/                # 二期
│  │
│  ├─ cli/
│  │  ├─ index.ts
│  │  └─ commands/
│  │
│  └─ shared/
│     ├─ errors.ts
│     ├─ validation.ts
│     ├─ paths.ts
│     ├─ hash.ts
│     └─ time.ts
│
├─ tests/
│  ├─ unit/
│  ├─ integration/
│  ├─ contract/
│  └─ smoke/
│
├─ docs/
│  ├─ REQUIREMENTS.md
│  └─ ARCHITECTURE.md
│
├─ package.json
├─ pnpm-lock.yaml
├─ tsconfig.json
├─ eslint.config.js
├─ AGENTS.md
└─ README.md
```

---

## 5. 分层原则

严格保持：

```text
MCP Tool
   ↓
Application Service
   ↓
Domain / Repository Interface
   ↓
Infrastructure Adapter
   ↓
SQLite / Provider
```

禁止：

```text
MCP Tool → 直接 SQL
```

原因：

- 测试困难；
- 二期无法扩展；
- 无法替换 Repository；
- MCP 协议层和业务耦合。

---

## 6. 核心 Domain

### 6.1 Memory

```ts
type Memory = {
  id: string
  namespace: string
  project?: string | null
  type: string
  title?: string | null
  content: string
  tags: string[]
  source: string
  importance: number
  createdAt: string
  updatedAt: string
  expiresAt?: string | null
  deletedAt?: string | null
  contentHash: string
  metadata?: Record<string, unknown> | null
}
```

Domain 不依赖 SQLite/MCP。

---

## 7. SQLite Schema — 一期

### 7.1 `schema_migrations`

```sql
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);
```

### 7.2 `memories`

```sql
CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  project TEXT,
  type TEXT NOT NULL,
  title TEXT,
  content TEXT NOT NULL,
  tags_json TEXT NOT NULL DEFAULT '[]',
  tags_text TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL,
  importance INTEGER NOT NULL DEFAULT 5
    CHECK (importance BETWEEN 1 AND 10),
  content_hash TEXT NOT NULL,
  metadata_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER,
  deleted_at INTEGER
);
```

索引：

```sql
CREATE INDEX idx_memories_scope
ON memories(namespace, project);

CREATE INDEX idx_memories_type
ON memories(type);

CREATE INDEX idx_memories_source
ON memories(source);

CREATE INDEX idx_memories_expiry
ON memories(expires_at);

CREATE INDEX idx_memories_deleted
ON memories(deleted_at);

CREATE INDEX idx_memories_hash
ON memories(namespace, project, content_hash);
```

---

## 8. FTS5

推荐外部内容或同步触发器方案。

示意：

```sql
CREATE VIRTUAL TABLE memories_fts USING fts5(
  title,
  content,
  tags_text,
  project,
  type,
  content='memories',
  content_rowid='rowid'
);
```

需要：

- insert trigger；
- update trigger；
- delete trigger；
- rebuild command。

注意：

FTS rowid 与 Memory id 分离，Memory 对外仍使用 UUID/string id。

---

## 9. 数据库初始化

启动流程：

```text
resolve config
↓
resolve data dir
↓
open DB
↓
PRAGMA
↓
capability check
↓
migration
↓
integrity lightweight check
↓
start MCP
```

推荐 PRAGMA：

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
```

数据库打开失败必须终止启动。

---

## 10. 多进程并发

由于多个 MCP 客户端可能各自启动 stdio Server：

```text
Process A ─┐
Process B ─┼── SQLite
Process C ─┤
Process D ─┘
```

策略：

- WAL；
- busy_timeout；
- 写事务尽量 < 100ms；
- 不在 transaction 中调用网络 API；
- migration 使用 `BEGIN IMMEDIATE`；
- 长操作分批；
- import 批次可配置。

二期 LLM/Embedding 调用必须在 DB transaction 外执行。

---

## 11. Memory 写入流程

一期：

```text
MCP request
↓
Schema Validation
↓
Policy Validation
↓
Normalize
↓
Hash
↓
Exact Dedup Check
↓
Transaction
↓
Insert Memory
↓
FTS Sync
↓
Commit
↓
Return ID
```

失败：

- rollback；
- 返回结构化 error；
- 不允许半写入。

---

## 12. Memory Search 流程 — 一期

```text
Query
↓
Normalize
↓
Scope Filter
↓
FTS5 MATCH
↓
BM25
↓
Remove deleted
↓
Remove expired
↓
Importance/Recency small boost
↓
Top K
↓
Snippet
↓
MCP result
```

### 12.1 排名策略

不要直接暴露 SQLite 原始 BM25 作为最终业务 score。

内部进行归一化。

推荐：

```text
final =
  lexical relevance * 0.80
  + importance * 0.12
  + recency * 0.08
```

权重必须配置化。

原则：

```text
相关性 > 重要度 > 新旧程度
```

---

## 13. Importer 架构

接口：

```ts
interface MemoryImporter {
  id: string
  canHandle(input: ImportInput): Promise<boolean>
  preview(input: ImportInput): Promise<ImportPreview>
  import(input: ImportInput, options: ImportOptions): AsyncIterable<MemoryDraft>
}
```

实现：

```text
JsonImporter
MarkdownImporter
ClaudeCodeImporter
```

二期：

```text
CursorImporter
CodexImporter
HermesImporter
```

只有确认第三方格式后才实现。

---

## 14. Claude Code Importer

流程：

```text
Input path / auto detect
↓
find memory/*.md
↓
read UTF-8
↓
frontmatter parse
↓
heading split
↓
normalize
↓
file/content hash
↓
preview
↓
memory_add pipeline
```

必须记录 metadata：

```json
{
  "importer": "claude-code",
  "sourcePath": "...",
  "sourceMtime": 123,
  "sourceHash": "..."
}
```

---

## 15. Export 架构

使用统一 DTO：

```text
Domain Memory
↓
Export DTO
↓
JSON Serializer / Markdown Serializer
```

导出内容不应直接依赖 SQLite row。

---

## 16. CLI 架构

```text
CLI
├─ serve
├─ init
├─ doctor
├─ migrate
├─ import
├─ export
├─ backup
├─ restore
├─ stats
└─ purge
```

CLI 与 MCP 共用 Application Service。

禁止维护两套业务逻辑。

---

# 二期架构

## 17. Provider 抽象

### 17.1 Embedding Provider

```ts
interface EmbeddingProvider {
  readonly id: string
  readonly model: string
  dimensions(): number
  embed(texts: string[]): Promise<number[][]>
}
```

实现可选：

```text
DisabledEmbeddingProvider
OpenAICompatibleEmbeddingProvider
CustomHttpEmbeddingProvider
```

未来可增加 Python bridge，但不能成为 Core 依赖。

### 17.2 LLM Provider

```ts
interface LlmProvider {
  readonly id: string
  structured<T>(
    prompt: string,
    schema: unknown
  ): Promise<T>
}
```

必须：

- timeout；
- retry limit；
- schema validation；
- circuit breaker/temporary disable。

---

## 18. Embedding Schema

```sql
CREATE TABLE memory_embeddings (
  memory_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  vector BLOB NOT NULL,
  content_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(memory_id, provider, model),
  FOREIGN KEY(memory_id) REFERENCES memories(id)
);
```

向量建议：

```text
Float32Array
→ Buffer/BLOB
```

一期不引入向量扩展。

二期默认轻量实现可：

1. lexical 先取候选；
2. semantic 对可控规模候选计算；
3. 后续通过 `VectorIndex` 接口替换实现。

---

## 19. Hybrid Search 架构

```text
Query
├─ FTS Search ──────────┐
├─ Embedding Search ────┤
└─ Entity/Graph Search ─┤
                        ▼
                  Rank Fusion
                        ↓
                Scope/Temporal Filter
                        ↓
                 Importance Boost
                        ↓
                       Top K
```

推荐 RRF：

```text
RRF(d) = Σ 1 / (k + rank_i(d))
```

再施加轻量：

```text
importance boost
recency boost
graph proximity boost
```

避免 BM25 与 cosine 原始数值直接相加。

---

## 20. Entity Schema

```sql
CREATE TABLE entities (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  project TEXT,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  canonical_name TEXT NOT NULL,
  attributes_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
```

Alias：

```sql
CREATE TABLE entity_aliases (
  entity_id TEXT NOT NULL,
  alias TEXT NOT NULL,
  normalized_alias TEXT NOT NULL,
  PRIMARY KEY(entity_id, normalized_alias),
  FOREIGN KEY(entity_id) REFERENCES entities(id)
);
```

---

## 21. Relation Schema

```sql
CREATE TABLE relations (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  project TEXT,
  source_entity_id TEXT NOT NULL,
  predicate TEXT NOT NULL,
  target_entity_id TEXT NOT NULL,
  attributes_json TEXT,
  confidence REAL NOT NULL DEFAULT 1.0,
  source_memory_id TEXT,
  valid_from INTEGER,
  valid_to INTEGER,
  superseded_by TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  FOREIGN KEY(source_entity_id) REFERENCES entities(id),
  FOREIGN KEY(target_entity_id) REFERENCES entities(id),
  FOREIGN KEY(source_memory_id) REFERENCES memories(id)
);
```

推荐索引：

```sql
(source_entity_id, predicate)
(target_entity_id, predicate)
(namespace, project)
(valid_from, valid_to)
(status)
```

---

## 22. Memory ↔ Entity

```sql
CREATE TABLE memory_entities (
  memory_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  role TEXT,
  confidence REAL NOT NULL DEFAULT 1.0,
  PRIMARY KEY(memory_id, entity_id, role),
  FOREIGN KEY(memory_id) REFERENCES memories(id),
  FOREIGN KEY(entity_id) REFERENCES entities(id)
);
```

---

## 23. Graph Query

SQLite 层只提供边查询。

图遍历由 Application Layer 完成：

```text
BFS / bounded traversal
maxDepth <= 3
maxNodes configurable
```

禁止用无界递归导致 MCP 卡死。

---

## 24. Temporal 架构

当前事实：

```text
valid_to IS NULL
AND status = active
```

历史查询：

```text
valid_from <= targetTime
AND (
  valid_to IS NULL
  OR valid_to > targetTime
)
```

Supersede 流程：

```text
new fact
↓
find current conflicting fact
↓
close old valid_to
↓
set superseded_by
↓
insert new relation
```

必须事务化。

---

## 25. Enrichment Pipeline

二期可选：

```text
Memory persisted
↓
Enrichment requested/enabled
↓
LLM outside transaction
├─ suggested type
├─ summary
├─ tags
├─ entities
└─ relations
↓
validate
↓
short DB transaction
↓
store enrichment
```

如果 LLM 失败：

```text
Memory 仍然有效
Enrichment = pending/failed
```

不得回滚原始记忆。

---

## 26. Enrichment Job

考虑 stdio 进程可能短生命周期，二期不默认依赖纯内存后台队列。

可建立 SQLite jobs：

```sql
CREATE TABLE enrichment_jobs (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  job_type TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

执行方式：

- 显式 `memory_enrich`；
- maintenance worker；
- HTTP 长驻模式。

---

## 27. Memory Policy

架构：

```text
MemoryDraft
↓
PolicyEngine
├─ size
├─ type
├─ source
├─ secret
├─ TTL
├─ importance
└─ dedupe
↓
Accept / Modify / Reject
```

配置可 JSON 化。

---

## 28. Secret Protection

核心不做复杂 DLP，但至少支持：

- 常见 API key pattern；
- private key header；
- password/token 字段名；
- 用户自定义 regex。

检测到后：

- 默认拒绝；
- 或 redact；
- 不写日志。

---

## 29. HTTP MCP（二期可选）

```text
localhost only by default
```

架构：

```text
MCP HTTP Transport
↓
same Tool Router
↓
same Application Service
```

不能复制业务层。

远程模式如果实现：

- token auth；
- TLS 由上层代理；
- explicit enable；
- audit log。

---

## 30. 配置架构

当前完整字段及校验以 `src/app/config.ts`、`src/domain/phase2-config.ts` 为准，示例见 `examples/config.json` 和 `examples/config.phase2.json`。以下为部分字段示意。

词法排序采用 BM25 乘以轻微重要度/新近度增益，不使用独立 `lexicalWeight`。原草案的 `lexicalWeight/importanceWeight/recencyWeight` 从未成为已实现的配置；0.2.1 起未知 search 字段会明确报错，避免静默失效。

```text
lexical_score = -BM25 × (1 + importanceBoost × importance/10 + recencyBoost/(1 + ageDays/90))
```

示意类型：

```ts
type AppConfig = {
  homeDir: string
  dbPath: string
  logLevel: string

  search: {
    defaultLimit: number
    maxLimit: number
    importanceBoost: number // 默认 0.12，范围 0–0.2
    recencyBoost: number    // 默认 0.08，范围 0–0.1
  }

  embedding?: {
    enabled: boolean
    baseUrl?: string
    model?: string
    apiKeyEnv?: string
  }

  llm?: {
    maxAttempts?: number // 0.2.3：任务执行次数，默认 3；不同于 HTTP retries
    enabled: boolean
    baseUrl?: string
    model?: string
    apiKeyEnv?: string
  }

  http?: {
    enabled: boolean
    host: string
    port: number
  }
}
```

所有 optional provider 默认 `enabled=false`。

---

## 31. 路径策略

必须集中在：

```text
src/shared/paths.ts
```

Windows 默认：

```text
%LOCALAPPDATA%\AgentMemoryMCP
```

允许：

```text
AGENT_MEMORY_HOME
```

覆盖。

测试不得硬编码：

```text
C:\
/home/xxx
/tmp
```

统一使用临时目录 API。

---

## 32. 错误体系

统一 Domain Error：

```ts
class AppError extends Error {
  code: string
  details?: unknown
  retryable: boolean
}
```

错误边界：

```text
Infrastructure Error
↓ map
AppError
↓ map
MCP Error Result
```

不得把 SQLite stack trace 直接暴露给 Agent。

Debug log 可记录内部 stack。

---

## 33. 日志架构

默认 stderr。

建议 JSON structured logging。

例如：

```json
{
  "level": "info",
  "event": "memory.search",
  "project": "demo",
  "count": 10,
  "durationMs": 24
}
```

默认不记录正文。

---

## 34. Backup

SQLite backup 策略：

- migration 前；
- import 大批量前可选；
- CLI 手工；
- 定期策略二期。

备份文件：

```text
memory-20260908-113000.db
```

恢复：

```text
verify
↓
backup current
↓
close DB
↓
replace atomically
↓
open
↓
integrity_check
```

---

## 35. Migration

规则：

- 只允许顺序 migration；
- migration 有版本号；
- migration 在事务内；
- migration 前 backup；
- 多进程时使用锁；
- downgrade 不作为默认能力。

示例：

```text
001_init.sql
002_fts.sql
003_import_metadata.sql
101_entities.sql
102_relations.sql
103_embeddings.sql
```

建议 `1xx` 作为二期功能。

---

## 36. 测试架构

### Unit

无数据库或内存数据库：

- services；
- policies；
- ranking；
- parser；
- normalization。

### Integration

临时真实 SQLite：

- migrations；
- FTS；
- CRUD；
- TTL；
- concurrency；
- graph；
- temporal。

### MCP Contract

真实 Server：

- tools/list；
- tool schemas；
- tool call；
- error mapping。

### Windows Smoke

Windows CI：

```text
install
build
test
doctor
init
serve
MCP handshake
CRUD
search
exit
```

---

## 37. CI/CD

推荐 GitHub Actions：

```text
ubuntu-latest
windows-latest
```

Codex Cloud 可以主要在 Linux 完成开发。

但 Release Gate：

```text
windows-latest 必须通过
```

Release 不携带：

- node_modules；
- Linux native binary；
- 用户数据库。

---

## 38. Package / Release

推荐发布形式：

### 38.1 npm

```text
@your-scope/agent-memory-mcp
```

入口：

```text
agent-memory-mcp
```

### 38.2 Windows ZIP

```text
agent-memory-mcp-win/
├─ dist/
├─ package.json
├─ pnpm-lock.yaml
└─ README.md
```

目标机器：

```powershell
pnpm install --prod --frozen-lockfile
node dist/index.js
```

Node 24 为目标机器前置。

---

## 39. MCP 客户端接入

通用思路：

```json
{
  "mcpServers": {
    "memory": {
      "command": "node",
      "args": [
        "C:\\tools\\agent-memory-mcp\\dist\\index.js"
      ],
      "env": {
        "AGENT_MEMORY_HOME": "C:\\Users\\<user>\\AppData\\Local\\AgentMemoryMCP"
      }
    }
  }
}
```

不同客户端配置文件位置不同，由安装文档分别提供。

---

## 40. Repository 可替换性

虽然一二期默认 SQLite，但必须保留：

```ts
interface MemoryRepository
```

未来允许：

```text
SQLite
→ PostgreSQL
→ MySQL
→ Neo4j/FalkorDB adapter
```

注意：

Graph 能力不应假设 MySQL 是图数据库。

未来外部数据库只是可选 Adapter，不改变 MCP Tool 接口。

---

## 41. 性能策略

一期：

- prepared statement；
- FTS；
- 索引；
- limit；
- snippet 限制；
- batch import transaction；
- 避免 N+1。

二期：

- RRF；
- embedding cache；
- content_hash 失效；
- bounded graph；
- batch provider request；
- provider timeout。

---

## 42. 数据一致性

核心原则：

```text
原始 Memory > 派生数据
```

原始 Memory 是 source of truth。

派生：

- FTS；
- embedding；
- entity；
- relation；
- summary；

均可以重建。

因此出现损坏时优先：

```text
rebuild FTS
rebuild embedding
re-enrich entity/relation
```

而不是修改原始正文。

---

## 43. 二期与 Graphiti 的边界

该项目二期借鉴：

- entity/relation；
- temporal facts；
- semantic + graph search；

但不试图复制完整 Graphiti。

保留轻量边界：

- SQLite；
- limited graph traversal；
- optional LLM；
- optional embedding；
- no graph DB service。

当规模达到 SQLite 不再合适时，再实现外部 Graph Repository Adapter。

---

## 44. 核心架构决策摘要

### ADR-001：Node 24 为唯一必需运行时

原因：

- MCP TS 生态；
- Windows 友好；
- 可直接发布；
- 避免多语言核心部署。

### ADR-002：Python 3.12/JDK 21 仅 optional

原因：

- 工作环境可能已有；
- 未来 Adapter 可利用；
- 不应扩大核心部署复杂度。

### ADR-003：SQLite 作为核心数据源

原因：

- 单文件；
- Windows 原生；
- 无服务进程；
- 低内存；
- 易备份；
- 支持 FTS5。

### ADR-004：一期仅 stdio

原因：

- 安全；
- 简单；
- 兼容；
- 不占端口。

### ADR-005：二期语义/LLM全部 optional

原因：

- 数据合规；
- 离线可用；
- 成本；
- 稳定性。

### ADR-006：图能力在 SQLite 应用层实现

原因：

- 用户环境限制；
- 规模可控；
- 不引入 Neo4j/FalkorDB。

### ADR-007：Windows 是 Release Gate

原因：

- 最终目标运行环境 Windows；
- 云开发环境可能是 Linux；
- 防止路径/权限/原生依赖问题。

---

## 45. 推荐开发原则

1. Core 不依赖可选模块；
2. Tool 不直接访问 DB；
3. 原始 Memory 永不由 enrichment 覆盖；
4. 一切派生索引必须可重建；
5. 所有网络能力默认关闭；
6. 所有 provider 失败可降级；
7. 所有删除默认可恢复；
8. 所有 migration 可审计；
9. 所有 Release 在 Windows 验证；
10. 不因为二期功能破坏一期简单性。

---

## 46. 最终架构定位

```text
           Agent Clients
                │
                ▼
             MCP API
                │
                ▼
        Application Services
                │
     ┌──────────┼───────────┐
     ▼          ▼           ▼
 Memory      Search       Graph/Temporal
     │          │           │
     └──────────┼───────────┘
                ▼
          Repository Layer
                │
                ▼
             SQLite
        ┌───────┼────────┐
        ▼       ▼        ▼
      Data     FTS     Derived
                       Embedding
                       Entity
                       Relation
```

该架构确保一期可以保持：

> 一个 Node 进程 + 一个 SQLite 文件

同时二期仍可以逐步获得：

> 语义检索 + 轻量知识图谱 + 时间事实 + 多 Agent 共享长期记忆

而不引入 Docker、WSL、虚拟机或强制外部数据库。
