# 轻量化跨 Agent 长期记忆 MCP — 需求规格说明书

> 文档版本：v1.0  
> 目标项目代号：Agent Memory MCP  
> 目标运行平台：Windows 10/11 x64  
> 核心运行时：Node.js 24.x  
> 可选环境：Python 3.12、JDK 21（均不是核心运行前置条件）  
> 部署约束：不得依赖 Docker、WSL、虚拟机或外部数据库服务

---

## 1. 项目背景

当前 Claude Code、Cursor、Codex、Hermes 等开发 Agent 通常拥有各自独立的会话上下文、项目规则或本地记忆，存在以下问题：

1. 不同 Agent 之间无法共享长期知识；
2. 项目决策、历史 Bug、解决方案、技术约束容易重复解释；
3. Claude Code 等工具已有的本地记忆难以迁移到其他 Agent；
4. 完整知识图谱方案（Graphiti + Neo4j/FalkorDB）部署较重；
5. 受限 Windows 工作环境可能无法使用 Docker、WSL、虚拟机；
6. 企业工作电脑可能不允许部署额外数据库服务或长期驻留的复杂基础设施。

因此需要开发一个轻量、本地优先、跨 Agent、可扩展的长期记忆 MCP Server。

---

## 2. 项目目标

### 2.1 核心目标

构建一个可由多个 MCP 客户端共享使用的长期记忆系统：

```text
Claude Code ─┐
Cursor ──────┤
Codex ───────┼── MCP ──→ Agent Memory MCP ──→ SQLite
Hermes ──────┘
```

系统应支持：

- 保存项目长期知识；
- 搜索历史知识；
- 更新、删除、导入、导出记忆；
- 项目/命名空间隔离；
- 重要度、来源、TTL、软删除；
- 全文检索；
- Claude Code Memory 迁移；
- 后续扩展语义检索、轻量知识图谱、时间事实；
- Windows 原生运行；
- Linux/macOS/Codex Cloud 可用于开发与测试；
- 最终 Release 必须通过 Windows 验证。

### 2.2 非目标

一期、二期均不以以下内容为核心目标：

- 不开发完整知识管理 GUI；
- 不替代关系型业务数据库；
- 不实现 Neo4j/FalkorDB 级别的通用图数据库；
- 不实现企业级分布式存储；
- 不默认上传任何工作数据到云端；
- 不强制使用 LLM；
- 不强制使用 Embedding；
- 不依赖 Python/JDK 才能启动核心服务；
- 不依赖 Docker、WSL、VM。

---

## 3. 用户与使用场景

### 3.1 主要用户

1. **开发者**
   - 希望多个 Agent 共享项目知识；
   - 需要迁移 Claude Code 记忆；
   - 希望减少重复解释。

2. **MCP 客户端**
   - Claude Code
   - Cursor
   - Codex
   - Hermes
   - 其他支持 MCP 的 Agent

3. **维护者**
   - 管理数据库；
   - 导入/导出；
   - 执行备份；
   - 查看状态；
   - 处理迁移。

### 3.2 典型记忆内容

应该保存：

- 架构决策；
- 项目长期约束；
- Bug 根因；
- 已验证解决方案；
- 开发规范；
- 用户明确偏好；
- 环境配置原则；
- 重要依赖及原因；
- 工作流；
- 反复踩坑问题；
- 重要外部资料摘要；
- 项目长期状态。

不建议保存：

- 每次编译成功记录；
- 普通 shell 输出；
- 大量临时日志；
- 整段源码副本；
- 一次性无长期价值任务；
- 寒暄；
- 无筛选的完整聊天记录；
- API Key、密码、Token 等秘密信息。

---

# 第一部分：一期需求

## 4. 一期目标

一期目标是建立一个完全本地可运行、无外部数据库依赖、无 LLM 依赖的可靠 Memory MCP。

核心技术目标：

```text
TypeScript
+ Node.js 24
+ 官方 MCP TypeScript SDK
+ SQLite
+ FTS5
```

一期必须可在 Windows 原生运行。

---

