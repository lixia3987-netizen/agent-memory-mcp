# 本地验证记录 · 0.2.5

日期：2026-09-10。针对独立审查 R1/R2/R3 修复；用户实际客户端、真实模型及全面规模仍有验证边界。

| 项目 | 结果 |
| --- | --- |
| 平台 / Node | Linux / 24.19.0 |
| pnpm / TypeScript / MCP SDK | 11.19.0 / 5.9.3 / 1.30.0 |
| pnpm typecheck / build | 通过 |
| pnpm test | **136 通过 / 0 失败 / 0 跳过** |
| 初次完整测试耗时 | 约 4.08 秒，仅代表本测试套件 |
| schema / 依赖 / 配置 | schema 104，无新增迁移、依赖或必填配置 |
| Windows | 以[本次修复分支 CI](https://github.com/lixia3987-netizen/agent-memory-mcp/actions?query=branch%3Afix%2Freview-lifecycle-v025) 的当前提交为准，不沿用旧版记录 |
| 真实云模型 / 用户客户端 | 本轮未联调 |

## 新增 12 项回归

integration/review-v025.test.ts：9 项。

- 合并前修改来源和目标正文：旧事实持续失效、正常事实迁移、原来源/版本/时间戳保留。
- 自定义正文不认证旧事实，历史 at 查询保留原证据。
- 已结束、inactive、删除关系与删除端点不刷新证据。
- future supersede 保持区间及替代关系。
- 策略脱敏改写正文时不刷新旧事实 hash。
- token 在正文/JSON/嵌套 metadata 及 update/import/merge 被拒绝。
- redact 保留 JSON 并隐藏嵌套 token。
- 完整 token 占位符在 redact→reject 后可更新，真实后缀仍拒绝。
- 普通 token 术语和 token_count/tokenizer 不误伤。

contract/http-lifecycle.test.ts：3 项。

- 分别在并发 1 和默认 20 下执行成功/失败/成功三轮真实 HTTP 取消；运行中仍限流，任务结束后 stats 恢复 200，无效 JSON 后容量正常。
- 停服等待已断开的工具结束，确认向量入库后才返回；重复 close 安全。

仓储 scope 回归继续执行，并增加来源 hash 不匹配时拒绝迁移的断言。原 124 项测试全部保留：真实 stdio 的 27 工具、HTTP SDK、迁移回滚、备份恢复、多进程 WAL、TTL/删除/范围、文件往返、Provider 超时/熔断/租约等。

## 复现依据

最初图谱 3 项、HTTP 3 项在旧实现上失败；token 对照在补充名称前证明漏检。修复后全部通过，新增正常行为保护用例也通过。测试使用临时 SQLite 和本机 HTTP，未访问真实模型或用户数据库。

## 性能实验

独立审查约 5 万条合成 Memory 的高命中率英文 P95 约 318ms。随后只读 SQL 对照：当前完整查询 P95 312.02ms，物化选页后取正文/摘要原型 P95 72.88ms；两种英文查询的字段、顺序、score、snippet 一致。

这不是生产查询已提速的证据；原型仅覆盖两个英文查询、一个合成数据库，尚未替换应用 search()。计划与验收见 [PERFORMANCE_PLAN.md](PERFORMANCE_PLAN.md)。

## 验证命令

```text
pnpm install --frozen-lockfile
pnpm check
```

contract 测试使用 dist，不能省略 build。当前 Windows CI 的完整测试、doctor/init、smoke 仍是平台门禁；CI 不替代 Windows 10/11 实机客户端。历史证据保存在 [VALIDATION-v0.2.4.md](VALIDATION-v0.2.4.md)。
