# 实现状态：0.1.0

日期：2026-09-08。输入为用户提供的 REQUIREMENTS.md / ARCHITECTURE.md v1.0；原始文档保持不变。

## 本次交付

第一阶段可运行的源码、构建产物、依赖锁文件、配置示例、测试和 Windows/Linux CI。不是一期、二期全部完成的正式发布版。

| 需求阶段 | 当前状态 | 证据/说明 |
| --- | --- | --- |
| P1-0 骨架 / CI / Windows Gate | 已实现配置 | TypeScript 严格类型；官方 SDK；双平台 GitHub Actions；Windows 执行待完成 |
| P1-1 SQLite / migrations | 已实现并测试 | node:sqlite；WAL；外键；5s busy timeout；3 个顺序迁移；互斥、备份、回滚 |
| P1-2 Memory Repository | 已实现并测试 | 替换接口与 SQLite Adapter；完整 Memory 字段 |
| P1-3 8 个 MCP Tool | 已实现并测试 | 官方 Client 与已构建 stdio Server 完成握手和工具调用 |
| P1-4 FTS5 / BM25 | 已实现并测试 | 5 个字段；索引触发器；literal AND；重要度/时间小幅加权；中文 trigram |
| P1-5 隔离 / TTL / 删除 / 去重 | 已实现并测试 | get/update/delete 也按 scope；TTL 状态；软删除恢复和审计；事务内去重 |
| P1-6 JSON / Markdown | 已实现并测试 | schemaVersion；lossless round trip；dry-run；skip/update/copy；来源追踪 |
| P1-7 Claude Memory Importer | 已实现并测试 | 独立 Adapter；memory 目录；frontmatter；标题切分；不同源项目分开 |
| P1-8 CLI / doctor / backup | 已实现并测试 | 维护命令；能力检查；当前库备份；验证后恢复至新文件 |
| P1-9 并发 / 加固 | 已实现基础并测试 | 四进程并发初始化/读写；目录允许列表；符号链接拒绝；输入/输出上限 |
| P1-10 Windows Release Validation | **待执行** | 当前仅 Linux Node 24.19.0；CI 文件不等于 Windows 已通过 |
| P2-0 抽象接口 | 已预留 | EmbeddingProvider、LlmProvider；当前不实例化、不联网 |
| P2-1 至 P2-12 | **未实现** | 见后续任务 |

## 本地验证

执行环境：Linux、Node.js 24.19.0、pnpm 11.19.0、TypeScript 5.9.3、SQLite 3.53.3。

已验证：

- `pnpm install --frozen-lockfile`
- `pnpm typecheck`
- `pnpm build`
- `pnpm test`：最终结果见同目录 VALIDATION.md
- `node dist/index.js doctor`：可写、FTS5、schema v3、integrity ok、WAL

测试包括单元、临时真实数据库、独立进程、SDK contract 和 CLI。测试不调用云端 provider，不读取真实用户记忆；所有测试数据自动清理。

## 实现细化与边界

1. **恢复策略**：根据“不得覆盖唯一副本”的约束，数据库 restore 写入新路径，并额外备份可读取的当前库。当前库损坏时绕过正常启动，保留损坏原文件并从有效备份恢复。切换需停止客户端后更新 AGENT_MEMORY_DB，避免 live WAL 替换风险。
2. **Markdown 可逆格式**：单个导出文件使用 YAML header 存完整 records，正文用于阅读。也支持普通单文件 frontmatter + Markdown；二/三级标题切分避开代码围栏。
3. **导入默认预览**：MCP dry_run 默认 true，CLI 默认不提交。正式导入 100 条一批；格式错误在任何提交前发现，后续数据库冲突可留下已成功批次，错误明确提交统计。
4. **读取隔离**：namespace/project 是显式查询条件，不是授权系统。持有本机 DB 或 stdio 访问的用户可显式选择其他 scope。
5. **中文检索**：unicode61 + trigram，>=3 字符短语可匹配子串；短中文词没有完整分词保障。双 FTS 索引增加磁盘占用。
6. **同步 SQLite**：当前同步 API 适合小型本地数据库。导入在批次之间让出事件循环；dry-run 用单个回滚事务。大型 preview、purge 和复杂查询可能短暂阻塞。需要按实际规模评估 worker/批处理。
7. **资源保护**：搜索 limit 最大 100，导入/遍历/正文/metadata 均有限制。导出逐条读取并累计大小，不一次加载无限正文。
8. **第三方格式**：Claude 格式依据用户文档中的 Markdown 约定；支持实际 frontmatter 自定义字段，没有对未来客户端内部格式作保证。
9. **去重与历史**：标准化正文去重；copy 是显式保留重复版本的例外；审计保存动作/ID/作用域/时间，不保存每次 update 的旧正文版本。
10. **暂无基准结论**：未验证 Windows 原生运行，也未测 5 万/10 万条规模的 P95、峰值 RSS、长时间压力和进程强杀恢复。不得宣称达到文档性能目标或发布验收。
11. **传输边界**：stdio only；没有 HTTP、远程认证、GUI、自动记忆采集、自动 secret detection 或后台维护任务。
12. **协议校验**：SDK 在工具路由前执行参数 schema 校验；业务错误返回统一结构化 error。SDK 自身的协议/schema 错误遵循官方 SDK 的错误格式。

## 建议下一轮实施顺序

1. 将项目放入目标 Git 仓库，执行 Windows Node 24 CI，修复平台差异，完成 P1-10。
2. 在真实 Windows 目录及带空格/中文路径下验证 Claude/Cursor/Codex/Hermes 客户端接入，并执行规模基准。
3. P2-1：embedding 表迁移、失效与 Provider 配置（默认关闭）。
4. P2-2：semantic/hybrid 搜索与 RRF，provider 不可用回退 lexical。
5. P2-3～P2-6：entity/relation、最大深度 3 的图遍历、时间事实、supersede/conflict。
6. P2-7～P2-10：重复候选/显式合并、LLM schema 验证、持久任务、Policy、maintenance 和 metrics。
7. 可选 HTTP 共享模式，保持 localhost 默认和显式启用，最后做 Windows 完整回归。

未创建或推送远程仓库，未发布 npm 包。源码包包含未来推送即可使用的 CI 配置；实际 GitHub 分支保护需在目标仓库配置。