## 5. 一期功能范围

### 5.1 MCP Server

系统必须实现标准 MCP Server。

一期默认传输方式：

- `stdio`

原因：

- 客户端兼容性好；
- 无需监听网络端口；
- 安全边界简单；
- 更适合受限办公电脑。

要求：

- 启动失败必须输出明确错误；
- MCP 协议错误不得导致数据库损坏；
- stderr 用于诊断日志；
- stdout 不得输出破坏 MCP 协议的数据。

---

## 6. Memory 数据模型

一期 Memory 至少包含以下字段：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---:|---|
| id | string/UUID | 是 | 唯一 ID |
| namespace | string | 是 | 顶级隔离域 |
| project | string/null | 否 | 项目标识 |
| type | string | 是 | 记忆类型 |
| title | string/null | 否 | 简短标题 |
| content | string | 是 | 记忆正文 |
| tags | string[] | 否 | 标签 |
| source | string | 是 | 来源 |
| importance | integer 1-10 | 是 | 重要程度 |
| created_at | timestamp | 是 | 创建时间 |
| updated_at | timestamp | 是 | 更新时间 |
| expires_at | timestamp/null | 否 | TTL |
| deleted_at | timestamp/null | 否 | 软删除时间 |
| content_hash | string | 是 | 去重辅助 |
| metadata | object/null | 否 | 扩展元数据 |

### 6.1 推荐 type

内置建议：

- `decision`
- `bug`
- `solution`
- `preference`
- `convention`
- `workflow`
- `environment`
- `reference`
- `fact`
- `note`
- `other`

必须允许自定义 type，不应把业务锁死在固定枚举。

### 6.2 namespace

建议：

```text
global
work/<project>
personal
team/<name>
```

一期至少必须支持：

- namespace 精确过滤；
- project 精确过滤；
- global 记忆单独存储；
- 不同项目之间默认不串数据。

---

## 7. 一期 MCP Tools

一期必须实现以下 8 个核心工具。

### 7.1 `memory_add`

功能：

- 新增记忆；
- 校验字段；
- 自动生成 ID；
- 自动创建时间；
- 计算内容 hash；
- 检测完全重复内容。

参数至少包括：

- namespace
- project
- type
- title
- content
- tags
- source
- importance
- expires_at
- metadata

行为：

- importance 默认 `5`；
- source 未传时允许客户端名作为默认来源；
- 完全相同内容可返回已有 ID，避免重复写入；
- 禁止空 content。

---

### 7.2 `memory_search`

支持：

- 全文查询；
- namespace；
- project；
- type；
- tags；
- source；
- importance 下限；
- 时间范围；
- limit；
- 是否包含过期；
- 是否包含已删除。

默认：

- 不返回软删除；
- 不返回过期；
- limit 默认 10；
- limit 必须有最大值保护。

返回至少包括：

- id
- title
- snippet
- type
- project
- tags
- source
- importance
- score
- created_at
- updated_at

---

### 7.3 `memory_get`

按 ID 获取完整 Memory。

默认不返回已软删除数据，除非显式指定。

---

### 7.4 `memory_update`

允许更新：

- title
- content
- tags
- type
- source
- importance
- expires_at
- metadata
- project

要求：

- 更新时间自动刷新；
- content 改变时重新生成 hash；
- FTS 索引同步更新；
- 不允许修改 id。

---

### 7.5 `memory_delete`

默认执行软删除：

```text
deleted_at = now
```

一期 MCP 不允许默认物理删除。

可通过维护 CLI 提供显式 purge，但必须是独立高风险操作。

---

### 7.6 `memory_list`

用于结构化浏览。

支持：

- namespace
- project
- type
- source
- tag
- pagination
- sort
- includeExpired
- includeDeleted

不要求全文查询。

---

### 7.7 `memory_import`

一期支持：

1. JSON；
2. Markdown；
3. Claude Code Memory。

必须实现：

- dry-run；
- 导入统计；
- 导入来源记录；
- 文件 hash；
- 幂等导入；
- 冲突策略。

