# 对局订阅同步

## 数据流

客户端首次进入、重新连接时调用 `subscribeRoom`，由云函数鉴权并补齐订阅快照。正常连接时通过数据库 watch 接收状态，不再周期性查询 `getRoom`。

- `room_states/{roomId}`：一份公共快照；`readers` 是当前成员对应的真实微信 OPENID。客户端查询同时携带房间 ID 和 `readers: _.in([openid])`。
- `room_signals/{userId}`：玩家个人快照；`_openid` 控制读取权限。`protocol: 2` 表示直接接收个人状态，退出后 `roomId` 为空、`state` 为 null。
- 公共快照的 `privateVersions[userId]` 指向该玩家所需的个人版本。只有版本匹配时客户端才合并显示。个人内容不变时复用旧版本，减少数据库写入。
- 订阅快照仅来自服务端投影的字段白名单，原始 `rooms`、`games`、任务和操作记录仍禁止客户端读取或修改。
- 操作发送 `delivery: subscription`，响应只包含接受回执、请求编号和房间版本。请求编号继续用于幂等重试；页面最终状态由订阅决定。
- 网络或订阅异常时允许查询恢复，重连后停止正常玩家的周期查询。首次快照通过查询和服务端时间校准，实时快照通过推送获取。
- 笔记通过 `notes` 的个人查询订阅。未保存的本机编辑不会被远程更新覆盖，保存继续使用 revision 校验处理冲突。

## 自动推进

每次发布状态，在同一个事务内更新 `game_tasks/{roomId}`，保存下一次夜间阶段、发言或播报设备租约的到期时间。`advanceGames` 定时触发器每秒检查一批（最多 100 个）到期任务。

任务处理重新读取当前房间和当前对局，在事务中执行现有自动推进规则并发布快照。延期会替换截止时间，旧任务不会跳过新阶段。并发任务通过事务重试读取最新阶段，不能重复结束同一发言。没有新截止时间时删除任务。

倒计时由客户端根据服务端时间偏移本地显示。定时触发和云函数执行有调度、网络延迟，因此不是严格毫秒级切换。

播报设备的租约心跳仍是向服务端发送的请求，用于确保一个设备持有播放权；它不承担房间轮询。租约首次获取、释放和到期的公开状态会推送，续租更新到期任务。

## 虚拟测试用户

模拟器中的多个虚拟身份共用一个真实微信凭证，数据库规则不能区分这些虚拟身份。为避免通过改查询条件读取其他虚拟玩家的角色或笔记，虚拟玩家的订阅文档只包含变更通知，不包含私密内容；私密信息继续由鉴权云函数返回。虚拟笔记的 `_openid` 为空，不开放直接读取。

真实微信玩家采用直接状态订阅；虚拟身份使用通知后查询和断线恢复机制。虚拟身份仍共享房间公共状态，但不直接订阅私密快照。如需要模拟用户也直接订阅私密内容，需要引入独立凭证的认证方案。

## 云端部署

本仓库的本地改动不会自动更新云环境。部署时按以下顺序执行：

1. 创建 `room_states`、`game_tasks` 集合，确认已有 `room_signals`、`notes` 和 `command_receipts` 集合。
2. `room_states` 应用根目录的 `room-states.rules.json`；`room_signals` 应用 `room-signals.rules.json`；`notes` 应用 `notes.rules.json`。`game_tasks` 及原始业务集合应用 `database.rules.json`，禁止客户端读写。
3. 给 `game_tasks.dueAt` 配置升序索引。确保 `notes` 支持按 `_openid`、`ownerId`、`gameId` 查询；如果控制台报告需要组合索引，按错误提示创建对应索引。
4. 上传并部署整个 `cloudfunctions/api`，包括新增的 `state-publisher.js`、`state-worker.js` 和修改后的 `repository.js`。
5. 上传 `cloudfunctions/api/config.json` 的触发器配置，或在云函数控制台创建 `advanceGames` 定时触发器，表达式为 `* * * * * * *`（每秒）。确认定时调用成功，任务能自动清除或更新。若当前云环境不支持秒级触发，先配置支持秒级调度的运行环境，再启用无轮询客户端。
6. 再构建和发布小程序。现有房间会在首次 `subscribeRoom` 时生成快照，不需要批量修改房间记录。

参考：

- 腾讯云秒级定时触发器：https://cloud.tencent.cn/document/product/583/9708
- CloudBase 文档安全规则及数组成员查询：https://docs.cloudbase.net/database/security-rules

## 验证

本地运行 `npm run typecheck`、`npm test`。

云端使用两个真实微信账号：

1. 加入同一房间、抢同一座位、准备并开局，观察双方状态自动更新。
2. 确认身份、完成一轮夜间行动，检查其他玩家无法读取查验结果、女巫信息和私人笔记。
3. 不打开任何客户端，通过云日志确认到期夜间提示和发言阶段仍能推进；检查 `game_tasks` 对应截止时间更新。
4. 延长发言，确认原截止时间不会结束当前发言。
5. 断网重连、切后台返回、切换页面，确认最新状态恢复且正常连接时不周期调用 `getRoom`。
6. 转交播报权、退出和解散房间，确认播报不会重复、旧成员失去公共状态读取权限、个人文档已清空。
7. 多设备修改同一人的笔记，确认草稿保留且 revision 冲突可处理。

性能验证使用 `api metrics` 的 `durationMs`、`transactionReads`、`transactionWrites`，并在真机记录从点击到收到订阅的端到端时间。订阅回执的 `responseBytes` 记录实际响应大小。未进行云端部署和真机测量前，不宣称具体延迟降幅。

## 迁移兼容性

