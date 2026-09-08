# 本地验证记录

验证日期：2026-09-08。版本：0.1.0。

## 执行环境与结果

| 检查 | 结果 |
| --- | --- |
| 系统 | Linux |
| Node.js | v24.19.0 |
| pnpm | 11.19.0 |
| TypeScript | 5.9.3 |
| SQLite | 3.53.3，node:sqlite |
| `pnpm install --frozen-lockfile` | 通过 |
| `pnpm typecheck` | 通过 |
| `pnpm build` | 通过 |
| `pnpm test` | **29 通过，0 失败，0 跳过** |
| 最终测试运行耗时 | 约 4.14 秒，仅代表当前测试套件 |
| `node dist/index.js doctor` | writable=true，fts5=true，schemaVersion=3，integrity=ok，journalMode=wal |
| Windows | 尚未执行；提供 CI 配置 |

## 覆盖清单

1. 构建后真实 stdio 服务：官方 SDK 客户端握手及全部 8 个工具。
2. 编译后 CLI：诊断、写入、导入预览、导出、恢复、purge 确认与错误输出。
3. 导出大小限制在无限累积正文前生效。
4. 当前数据库损坏时，CLI 仍可从有效备份恢复到新路径。
5. 四进程同时初始化、写入、读取同一个 WAL 数据库：120 条独立记录 + 1 条共同去重记录。
6. 从 schema v1 升级，生成可验证的迁移前备份。
7. 未知未来 schema 阻止写模式启动。
8. 迁移 SQL 失败回滚至原 schema。
9. 备份恢复验证、禁止覆盖 live/已有 DB、拒绝无效备份。
10. JSON 往返保留 ID、时间、metadata、软删除状态，dry-run 无持久变更。
11. Markdown 往返同上，重复导入保持幂等。
12. 文件修改后的 skip/update/copy 与复制幂等。
13. Claude memory 目录扫描与不同源项目隔离。
14. 整批记录先校验、允许目录和文件大小限制。
15. 符号链接/junction 导入拒绝。
16. CRUD 重启持久化、精确去重、FTS 更新同步。
17. namespace/project 访问与移动项目冲突。
18. TTL、软删除、恢复和显式物理清理。
19. 中文短语、字面量查询特殊字符和多维过滤。
20. 事务回滚同时撤销 Memory 与 FTS。
21. 空内容、UTF-8 大小、未知字段、importance 与时间格式校验。
22. Unicode/空白标准化与作用域 hash。
23. 相关性优先和 FTS query escaping。
24. 配置优先级和无效配置。
25. 数据库 busy/权限错误分类、不泄露原始内部错误内容。
26. Markdown frontmatter、代码围栏、分段与来源 metadata。
27. 无效 frontmatter/未知 JSON schema 拒绝。
28. Claude 自定义 frontmatter 字段保留与 source 标记。
29. 插入不同标题后原分段 key 保持稳定。

本记录只证明上述本地测试的结果。未执行 Windows 原生验证、真实客户端产品回归、规模性能测试、长时压力或强杀恢复测试；不能据此宣称满足正式 Release 的全部完成定义。