冲突策略：

- `skip`
- `update`
- `copy`

默认：`skip`。

---

### 7.8 `memory_export`

一期支持：

- JSON；
- Markdown。

支持过滤：

- namespace
- project
- type
- 时间范围
- source

导出必须包含 schemaVersion。

---

## 8. 全文检索

一期必须使用 SQLite FTS5。

检索字段至少包含：

- title
- content
- tags
- project
- type

### 8.1 排序

基础排序：

```text
FTS BM25
+ importance boost
+ recency boost
```

推荐原则：

- BM25 为主；
- importance 只能做小幅加权；
- recency 不得压倒相关性；
- 不允许只因为“最近”就返回无关数据。

### 8.2 中文

要求：

- UTF-8；
- 能保存中文；
- 能搜索完整中文短语；
- 对中文分词效果不做一期强制保证；
- 架构必须允许二期替换/增强 tokenizer。

---

## 9. TTL

Memory 可设置：

```text
expires_at
```

规则：

- 搜索默认忽略已过期数据；
- get 默认可返回“已过期”状态但不作为活跃结果；
- 不必须实时物理删除；
- maintenance 时可清理；
- 导出可选择是否包含过期数据。

---

## 10. 软删除

所有普通删除必须是 Soft Delete。

要求：

- 可审计；
- 可恢复；
- 默认搜索不可见；
- 维护 CLI 支持 restore；
- purge 必须显式执行。

---

## 11. 去重

一期实现轻量去重。

至少：

```text
namespace
+ project
+ normalized content
```

生成 hash。

要求：

- 完全相同内容不得无限重复写入；
- 导入必须可幂等；
- 不做复杂语义去重。

语义去重属于二期。

---

## 12. Claude Code Memory 导入

一期重点能力之一。

支持读取 Claude Code 项目 Memory：

```text
~/.claude/projects/**/memory/*.md
```

Windows 应正确解析用户目录。

导入内容包括：

- `MEMORY.md`
- 项目 memory Markdown 文件；
- Markdown frontmatter（存在时）；
- 文件路径；
- 修改时间；
- 文件 hash。

导入规则：

- 一个文件可作为一条或多条 Memory；
- 推荐按二级/三级标题切分；
- 保留原 source path；
- source 标记为 `claude-code`；
- 必须支持 dry-run；
- 重复运行不得重复导入相同内容。

不得假定未来 Claude Code Memory 格式永久不变。

Importer 必须独立封装。

---

## 13. JSON / Markdown 导入导出

### 13.1 JSON

要求：

```json
{
  "schemaVersion": 1,
  "exportedAt": "...",
  "memories": []
}
```

必须保证：

- 可再次导入；
- ID 冲突可处理；
- 保留时间字段；
- 保留 metadata。

### 13.2 Markdown

建议格式：

```markdown
---
id: ...
namespace: ...
project: ...
type: decision
source: claude-code
importance: 8
tags:
  - yjs
  - architecture
created_at: ...
---

# 标题

正文
```

---

## 14. CLI

一期除 MCP 外，应提供维护 CLI。

建议命令：

```text
agent-memory-mcp serve
agent-memory-mcp init
agent-memory-mcp doctor
agent-memory-mcp migrate
agent-memory-mcp import
agent-memory-mcp export
agent-memory-mcp backup
agent-memory-mcp restore
agent-memory-mcp stats
agent-memory-mcp purge
```

### 14.1 doctor

至少检查：

- Node 版本；
- 数据目录权限；
- SQLite 是否可用；
- FTS5 是否可用；
- DB schema；
- 数据库可写；
- 配置是否有效。

---

## 15. 配置

配置优先级：

```text
CLI 参数
> 环境变量
> 配置文件
> 默认值
```

推荐环境变量：

```text
AGENT_MEMORY_HOME
AGENT_MEMORY_DB
AGENT_MEMORY_LOG_LEVEL
AGENT_MEMORY_NAMESPACE
```

Windows 默认目录建议：

```text
%LOCALAPPDATA%\AgentMemoryMCP\
```