旧客户端依赖每个玩家的变更通知。新服务端只更新变化的个人文档，因此应在发布新客户端之前完成服务端和权限部署，并要求参与同一对局的设备使用新版客户端。不要将旧、新客户端混用于同一对局。

`getRoom` 保留恢复和旧版本查询能力，也保留到期推进作为恢复路径；正常玩家已不依赖它驱动对局。需要回滚客户端时，应同时回滚状态发布逻辑，恢复逐玩家通知。

## 耗时埋点（2026-10-08）

开发者工具或真机调试控制台搜索 `client metrics`，云函数日志搜索 `api metrics`。日志只记录动作名、请求编号、房间/对局版本、数量与耗时，不附带操作参数、身份、查验、笔记、OPENID 或响应正文。客户端日志目前保留在调试控制台，没有新增上报接口或数据库日志集合。

客户端事件：

- `request_sent`：修改操作的请求编号；`localMs` 表示起点到准备发请求。选座从点击处理函数入口开始，其余操作从 API 调用入口开始。
- `request_finished`：`roundTripMs` 表示客户端等待云函数的完整时间；失败仅记录错误码。查询也有单独的 trace 编号。
- `subscription_received`：公共或个人通道收到快照时的本地时间和版本，用于检查两个通道的到达顺序。
- `subscription_version_wait`：公共与个人快照尚未匹配，记录所需版本和已有版本。
- `subscription_applied`：已收到可合并的状态，记录房间版本与订阅 revision。
- `operation_state_received`：以回执确认的房间及版本匹配操作，`endToEndMs` 从操作起点到收到匹配状态。允许跳过中间版本；不是精确的单条消息传播时间。
- `render_finished`：`renderMs` 从调用 setData 到微信执行完成回调；不是屏幕像素首次呈现时间。主对局页面与播报、笔记页面的房间更新已接入。
- `operation_rendered`：对应操作的状态完成上述页面更新后的端到端耗时。推送和页面更新先于回执时，使用已记录的时间，不把等待回执时间算入渲染耗时。
- `subscription_reconnect`：重连等待时间；`notes_received`：笔记订阅收到的记录数。

客户端追踪表最多保留 100 个操作和 32 个近期快照，60 秒以上未完成的记录在后续诊断活动时清理并记录 `operation_timeout`；切换身份后首次 API 调用清空旧追踪数据。

服务端 `api metrics` 新增 `requestId`、`roomId`、`version`，以及 `identityMs`、`transactionMs`、`transactionCallbackMs`、`commandMs`、`databaseReadMs`、`databaseWriteMs`、`snapshotPrepareMs`、`cleanupMs`（发生时）。失败日志也记录请求编号及已经测得的阶段。

这些字段是嵌套计时：commandMs 包含命令执行时的数据库读取，snapshotPrepareMs 包含补充读取，transactionCallbackMs 包含上述阶段和写入。**不能把所有阶段直接相加。** 数据库读写计时仅覆盖 transactionStore；事务外身份数据库访问计入 identityMs，其余事务外查询没有逐项数据库统计。`transactionCommitAndRetryMs` 是事务总时间减去所有回调时间的差值，包含提交、SDK 调度与重试等待，不能当作数据库纯提交时间。subscribeRoom 的事务也接入这些计数与计时。

`firstInvocation` 只标记该模块实例首次处理请求，不提供冷启动耗时；现有总耗时从 main 函数入口开始，模块加载和 SDK 初始化发生在它之前。定位冷启动需要结合平台的调用与初始化日志，以及客户端往返耗时。

排查选座时：先按 requestId 找到客户端 request_finished 和云端 api metrics，再看 operation_state_received 与 operation_rendered。比较同一操作的多次样本（例如至少 30 次），分别统计往返、服务端和端到端的 P50/P95；当前代码记录样本，不自动生成统计看板。不要将两端时间戳直接相减，也不要把快照 publishedAt 当作事务已提交时间。

### 频繁订阅重连排查

`subscription_reconnect` 现在包含 `channel`（identity、bootstrap、personal 或 public）、`errorCode` 和 `reason`。public 指 room_states，personal 指 room_signals。reason 是从 SDK 错误分类得出的提示，不等于已确认根因；常规 metrics 不输出原始错误正文。订阅失败现在另存本地缓存 `subscription_errors_v1`，最多 30 条，单条错误文本最多 8000 字符；记录 message、errMsg、stack、cause 等错误字段，不记录对局快照或查询对象，不上传服务器。错误正文仍可能包含 SDK 带入的身份信息，分享前请遮盖。

复现后在调试控制台执行 `wx.getStorageSync("subscription_errors_v1")`，展开最后一条的 error 查看底层错误；复制可用 `JSON.stringify(wx.getStorageSync("subscription_errors_v1"), null, 2)`。清理使用 `wx.removeStorageSync("subscription_errors_v1")`。无需断点或 debugger。真机与模拟器缓存各自独立，真机复现须在真机调试控制台读取。

- permission_denied：核对对应集合是否应用该集合的规则，是否误用了 database.rules.json，以及数据库所选云环境是否与 api 相同。
- collection_missing：核对集合创建情况和云环境。
- index_required：查看控制台查询所需索引，不要通过放宽权限规避。
- query_or_api_invalid：检查查询或基础库 API 支持情况。
- network_or_timeout：对比另一网络及前后台切换情况。

个人监听成功不再重置公共监听失败的退避时间；只有公共、个人快照匹配并应用成功才重置。连续失败按约 1、2、4、8 秒退避，最多 30 秒。旧公共监听关闭时产生的延迟错误不影响新房间的监听。重连仍会重新鉴权和补齐快照，因此频繁失败会增加请求量和页面同步等待。

更新这一修复只需重新编译并更新小程序；如果新日志提示云端权限或集合问题，则还需修正对应云环境配置。
