# Agent Memory MCP

基于 Node.js 24、TypeScript、官方 MCP TypeScript SDK 和 SQLite 的本地长期记忆服务。

**当前版本：0.2.3，一期 + 二期核心实现。** 共 27 个 MCP 工具，包含图谱、时间事实、语义/混合检索、去重合并、可选 LLM 增强、维护与本地 HTTP。二期使用方式见 [PHASE2_GUIDE.md](docs/PHASE2_GUIDE.md)，验证与边界见 [IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md)。本地类型检查、构建和 112 项测试通过，本次 Ubuntu/Windows CI 待验证；外部真实模型尚未联调，完成相应验证前不视为正式 Release。

核心运行不需要 Docker、WSL、虚拟机、外部数据库、Python、JDK、VC++ 构建工具或 API Key。默认使用 stdio，不监听端口，不发送遥测。Embedding/LLM 默认关闭；只有显式启用后，相应操作才会把输入发送到所配置的服务。本地 HTTP 也需要显式配置并启用。

0.2.3 修复本轮 8 项问题：失效事实参与冲突、parallel 更新回归、任务无限重试、历史导入 hash 误跳过、中文混合短词搜索、脱敏引号、冲突引用容量及软删导入行为。新增 18 项回归测试，全量 112 项通过。详见 [REVIEW_FIXES-v0.2.3.md](docs/REVIEW_FIXES-v0.2.3.md)。从 0.2.2 升级无需新增配置或迁移，schema 保持 104；任务执行次数默认最多 3 次。

0.2.1 是前一轮代码审查修订版：强化仓储 scope 校验、同步事务契约和诊断，修复熔断计数，统一配置与版本来源。逐项结论见 [REVIEW_FIXES-v0.2.1.md](docs/REVIEW_FIXES-v0.2.1.md)。从 0.2.0 升级不新增数据库迁移，schema 仍为 v104；新增配置均有默认值。

从 0.1.0 升级：先停止旧 memory 进程，保留原数据目录，用新源码安装、构建并运行 `doctor`。首次启动自动备份并将 schema v3 升级至 v104，原 Memory 保留。旧版本会拒绝新版 schema；回退需使用升级前备份恢复到新路径。二期默认配置可直接启动，不要求先填模型信息。

## 快速开始：Windows PowerShell

前置条件：Node.js **24.x**。开发和首次安装使用 pnpm **11.19.0**。

```powershell
node --version
npm install -g pnpm@11.19.0

# 从 GitHub 获取源码（也可使用已解压的源码包）
git clone https://github.com/lixia3987-netizen/agent-memory-mcp.git
cd agent-memory-mcp

pnpm install --frozen-lockfile
pnpm build
pnpm test
node dist/index.js doctor
```

已交付的 v0.2.1 ZIP 源码包附带 `dist/`；GitHub 仓库需先按上面的步骤构建。使用附带构建产物的 ZIP 时，可以在解压后的目录执行：

```powershell
pnpm install --prod --frozen-lockfile
node dist/index.js doctor
node dist/index.js serve
```

`serve` 等待 MCP 客户端通过标准输入输出通信。没有普通启动横幅是正常行为。`node dist/index.js` 与 `serve` 相同。诊断信息输出到 stderr；stdout 保留给 MCP 协议。

首次运行自动创建数据库、应用顺序迁移并检查 FTS5。初始化、诊断、迁移也可显式运行：

```powershell
node dist/index.js init
node dist/index.js migrate
node dist/index.js doctor
node dist/index.js help
```

默认数据目录：Windows 为 `%LOCALAPPDATA%\AgentMemoryMCP`，Linux/macOS 为 `~/.agent-memory-mcp`。目录下包含 `data/`、`backup/`、`logs/`、`config/`。当前结构化日志直接使用 stderr；`logs/` 预留给后续文件日志。

## 接入 MCP 客户端

在客户端的本地 stdio MCP 配置入口中设置 `command`、`args` 和 `env`。使用真实的**绝对路径**；带空格的路径作为 args 数组中的单个元素即可，不要添加额外引号。下面的 JSON 适用于采用 `mcpServers` 格式的客户端：

```json
{
  "mcpServers": {
    "memory": {
      "command": "node",
      "args": ["C:\\tools\\agent-memory-mcp\\dist\\index.js", "serve"],
      "env": {
        "AGENT_MEMORY_HOME": "C:\\AgentMemoryData",
        "AGENT_MEMORY_NAMESPACE": "work",
        "AGENT_MEMORY_PROJECT": "memory-mcp"
      }
    }
  }
}
```