目录：

```text
AgentMemoryMCP/
├─ data/
│  └─ memory.db
├─ backup/
├─ logs/
└─ config/
```

---

## 16. 数据库要求

一期使用单文件 SQLite。

要求：

- WAL；
- foreign_keys = ON；
- busy timeout；
- schema migrations；
- 短事务；
- 崩溃后可恢复；
- 不允许每次启动重建数据库；
- migration 必须向前兼容；
- migration 失败不得继续启动写模式。

---

## 17. 多 Agent 并发

不同客户端可能分别启动 MCP stdio 进程，但访问同一个 DB。

必须处理：

```text
Claude MCP process ─┐
Cursor MCP process ─┼── memory.db
Codex MCP process ──┤
Hermes MCP process ─┘
```

要求：

- WAL；
- busy timeout；
- 写操作短事务；
- 避免长时间锁表；
- migration 使用互斥策略；
- 并发写失败返回可诊断错误；
- 不得静默丢数据。

---

## 18. 日志

一期需要结构化日志。

等级：

- error
- warn
- info
- debug

禁止日志记录：

- API Key；
- Token；
- 密码；
- 完整敏感 Memory 正文（默认）。

允许记录：

- tool 名称；
- memory id；
- namespace；
- project；
- 耗时；
- 错误代码；
- import 统计。

---

## 19. 安全

一期默认：

- local-first；
- stdio；
- 不监听公网；
- 不自动上传数据；
- 不依赖云端服务。

导入文件需要限制：

- 默认只允许用户显式指定路径；
- 支持允许目录列表；
- 防止路径穿越；
- 不跟随危险符号链接；
- 文件大小限制；
- 单次导入数量限制。

---

## 20. 备份与恢复

一期必须支持数据库备份。

要求：

- 手工 backup；
- 导入前可选自动 backup；
- migration 前必须自动 backup；
- 备份文件含时间戳；
- restore 前验证数据库；
- restore 不得直接覆盖唯一副本。

---

## 21. 一期测试要求

### 21.1 单元测试

覆盖：

- validation
- repository
- ranking
- hash
- TTL
- soft delete
- import parser
- export serializer

### 21.2 集成测试

覆盖：

- SQLite；
- FTS5；
- MCP tool；
- migration；
- import/export round trip；
- 并发读写。

### 21.3 Windows Smoke Test

Release 必须在 Windows 执行：

```text
pnpm install --frozen-lockfile
pnpm build
pnpm test
node dist/index.js / CLI serve smoke test
```

Linux/Codex Cloud 测试通过不能替代 Windows Release Gate。

---

## 22. 一期验收标准

一期完成必须满足：

- [ ] Windows 10/11 原生运行；
- [ ] Node.js 24.x 可启动；
- [ ] 无 Docker；
- [ ] 无 WSL；
- [ ] 无 VM；
- [ ] 无外部数据库；
- [ ] 不需要 Python；
- [ ] 不需要 JDK；
- [ ] 8 个核心 MCP Tool 可用；
- [ ] SQLite 数据持久化；
- [ ] FTS5 + BM25；
- [ ] namespace/project 隔离；
- [ ] source/importance/TTL/soft delete；
- [ ] JSON/Markdown 导入导出；
- [ ] Claude Code Memory 导入；
- [ ] migration；
- [ ] backup/restore；
- [ ] 单测与集成测试；
- [ ] Windows smoke test；
- [ ] README 安装说明完整。

---

# 第二部分：二期需求

## 23. 二期目标

二期在一期可靠本地记忆基础上增加：

```text
语义搜索
+
轻量知识图谱
+
时间事实
+
多来源记忆
+
智能去重/合并
+
可选 LLM enrichment
```

二期仍坚持：

- SQLite 为默认核心存储；
- 不强制 Neo4j/FalkorDB；
- 不强制 Docker/WSL；
- 不强制 Python/JDK；
- 无 LLM/Embedding 时仍可运行基础能力。

---

## 24. Embedding 与语义检索

二期增加可插拔 Embedding Provider。

