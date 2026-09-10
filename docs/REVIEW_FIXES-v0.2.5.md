# 0.2.5：独立审查问题修复

日期：2026-09-10。基于独立审查提交 4fcb0d7，按 R1/P1 → R2/P1 → R3/P2 实施。R4 性能问题另提供只读原型验证过的方案，未替换生产检索 SQL。

| 问题 | 修复 | 主要回归 |
| --- | --- | --- |
| R1 合并复活失效关系 | 核对合并前各来源/目标 hash；失效与退休事实保留原来源；改写正文不认证旧事实 | 两侧 stale、正常关系、历史字段、未来 supersede、自定义正文、policy 改写 |
| R2 HTTP 取消泄漏并发名额 | 工具处理完后统一关闭 transport 和释放名额，断开连接不提前丢掉 SDK response resolver | 并发 1/默认 20、成功/失败/成功三轮取消、任务未结束仍限流、后续 stats 恢复、无效 JSON、停服排空 |
| R3 token 字段漏检 | token 纳入共用名称集合 | 正文/JSON/嵌套 metadata、update/import/merge、reject/redact、跨模式占位符、普通术语 |

## 图谱语义

只有最终正文仍为各原始正文的原样拼接，才能继续使用未失效的来源事实。mergeLinks 显式接收合并前的 sourceHash，目标自身也用更新前的 hash。null 表示仅转移显式普通实体链接，不认证旧事实，也不转移 enriched 派生链接。

仓储继续独立检查 namespace/project、目标当前版本和有效性；非目标自身的来源还核对当前版本。关系端点须处于同 scope 且未删除。仅版本匹配、未结束、未删除、非 inactive 的关系迁移到目标。已 future supersede 的事实在 valid_to 之前仍有效，保留 status、superseded_by 和区间边界。

stale、已结束、inactive、已删除关系及删除端点不刷新证据；旧来源 ID/hash/时间戳保留，历史 at/include_stale 查询仍能追溯。自定义 content 或 policy 脱敏改写正文时，需要显式复核关系或重新 enrichment。

内部 GraphRepository.mergeLinks 增加必传 sourceHash 参数；MCP 的 27 个工具及参数兼容，无新增 migration。补丁阻止后续错误发生，不自动重写旧版已损坏的关系来源；需根据原正文/合并快照核验旧数据。

## HTTP 生命周期

固定 SDK 的 JSON response 模式等待工具结果后才结束 handleRequest。旧版在 response close 中提前关闭 transport，删除待响应映射，使外层 await/finally 永远不能完成。

新版让已开始的工具完成，再统一关闭 transport、释放 active 名额。客户端断开时任务仍计入并发预算，反复取消不能绕过上限。listener.close() 停止接收请求后，也会等待已断开的实际工具完成，再让调用方关闭 SQLite；重复 close 复用同一 Promise。

Provider timeout/retries 维持原义。客户端取消不表示服务器事务已回滚；任务可能完成写入。强制终止进程不属于优雅停服。

## token 保护

独立 token 与 password/access_token 共用正文扫描和 metadata 递归规则，大小写不敏感，支持 JSON 引号。token_count/tokenizer 与没有凭据赋值的普通 token 术语不误伤。完整 [REDACTED] 在 reject 模式下仍可更新，带真实值后缀仍拒绝。

旧库不会自动扫描或改写。旧版存入的 token 明文在新规则下可能拒绝继续保存，应先移除秘密或显式使用 redact 处理。

## 验证

新增 12 项：integration/review-v025.test.ts 9 项、contract/http-lifecycle.test.ts 3 项。最初图谱 3 个、HTTP 3 个用例在旧实现上失败，token 对照亦先证明旧实现漏检；修复后通过。额外用例保护正常迁移、未来替代和普通术语，避免只消除反例却损害原能力。

pnpm check 的 typecheck/build 成功，全量 136 通过、0 失败、0 跳过。Linux / Node 24.19.0；Windows 以本轮提交的 Actions 为准。没有增加依赖、配置或 migration，schema 仍为 104。

详见 [VALIDATION.md](VALIDATION.md)；性能实施与验收见 [PERFORMANCE_PLAN.md](PERFORMANCE_PLAN.md)。
