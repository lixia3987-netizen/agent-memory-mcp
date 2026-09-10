# 验证记录 · 0.2.7

PR #1 已合并，随后在 main 重新执行 typecheck/build/test。合并基线 145/145 通过；修复脱敏后大小校验及未来时钟的更新时间倒退，并新增启用模型的完整 MCP/CLI 恢复流程后，本地 153/153 通过，0 失败、0 跳过，测试阶段约 6.59 秒。当前主分支 Windows/Ubuntu CI、需求覆盖矩阵和可用性结论见 [REVIEW-v0.2.7.md](REVIEW-v0.2.7.md)。

新增 `integration/policy-output.test.ts` 的 4 项测试验证变换后的限制、写入回滚、导入/合并不提交部分结果，以及成功脱敏记录的往返/跨模式更新。新增 `contract/enabled-workflow.test.ts` 使用编译后 stdio 服务、官方 MCP 客户端和真实本机 HTTP 模型接口，覆盖启用 embedding/LLM、索引复用、语义/混合检索、隔离、缓存及显式 apply、CLI 整库备份恢复、重启持久化、正文变更失效、历史保留和供应商故障回退。模型输出由测试端点控制，不代表真实模型质量验证。

0.2.7 另新增 `integration/memory-time.test.ts` 的 3 项回归，验证来源时钟超前时的普通编辑、实际删除时间、恢复、导入 dry-run/缺失或显式时间字段，以及合并对源/目标时间顺序的保护。

代码 `2bdb5ee` 的 [主分支 CI](https://github.com/lixia3987-netizen/agent-memory-mcp/actions/runs/34469688900) 全部成功：Windows/Ubuntu 均为 153/153，0 失败、0 跳过；Node 24.20.0；doctor/init、stdio smoke、50k/100k 基准及 release-gate 均通过。测试阶段分别约 20.39 秒和 12.53 秒。性能不等于全部达标：本轮 Windows 50k 英文 FTS P95 159.98ms、100k 并发 stats P95 122.80ms，超过相应 150/100ms 建议值。完整对照及原始日志摘要见复验报告及 [ci-v0.2.7.json](performance/ci-v0.2.7.json)。

## 0.2.6 性能实施验证（历史证据）

日期：2026-09-10。针对独立审查 R1/R2/R3 修复及 R4 FTS 性能实施；用户实际客户端、真实模型及全面规模仍有验证边界。

| 项目 | 结果 |
| --- | --- |
| 平台 / Node | Linux / 24.19.0 |
| pnpm / TypeScript / MCP SDK | 11.19.0 / 5.9.3 / 1.30.0 |
| pnpm typecheck / build | 通过 |
| pnpm test | **145 通过 / 0 失败 / 0 跳过** |
| 初次完整测试耗时 | 约 4.21 秒，仅代表本测试套件 |
| schema / 依赖 / 配置 | schema 105，新增覆盖索引迁移；无新增依赖或必填配置 |
| Windows / Ubuntu CI | [代码提交 9c19cb8](https://github.com/lixia3987-netizen/agent-memory-mcp/actions/runs/34463321642)：各 145/145 测试、doctor/init、smoke、5 万/10 万条基准和 release-gate 均通过 |
| 真实云模型 / 用户客户端 | 本轮未联调 |

## 本轮新增 9 项回归

search-equivalence.test.ts 使用冻结的 0.2.5 查询作为对照：多语言/字面词/字段命中及摘要；全部过滤/scope/TTL；完整加权排序/分页/稳定同分；更新/软删/恢复/回滚/到期。每项包含多组输入，比较完整返回字段、score 和 snippet。原有 136 项测试继续保留。另加 4 项只读线程回归：调用时间/过滤/更新兼容、容量和关闭排空、期限与启动失败、禁用后的同步回退；1 项 schema 104 → 105 备份及原记录保留验证。

## 0.2.5 新增 12 项回归

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

## 性能验证

0.2.6 已替换正式查询，不再使用仅原型的 72.88ms 作为当前结果。`pnpm benchmark:search` 构建并测量正式服务，在全新临时库内生成 5 万/10 万条混合语言正文，旧新交替、3 次预热、30 次计时，每次结果与冻结旧查询比较；另用独立 HTTP 服务进程测量并发 get/stats 和事件循环延迟。

CI 在 Ubuntu/Windows 执行相同脚本，上传 search-benchmark-* 原始分布和执行计划。性能绝对值受共享 runner 影响，CI 以结果一致性/脚本正常完成为硬门禁；P95 目标和实际值单独报告，不能把 CI 绿灯解释为所有环境 SLA。5 万条英文 FTS P95：Ubuntu 76.39ms、Windows 78.41ms，均达到 ≤150ms 建议目标；Windows 10 万条并发 stats 为 105.19ms，略超新增 ≤100ms 目标。完整实测及边界见 [PERFORMANCE_PLAN.md](PERFORMANCE_PLAN.md)。

## 验证命令

```text
pnpm install --frozen-lockfile
pnpm check
pnpm benchmark:search
```

contract 测试使用 dist，不能省略 build。当前 Windows CI 的完整测试、doctor/init、smoke 仍是平台门禁；CI 不替代 Windows 10/11 实机客户端。历史证据保存在 [VALIDATION-v0.2.4.md](VALIDATION-v0.2.4.md)。

代码验证对应 9c19cb8；后续提交仅补文档和性能证据，未改源代码/配置/测试/基准脚本。