接口概念：

```ts
interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>
  dimensions(): number
  modelId(): string
}
```

Provider 可以是：

- OpenAI-compatible API；
- 企业内部 API；
- 本地服务；
- 自定义插件；
- disabled。

### 24.1 默认行为

Embedding 必须是可选功能。

当未配置 Provider：

- MCP 正常启动；
- FTS 搜索继续工作；
- semantic search 自动禁用；
- 不得启动失败。

### 24.2 Embedding 存储

至少保存：

- memory_id
- provider
- model
- dimensions
- vector
- created_at
- content_hash

当正文改变：

- 旧 embedding 失效；
- 可延迟重新生成。

---

## 25. Hybrid Search

二期搜索融合：

```text
FTS/BM25
+
Semantic Search
+
Graph Context
+
Importance
+
Recency
```

推荐使用 RRF 或同类 rank fusion，避免不同得分体系直接相加。

要求：

- 搜索模式可选择：
  - lexical
  - semantic
  - hybrid
- semantic provider 不可用时自动回退 lexical；
- graph 不可用时不影响基础搜索。

---

## 26. 轻量知识图谱

二期使用 SQLite 建立轻量 Entity/Relation。

不要求完整图数据库能力。

### 26.1 Entity

建议字段：

- id
- namespace
- project
- type
- name
- canonical_name
- attributes
- created_at
- updated_at
- deleted_at

推荐实体类型：

- Project
- Module
- Technology
- Dependency
- Decision
- Bug
- Solution
- Preference
- Convention
- Workflow
- Tool
- Document
- ExternalResource
- Person
- Other

允许自定义类型。

### 26.2 Relation

字段至少：

- id
- namespace
- project
- source_entity_id
- predicate
- target_entity_id
- attributes
- confidence
- source_memory_id
- valid_from
- valid_to
- superseded_by
- created_at
- updated_at
- deleted_at

关系示例：

```text
Project ─HAS_MODULE→ Module
Module ─USES→ Technology
Bug ─OCCURRED_IN→ Module
Bug ─CAUSED_BY→ Cause
Bug ─FIXED_BY→ Solution
Decision ─APPLIES_TO→ Project
Decision ─REPLACED_BY→ Decision
User ─PREFERS→ Preference
Project ─USES_WORKFLOW→ Workflow
```

---

## 27. 图谱查询

二期增加：

- entity search；
- relation search；
- neighbor query；
- limited path traversal。

建议最大深度：

```text
maxDepth <= 3
```

防止 SQLite 上执行无限图遍历。

---

## 28. 时间事实 / Temporal Memory

二期支持事实随时间变化。

例如：

```text
2026-06 ProjectA USES Yjs
2026-10 ProjectA MIGRATED_TO OT
```

必须支持：

- valid_from；
- valid_to；
- superseded_by；
- active/inactive；
- 历史事实保留；
- 当前事实查询；
- 指定时间点查询。

新事实不应默认物理覆盖旧事实。

---

## 29. 冲突与替代

当系统发现相同实体关系存在冲突：

```text
ProjectA USES Yjs
ProjectA USES OT
```

不得直接删除旧事实。

可形成：

```text
旧 relation.valid_to = 新事实生效时间
旧 relation.superseded_by = new_relation_id
```

无法自动判断时：

- 两条事实均保留；
- confidence 降低；
- 标记 conflict；
- 由 Agent 或用户确认。

---

## 30. 智能去重

二期增加：

- 近似文本去重；
- Embedding 相似度；
- Entity alias；
- 同义 Memory 候选；
- merge proposal。

默认不得自动破坏性合并。

推荐：

```text
detect
→ suggest
→ confirm/merge
```

Agent 可显式请求自动合并，但必须保留来源。

---

## 31. 可选 LLM Enrichment

二期允许配置可选 LLM Provider，用于：

- 自动摘要；
- memory type 建议；
- tag 建议；
- entity 抽取；
- relation 抽取；
- 冲突判断辅助；
- importance 建议。

要求：