Claude Code、Cursor 等客户端支持本地 stdio MCP。Codex、Hermes 或其他客户端若采用不同配置格式，在其 MCP 设置中填入相同的进程参数与环境变量即可。客户端配置文件的位置、语法与启用命令以各客户端当前文档为准；本项目不自动改写客户端配置。可复制 [examples/mcp-config.json](examples/mcp-config.json) 后修改路径。

多个客户端的 `AGENT_MEMORY_HOME` 或 `AGENT_MEMORY_DB` 指向同一个位置即可共享存储；namespace/project 决定每次请求的默认作用域。

## 作用域与字段约定

- API 使用 `snake_case`，时间使用带时区的 ISO 8601，返回统一为 UTC。北京时间可传 `2026-09-08T16:00:00+08:00`。
- 未传 namespace/project 时使用进程配置。默认 namespace 为 `global`，project 为 `null`。
- `project: null` 只匹配未分配项目的记录；不会搜索全部项目。
- 查询其他项目需显式传 `project`。同一 namespace 内跨项目查询需传 `all_projects: true`，不能同时传 project。
- namespace 始终精确匹配。访问其他 namespace 也需显式指定，global 记忆不会隐式混入项目结果。
- 按 ID 获取、更新、删除、恢复同样验证作用域。作用域是数据选择规则，并非多租户认证或操作系统权限隔离。
- type 是自由字符串，默认 `note`；importance 默认为 5；source 默认取 MCP 客户端名称，CLI 写入默认 `manual`。
- 正文最多 64 KiB UTF-8；metadata 最多 16 KiB；最多 64 个标签。

## MCP 工具

下表是保持兼容的 8 个核心工具。二期新增的 19 个工具、调用示例与参数见 [PHASE2_GUIDE.md](docs/PHASE2_GUIDE.md)。`memory_export` 继续导出 schemaVersion 1 的 Memory；图谱、向量、合并快照和任务通过整个数据库的 backup/restore 保存。

| 工具 | 主要参数 | 结果与行为 |
| --- | --- | --- |
| `memory_add` | `content`，可选 scope/type/title/tags/source/importance/expires_at/metadata | 返回 `memory`、`deduplicated`；同作用域内标准化正文相同则复用 ID |
| `memory_search` | `query`、过滤条件、`limit`、`offset` | 返回 `memories`，每项有 snippet、score 和来源等字段 |
| `memory_get` | `id`、作用域、可选 `include_deleted` | 返回完整 Memory 和 `expired` 状态 |
| `memory_update` | `id`、原作用域、`updates` 对象 | 更新允许字段；移动项目使用 `updates.project` |
| `memory_delete` | `id`、作用域 | 软删除，返回 ID 和删除时间，可通过 CLI 恢复 |
| `memory_list` | 过滤条件、`limit`、`offset`、`sort` | 返回 `memories` 和 `total` |
| `memory_import` | `format`，`path`/`data` 二选一，`dry_run`、`conflict`、`backup` | 默认预览；返回文件数、记录数、添加/更新/跳过/复制统计 |
| `memory_export` | `format`、过滤条件 | 返回 `schemaVersion`、`count`、`data`；不直接写任意本地文件 |

搜索/列表过滤条件：namespace、project、all_projects、type、source、tag、tags、importance_min、created_after、created_before、include_expired、include_deleted。tags 为全部匹配。limit 默认 10、最大 100（可通过配置进一步收紧）。sort 支持 updated_desc、created_desc、created_asc、importance_desc；相同值用 ID 稳定排序。

```json
{
  "namespace": "work",
  "project": "memory-mcp",
  "type": "decision",
  "title": "核心存储选型",
  "content": "使用 Node.js 24 内置 SQLite，避免 Windows 上的原生 npm 编译依赖。",
  "tags": ["architecture", "sqlite", "windows"],
  "importance": 8
}
```

对应搜索参数：

```json
{"namespace":"work","project":"memory-mcp","query":"SQLite","limit":10}
```

FTS 使用 BM25，并对重要度和新近程度作小幅乘法加权，只有满足全部查询词的记录能参与排序。query 中空白分隔的词采用字面量 AND 查询，不开放原始 FTS 运算符。常规检索用 unicode61；含汉字时，至少三个 Unicode 字符的词用 trigram，较短词用字面子串过滤，保留 AND 语义。例如 AI 大模型 可以匹配这是AI大模型的说明。全是短词的中文查询扫描已过滤作用域，按重要度/新近度排序，未做完整中文分词；大库建议加入至少三个字符的词以使用索引。短词过滤支持 ASCII 大小写折叠，%/_ 不作为通配符。score 仅用于同次查询排序，不应视为跨查询的概率。

