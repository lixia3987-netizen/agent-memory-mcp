# 0.2.2 代码审查修订

日期：2026-09-10。复核基线为 main 的 d77a33f（v0.2.1），与本地源码一致。按实际实现核对，不依赖原报告行号。15 项问题均有对应修复，未新增依赖或数据库迁移，schema 仍为 104。

## 逐项处理

| 编号 | 复核结果与修复 | 回归证据 |
| --- | --- | --- |
| 1 | policy 的凭据值字符类和长度门槛确实漏检。按敏感键和值边界匹配，支持标点、短值、引号内空格和转义；reject 递归检查原始字段，避免 JSON 转义干扰正文检测 | reject/redact 均覆盖 P@ssw0rd12345、标点密码、单字符及引号；导入复用策略 |
| 2 | duplicate 查询确实缺少 expires_at 条件。统一排除 expires_at≤当前时间的记录，保留作用域、排除 ID 和稳定顺序 | 新增、更新、恢复、导入新增/更新，以及恰好到期和跨 scope |
| 3 | relationUpdate 原来不检查新重叠。有效期/状态更新、恢复和既有冲突记录更新时，在同一事务中检测并给双方写 conflict_with、conflict 与置信度上限 | 区间扩展、inactive→active、删除后恢复均标记双方；相邻区间和 inactive 编辑不误标 |
| 4 | imports 配置段未 strict，拼错 allowedRoots 会静默丢弃。已与其他配置段统一 strict | allowedroots 报错；正确 allowedRoots 保留 |
| 5 | 空路径展开后变为 cwd，且 String() 会掩盖非法类型。展开前验证字符串非空白，去除强制字符串转换；配置入口、homeDir/dbPath 和 allowedRoots 一致检查 | CLI、环境变量、配置文件中的空串/空白；文件中的 null、数字、对象均拒绝 |
| 6 | 导入更新合并后缺少时间顺序校验。replace 前检查 updated_at≥created_at | 仅 updated_at、仅 created_at 的倒序情况；预览与提交都回滚同批写入和来源记录 |
| 7 | 预处理填默认值会覆盖更新缺失字段。导入预处理只做部分记录校验，创建时应用默认值，更新时合并旧值后校验 | 保留 expires_at=null、importance/type；新记录获取默认值；显式日期和 null 生效；minimumImportance 与 typeDefaults 一致 |
| 8 | 批量任务忽略 retryable。临时错误恢复 pending，停止本轮并返回 deferred；下次维护可继续；不可重试错误仍 failed，版本冲突仍 stale | 三个任务首次仅调用供应商一次且全部保留；恢复后第二轮全部完成；永久错误不阻塞后续任务 |
| 9 | 备份 await 确实位于 BEGIN IMMEDIATE 内。改为事务外备份；重获写锁后在同一连接比较 data_version 并重读迁移版本，期间有提交就重新备份，最多三次，之后返回可重试 DATABASE_BUSY | 备份期间允许另一连接写入；提交后重拍快照；另一个迁移者先完成时不重复执行；既有迁移回滚/升级前备份测试继续通过 |
| 10 | metadata 敏感键的长度门槛确实漏脱。键命中时隐藏整个非 null 值，不再按长度、字符串或容器类型区分 | 七字符、单字符、数字、数组、嵌套对象；已脱敏值重复更新稳定 |
| 11 | conflicts 原来包含 superseded。现在只修改 active/conflict 且未 superseded_by 的候选，保留封存历史 | 添加回溯事实后，旧 superseded 记录全部字段保持不变 |
| 12 | relationSearch 与 neighbors 的显式 at 默认不一致。所有时间查询显式 at 时默认 include_stale=true，未传 at 时默认 false；neighbors/path 新增显式 include_stale 覆盖 | relationSearch、atTime、neighbors、path 对同一失效来源返回一致，显式 false 可排除 |
| 13 | 别名原按原始字符串去重，SQLite 按规范化值去重。改用 canonicalName 去重并保留首次拼写；读取按插入顺序返回 | 大小写、全角、空白等价别名；entityAdd/entityUpdate 返回与 entityGet 一致 |
| 14 | 配置文件读取与 JSON 解析共用 catch，权限错误会误报语法错。读取/解析分离；直接读取避免 existsSync 掩盖错误 | EACCES 保持 PERMISSION_DENIED，显式缺失保持 NOT_FOUND，目录明确报错，畸形 JSON 单独报错 |
| 15 | 原来 fstat 后整文件读取，增长期间可能分配超限内存。改为定长分块，每次最多读取剩余额度加一个探测字节，并在完成后复查大小 | 首次 fstat 后扩展文件，实际读取≤maxBytes+1；完整保留跨分块 UTF-8，拒绝超限/非法编码 |

测试位于 [review-v022.test.ts](../tests/integration/review-v022.test.ts) 和 [io-review-v022.test.ts](../tests/integration/io-review-v022.test.ts)，新增 21 项；完整验证见 [VALIDATION.md](VALIDATION.md)。

## 兼容与数据说明

- 过期记录不再让新写入返回旧 ID；原过期记录仍保留，按 ID 可读取并标记过期。
- imports 未知字段和空白路径现在报错；不会静默扩大允许导入的目录。
- 导入只在新增时填默认 TTL/importance。已被旧版错误覆盖的值不自动恢复，因为无法判断用户原意。
- 历史 at 查询默认保留旧正文来源，仍遵守删除、inactive、scope 和有效区间过滤；可传 include_stale=false。
- 关系冲突重检不自动清除历史 conflict_with 或恢复旧置信度；这需要明确的冲突消解操作。只编辑 parallel 关系普通属性不会改其并存状态，编辑区间/状态会重新检查。
- enrichment 的 deferred 表示暂缓，不计入永久 failed。旧版已进入 failed 的任务无法仅凭错误码判断是否瞬时，仍可显式 enqueue/run 重入队；本次不猜测修复存量状态。
- 秘密规则是启发式检测，并不声称识别所有秘密或所有自定义语法；不会自动扫描改写存量数据。

## Windows 验证发现的附加修复

上次 [Windows Actions 日志](https://github.com/lixia3987-netizen/agent-memory-mcp/actions/runs/34206062929) 显示测试清理临时目录早于 SQLite 连接关闭，出现 EPERM，随后挂起。本次为测试资源引入逆序清理：先关客户端/连接，再删目录，即便某项清理失败也继续清理其余资源。完整测试与 smoke 增加 60 秒上限，CI validate job 增加 15 分钟上限。没有跳过 Windows 测试或放宽业务断言。

## 迁移备份设计依据

SQLite 的 [PRAGMA data_version](https://www.sqlite.org/pragma.html#pragma_data_version) 只能在同一连接的前后读数间比较，用于发现其他连接提交。本实现始终比较迁移连接自身的两次读数；不拿备份连接的计数做比较。备份结束后重新取得写锁，再核对版本和读数，只有快照对应未变化的升级前状态时才执行同步迁移。持续写入可能使本轮迁移返回 DATABASE_BUSY，应暂停其他写入后重试。