- 核心服务不依赖 LLM；
- 未配置时功能关闭；
- LLM 失败不得影响原始 Memory 落库；
- LLM 输出必须 schema validation；
- 不得把 API Key 存入数据库。

---

## 32. 多来源 Importer

二期建立 Importer Plugin 接口。

至少提供：

- Claude Code importer（一期开出的能力升级为标准 Adapter）；
- Generic Markdown；
- Generic JSON。

根据实际可获取格式扩展：

- Cursor；
- Codex；
- Hermes。

要求：

- 不假设第三方内部格式稳定；
- 每个 importer 单独包/模块；
- 有 version detection；
- 支持 dry-run；
- 支持幂等；
- 保存 source metadata。

---

## 33. Memory Policy

二期增加可配置写入策略。

用于避免 Agent 把所有内容都写入记忆。

策略维度：

- type；
- source；
- importance；
- namespace；
- content size；
- secret detection；
- duplicate threshold；
- TTL default。

例如：

```text
decision      默认 importance >= 8
bug/solution  默认 importance >= 6
temporary     默认 TTL 7d
shell-log     reject
```

---

## 34. 自动维护

二期增加 maintenance。

能力：

- 清理过期数据；
- purge 已软删除数据；
- orphan entity cleanup；
- embedding rebuild；
- FTS rebuild；
- graph consistency check；
- duplicate report；
- DB vacuum；
- stats。

不得在高频 MCP 请求中执行长时间 maintenance。

---

## 35. 二期新增 MCP Tools

建议新增：

```text
memory_restore
memory_stats
memory_enrich
memory_find_duplicates
memory_merge

entity_add
entity_search
entity_get
entity_update

relation_add
relation_search
relation_update

graph_neighbors
graph_path

memory_search_hybrid
memory_at_time
```

一期 Tool 名称和语义必须保持兼容。

---

## 36. HTTP 共享服务模式

二期可增加可选 HTTP/Streamable HTTP MCP Server。

用途：

```text
多个 Agent
→ 同一个长期驻留 MCP
→ 同一 SQLite
```

要求：

- 默认仍保持 stdio；
- HTTP 必须显式启用；
- 默认仅绑定 localhost；
- 不允许默认监听 `0.0.0.0`；
- 如支持远程必须增加认证。

---

## 37. 可观测性

二期增加：

- tool latency；
- search latency；
- DB size；
- memory count；
- active/expired/deleted count；
- entity/relation count；
- embedding count；
- import stats；
- error metrics。

不得默认采集遥测上传第三方。

---

## 38. 二期验收标准

- [ ] 一期所有功能保持兼容；
- [ ] Embedding 可选；
- [ ] 无 Embedding 时可正常使用；
- [ ] Hybrid Search；
- [ ] SQLite 轻量 Entity/Relation；
- [ ] 时间事实；
- [ ] supersede/conflict；
- [ ] 智能去重候选；
- [ ] 可选 LLM enrichment；
- [ ] importer adapter；
- [ ] maintenance；
- [ ] graph query；
- [ ] Windows 原生运行；
- [ ] 不依赖 Docker/WSL/VM；
- [ ] Python/JDK 仍不是必需环境；
- [ ] Windows 回归测试通过。

---

# 第三部分：非功能需求

## 39. 运行环境

### 39.1 必需

```text
Windows 10/11 x64
Node.js 24.x
```

最终生产/个人运行环境以 Windows 为准。

### 39.2 可选

```text
Python 3.12
JDK 21
```

注意：

> Python 3.12 和 JDK 21 只是允许存在的可选环境，不意味着项目必须使用。

规则：

- 核心 MCP 不能因为未安装 Python 而失败；
- 核心 MCP 不能因为未安装 JDK 而失败；
- 如未来某 Adapter 使用 Python/JDK，应独立声明；
- optional module 不得污染 core dependency。

### 39.3 开发环境

允许：

- Windows；
- Linux；
- macOS；
- Codex Cloud Linux。

但：

```text
开发平台可以不同
最终验证平台必须包含 Windows
```

---

## 40. 跨平台开发规则