软删除与过期记录默认从列表、搜索、导出排除。get 可以读取过期记录并标记状态。去重将 NFC Unicode 和连续空白标准化，仅用于 hash，原始正文保持原样；已删除或已过期记录不阻止重新添加；过期记录保留原 ID，新添加的活跃记录使用新 ID。若要延续原记录，请显式更新其 TTL。

## 导入与导出

CLI 导入默认 dry-run，只有 `--apply` 才提交。MCP 使用 `dry_run: false` 提交。

```powershell
# 预览与正式导入（可选导入前备份）
node dist/index.js import --format markdown --path "C:\notes" --namespace work --project demo
node dist/index.js import --format markdown --path "C:\notes" --namespace work --project demo --apply --backup

# Claude Code：显式指定 projects 根目录或某个 memory 目录
node dist/index.js import --format claude-code --path "$env:USERPROFILE\.claude\projects" --namespace work
node dist/index.js import --format claude-code --path "$env:USERPROFILE\.claude\projects" --namespace work --apply

# JSON 导入
node dist/index.js import --format json --path "C:\exports\memories.json" --apply

# 导出当前作用域；输出文件必须尚不存在
node dist/index.js export --format json --namespace work --project demo --output "C:\exports\demo.json"
node dist/index.js export --format markdown --namespace work --project demo --include-expired --include-deleted --output "C:\exports\demo.md"
```

Claude importer 仅扫描 memory 目录中的 Markdown，忽略无关项目文件；按二级、三级标题切分，识别代码围栏，保留路径、mtime、hash、frontmatter。未显式指定 project 时保留各个源项目目录名作为项目标识。Claude 的目录名可能编码过真实路径；本项目不猜测解码规则。可通过 `--project` 显式映射单个项目。

冲突策略：

| 策略 | 行为 |
| --- | --- |
| `skip`（默认） | 已导入同一文件版本、相同来源项、相同 ID 或标准化正文冲突时跳过 |
| `update` | 文件内容变化后更新对应记录，保留 ID；导入的时间和 metadata 存在时按输入保存；缺失的 TTL/importance 保留旧值 |
| `copy` | 冲突时创建新 ID，metadata 记录 copiedFromId；相同文件版本再次执行仍跳过 |

文件路径、分段 key、文件 hash 和目标作用域共同记录导入来源。不同作用域已占用的 ID 不会被覆盖；可用 copy 显式重新分配。被手动删除的记录不会因为原文件再次导入而自动复活。update 遇到软删记录时跳过且不修改，统计为 skipped；只有显式 deleted_at: null 才恢复，并重新校验活跃正文去重。导入来源保留软删记录以阻止隐式重建；新导入的导出快照仍可保留其删除状态。同一文件 hash 只有在目标当前正文 hash 仍匹配时才跳过，因此 A→B→A 可通过 update 回退。

所有记录先完成格式校验，之后每 100 条一个短事务；数据库冲突导致后续批次失败时，先前已提交批次保留，错误说明已提交数量。重新执行使用来源记录避免重复。dry-run 使用回滚事务模拟同批去重与冲突，期间短暂持有写锁，适合分批预览。

JSON 格式为 `{"schemaVersion":1,"exportedAt":"...","memories":[...]}`。Markdown 导出采用带 schemaVersion 的 YAML frontmatter 存放完整 records，正文是便于阅读的视图；重导入时以 frontmatter 为准。这样可以无损保留换行、元数据、ID 和时间，避免正文分隔符碰撞。普通 Markdown 文件也可以直接导入。

导入默认限制：每文件 10 MiB、1000 文件、10000 记录、单次总输入 50 MiB、扫描深度 16。只接受 UTF-8 普通文件，拒绝符号链接/junction，支持配置允许目录。导出最多 100000 记录，默认最大 16 MiB；超限请缩小过滤条件。导入小于 10 MiB 的 JSON/Markdown 导出可按默认配置直接往返，更大文件需提高 maxFileBytes 后导入。

## 维护与恢复

```powershell
node dist/index.js stats --namespace work --project demo
node dist/index.js backup
node dist/index.js restore --namespace work --project demo --id "MEMORY_ID"

# 数据库恢复到一个尚不存在的新文件
node dist/index.js restore --from "C:\backup\memory-backup.db" --output "C:\AgentMemoryData\data\recovered.db"

# 只物理清理指定作用域内、在该时间之前软删除的记录
node dist/index.js purge --namespace work --project demo --before "2026-09-01T00:00:00+08:00" --yes
```

数据库恢复先验证源文件和 schema，再为可读取的当前数据库创建备份，然后生成并验证新数据库。若当前库已损坏，CLI 跳过正常启动和当前库快照，返回 `current_backup: null`，原 DB/WAL/SHM 保留用于后续排查。完成后停止各 MCP 客户端的 memory 进程，将 `AGENT_MEMORY_DB` 改为恢复结果的路径，再重新启动。**不支持直接覆盖正在使用的 SQLite/WAL 文件。**

SQLite 使用 WAL、foreign_keys、busy_timeout 和短事务。迁移在 BEGIN IMMEDIATE 锁内重读版本；升级前在写事务之外自动备份，再次加锁后用同一连接的 data_version 校验期间是否有并发提交。数据变化时重新备份，连续 3 次变化则返回可重试 DATABASE_BUSY；实际迁移全程同步执行，失败回滚并终止启动。FTS 索引由触发器维护，删除/恢复操作留有不含正文的审计事件。DATABASE_BUSY 可稍后重试；发现损坏请从备份恢复到新路径。

## 配置

优先级：CLI > 环境变量 > JSON 配置文件 > 默认值。默认配置路径为数据目录中的 `config/config.json`，也可 `--config FILE` 或 `AGENT_MEMORY_CONFIG` 指定。

| 环境变量 | 用途 |
| --- | --- |
| `AGENT_MEMORY_HOME` | 数据根目录 |
| `AGENT_MEMORY_DB` | 数据库文件路径 |
| `AGENT_MEMORY_NAMESPACE` | 默认 namespace |
| `AGENT_MEMORY_PROJECT` | 默认 project |
| `AGENT_MEMORY_LOG_LEVEL` | error/warn/info/debug |
| `AGENT_MEMORY_CONFIG` | 显式配置文件 |

完整配置示例见 [examples/config.json](examples/config.json)。相对路径相对于进程工作目录解析；客户端配置建议使用绝对路径。`--no-project` 将默认项目显式设为 null。

默认不会扫描任何目录。每次导入都必须给出路径或内联数据；配置 `imports.allowedRoots` 后，文件导入仅允许这些目录。imports 段未知字段、空白 homeDir/dbPath/config 路径会明确报错；读取配置的权限或 IO 错误与 JSON 语法错误分开报告。记忆正文默认不写日志。二期增加基于规则的秘密信息检测，默认拒绝匹配的凭据，也可配置正文/metadata 脱敏；这不是完整 DLP，调用方仍应避免写入秘密。Provider Key 通过环境变量读取，不存数据库。

## 开发与验证

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test
pnpm test:smoke
```

测试使用 Node 自带 test runner 和临时 SQLite，包含真实 SDK 客户端握手与调用、四进程并发、迁移备份/回滚、范围隔离、TTL、删除恢复、文件安全与导入导出。contract 测试运行已构建的 dist，测试前必须 build。

`.github/workflows/ci.yml` 提供 Ubuntu/Windows Node 24 矩阵及 `release-gate` 汇总门禁，在 push、pull request 或手动触发时运行；仓库管理员需将该检查设为必需状态。源码仓库为 [lixia3987-netizen/agent-memory-mcp](https://github.com/lixia3987-netizen/agent-memory-mcp)，执行结果见 [GitHub Actions](https://github.com/lixia3987-netizen/agent-memory-mcp/actions)。当前未发布 npm 包。

架构按 MCP → service → repository interface → SQLite 分层。Importer 支持版本检测和代码注册；EmbeddingProvider/LlmProvider 可替换，内置 OpenAI-compatible HTTP 实现。模型调用在事务之外，持久化时检查正文版本。详细状态、已知限制和后续验证见 [IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md)。原始规格保存在 [REQUIREMENTS.md](docs/REQUIREMENTS.md) 和 [ARCHITECTURE.md](docs/ARCHITECTURE.md)。

实现参考：[官方 MCP TypeScript SDK 文档](https://ts.sdk.modelcontextprotocol.io/)、[Node.js SQLite 文档](https://nodejs.org/api/sqlite.html)、[SQLite FTS5 文档](https://sqlite.org/fts5.html)。本次依赖已通过 pnpm-lock.yaml 锁定，构建使用 TypeScript 5.9.3。