禁止依赖：

- bash-only runtime；
- Linux-only 文件路径；
- chmod 作为核心能力；
- `/tmp` 固定路径；
- POSIX-only socket；
- symlink 语义假设。

必须使用：

- `node:path`
- `node:os`
- Node 标准文件 API；
- 平台无关路径拼接。

---

## 41. 性能目标

一期建议目标（非硬实时 SLA）：

- 空闲 RSS：尽量 ≤ 150 MB；
- 冷启动：典型机器 ≤ 2 秒；
- 5 万条 Memory 的普通 FTS 查询：P95 ≤ 150 ms；
- 单条写入：P95 ≤ 100 ms；
- MCP Tool 不应长期阻塞 event loop。

二期：

- hybrid search 除外部 API 时间外，本地处理目标 ≤ 500 ms；
- 图查询最大深度限制；
- Embedding 可异步/按需生成。

---

## 42. 数据规模目标

一期设计目标：

```text
Memory: 100,000
单条正文建议 <= 64 KB
```

二期设计目标：

```text
Entity: 100,000
Relation: 500,000
```

超过该规模仍应可运行，但可能需要后续外部数据库 Adapter。

---

## 43. 兼容性

必须做到：

- schema 可迁移；
- tool 向后兼容；
- export 带 schemaVersion；
- importer 可版本化；
- repository 可替换；
- provider 可插拔。

---

## 44. 隐私

默认原则：

```text
Local First
No Telemetry
No Cloud Upload
```

只有用户显式配置：

- LLM Provider；
- Embedding Provider；
- Remote MCP；

才允许发生外部网络请求。

---

## 45. 错误处理

错误必须分类：

- VALIDATION_ERROR
- NOT_FOUND
- CONFLICT
- DATABASE_BUSY
- DATABASE_CORRUPT
- MIGRATION_FAILED
- IMPORT_FAILED
- PROVIDER_UNAVAILABLE
- PERMISSION_DENIED
- UNSUPPORTED_FORMAT
- INTERNAL_ERROR

不得向 Agent 返回无意义：

```text
Something went wrong
```

必须附可操作信息。

---

# 第四部分：实施优先级

## 46. 一期实施顺序

```text
P1-0 项目骨架 / CI / Windows Gate
P1-1 SQLite / migrations
P1-2 Memory Repository
P1-3 MCP Tools CRUD
P1-4 FTS5 / BM25
P1-5 namespace / TTL / soft delete / dedupe
P1-6 JSON/Markdown Import Export
P1-7 Claude Memory Importer
P1-8 CLI / doctor / backup
P1-9 concurrency / hardening
P1-10 Windows Release Validation
```

## 47. 二期实施顺序

```text
P2-0 Provider abstraction
P2-1 Embedding storage
P2-2 Hybrid Search
P2-3 Entity / Relation
P2-4 Graph Query
P2-5 Temporal Facts
P2-6 Conflict / supersede
P2-7 Intelligent dedupe
P2-8 LLM enrichment
P2-9 Importer plugin system
P2-10 Maintenance / metrics
P2-11 Optional HTTP shared mode
P2-12 Windows full regression
```

---

# 第五部分：完成定义（Definition of Done）

任意功能只有同时满足以下条件才算完成：

1. 需求实现；
2. TypeScript 类型检查通过；
3. 单元测试通过；
4. 集成测试通过；
5. 数据 migration 已覆盖；
6. 错误处理明确；
7. README 已更新；
8. 不引入未经说明的平台依赖；
9. 不破坏一期兼容性；
10. Windows 验证通过。

---

# 第六部分：最终产品定位

最终系统定位为：

> 一个轻量、本地优先、跨 Agent 的长期记忆 MCP Server，以 SQLite 为核心存储，在不依赖 Docker、WSL、虚拟机和外部数据库的前提下，为 Claude Code、Cursor、Codex、Hermes 等 Agent 提供统一、可搜索、可迁移、可扩展的长期项目知识，并在二期进一步支持语义检索、轻量知识图谱与时间事实。
