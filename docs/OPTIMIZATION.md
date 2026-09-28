# P0 / P1 / P2 优化与使用

本次实现分清三件事：选择哪个模型、给模型哪些上下文、怎样结算实际调用。SSE 改善首字延迟；压缩与缓存主要影响输入；模型成功率、输出长度和重试影响总成本。不能仅用模型标价判断是否省钱。

## P0：先看清并约束每次调用

| 优化 | 实现 | 结果 |
|---|---|---|
| 逐次记录 | attempts + decisions + events | route/provider/model、价格版本、请求哈希、估算/上界、usage、缓存/推理细分、首 token/总延迟、请求 ID、状态和实际费用 |
| 完整请求预检 | prepareWire + agent/request | 系统提示、工具定义、完整历史、生成控制、上下文窗口、工具配对、厂家推理兼容均在付费前检查 |
| 目标与阶段更新 | engine.updateTask | 同一任务追加事实或变更目标，保留预算、升级与证据，不靠创建新任务清零成本 |
| 最后门控 | adapter + SQLite | 其他插件改写请求、并发抢占余额、任务过期或取消仍会被再次检查 |

Jev usage 另记事件与费用；Jev 只看到有限任务状态，不接收完整聊天/代码仓库。accepted 用户输入会更新最新事实；宿主明确改变主目标时调用：

```js
ctx.jevRouter.engine.updateTask(agent.id, {
  text: '新的明确目标', phase: 'verification',
  facts: ['构建已通过', '集成验证仍失败'], reevaluate: true,
});
```

facts 最多 32 项、每项 1000 字符；分类的整个 state 再按字节收紧，截断后保守处理。不要把未经验证的模型自述当成验收证据。

## P1：减少无效输入与不划算切换

### 同一会话切换是否增加 token？

切换动作本身没有固定 token 附加费。Chat Completions 每次通常要重新提交保留的消息；切换后，新模型仍需这些上下文，tokenizer 可能不同，原厂缓存也不能假定可共用。费用可能上涨，即使提示文字没有增加。

本实现不会为了切换额外先调用一次新模型。排序估算包含当前完整请求、观察到的缓存命中和预计输出；跨 endpoint/model/凭据的缓存观察隔离。首次冷请求按无可用观察处理，不把“相同会话 ID”当缓存命中。

```text
预计剩余费用 ≈ 剩余调用数 × (
  未缓存输入 token × 输入单价
  + 观察到的缓存输入 token × 缓存单价
  + 预计输出 token（含推理）× 输出单价
)
```

这是规划估算，不是准确 tokenizer 或厂家缓存承诺。token 估计暂用序列化请求 bytes/3；预计输出与调用数来自 performance 配置。真实费用始终来自最终 usage/回执。缓存根据确切消息前缀和工具定义匹配，观察有 TTL，估计命中率最多 90%；没有观察就不折扣。不同前缀、模型、凭据或过期记录不共用。

### 可启用配置

根配置示意（这些数值是示意，需业务校准）：

```json
{
  "optimization": {
    "costAware": true,
    "minimumQuality": 0.9,
    "switchMarginMicrousd": 1000,
    "minResidenceSteps": 3,
    "upgradeReserveMicrousd": 100000,
    "toolResultMaxChars": 8000,
    "retainRecentToolResults": 2,
    "failureThresholds": {
      "documentation": 3,
      "local_edit": 2,
      "debugging": 1,
      "design": 1,
      "unknown": 2
    }
  }
}
```

参与费用排序的经济/其他非默认候选需 performance：

```json
{
  "performance": {
    "expectedOutputTokens": 1000,
    "remainingCalls": 3,
    "qualityLowerBound": 0.93,
    "reportId": "真实评测报告引用"
  }
}
```

未达质量门槛就不进入候选；defaultRouteId 强档保留为兜底。简单任务从合格经济路由中按预计成本选择，复杂任务和升级仍选默认强档。同档切换只有估计收益超过 margin 且满足驻留步数才应用；能力升级不被这些经济门槛拖延。每个普通步骤保持路由，仅新目标/阶段重评或验证失败驱动改变。不实现自动强模型排行榜或故障转移。

### 预算预留

估算成本不能用作硬预算。默认按整个上下文容量加输出上限预留；可选 tokenBound 必须提供保守 bytes→token 系数、消息/工具额外开销与 verificationRef，验证覆盖当前模型、工具序列化和消息封装。否则保留默认全窗口策略。

经济调用原子要求 `available >= 本次预留 + upgradeReserveMicrousd`，因此并发不能吃掉配置的保留额。保留额不会自动根据未来历史计算，宿主需配置能覆盖预计强档一次调用的金额；它不保证未来任意长度都够用。实际费用超上界后仍入账并封锁任务。

### 工具结果与检查点

工具压缩发生在新步骤前，对超过限制、非错误、纯文本且不在最近保留范围的工具结果保留首尾与原文引用。使用 Harness surface replace，仅修改 content、保留原消息 ID、source、toolCallId，旧事件留在日志中。原文写入 context_artifacts，router_read_context 按 task 隔离、按 offset/length 读取。工具错误与最近结果不自动压缩。压缩是字符裁剪，不是语义摘要；仍可检索遗漏内容。

跨模型原始推理无法通用回放，或者长会话需要更大幅度收缩时，宿主在 agent.status===idle 提供检查点：

```js
ctx.jevRouter.checkpoint(agent, coveredSurfaceSeqs, {
  goal: '当前目标',
  facts: ['已确认事实'],
  changes: [{ path: 'src/example.ts', version: '文件哈希或提交' }],
  tests: ['独立验证结果与日志引用'],
  unresolved: ['尚未解决的问题'],
  evidenceRef: '检查点复核记录',
});
```

coveredSurfaceSeqs 必须来自当前 session.surface.nodes 的连续范围，完整覆盖工具调用及结果，不能覆盖 system/developer 消息。插件检查边界并保留 sourceEventSeqs、原始日志与审计哈希；不会自动调用另一个模型“免费总结”。宿主对检查点事实准确性负责。完成后仍需目标 compatibleFrom 白名单和费用准入。

## P2：厂家推理、SSE 与取消对账

推理参数见 [厂家说明](PROVIDERS.md)。SSE 逐片输出文本、reasoning 和工具参数，直到有效终止后交付完整工具块。推理回放有模型与 profile 标记；不默默丢掉必要 reasoning_content。

| 终止情况 | 账目 |
|---|---|
| 发出请求前被拒绝/取消 | 不预留或释放为 0 |
| 收到终止原因与最终 usage | 按输入/缓存/完整输出费用结算 |
| 最终 usage 后取消或断流 | 已知费用保留；断流不宣告成功 |
| 仅中间 usage，随后取消/断流/超时 | 记录观察用量，继续保留整笔预留 |
| 进程退出，无法确认结果 | 持久化预留保留，由操作员确认终止和回执对账 |

客户端断开不等于服务端停止计费。终止控制不隐式重试，也不把流中已展示的文本当免费请求。

```powershell
node dist/src/cli.js pending --db data/router.sqlite
node dist/src/cli.js reconcile --db data/router.sqlite --receipt config/receipt.local.json
```

回执 JSON 包含 attemptId、requestId、receiptRef 和 actualMicrousd。参考 [回执字段模板](../config/receipt.example.json)，其中 0 只是占位值，必须替换为账单实际金额；不是默认免单。requestId 优先对应响应头或正文 request_id，其次 response id。没有获得供应商 ID 时，由操作员提供可追溯的人工匹配引用；程序不能独立验证账单真实性。

进程崩溃后遗留 streaming/reserved 状态不能直接对账，先确认旧进程已终止、不会继续写账，再执行：

```powershell
node dist/src/cli.js abandon --db data/router.sqlite --attempt ATTEMPT_ID --evidence PROCESS_TERMINATION_RECORD
```

abandon 仅标记操作员确认终止，不终止其他进程、不释放费用。随后按账单 reconcile。相同金额可重复提交；请求 ID 不匹配、费用冲突、仍在进行的尝试会拒绝；超出预留的实际费用照实记录并封锁后续调用。回执引用、实际金额、对账时间保存于 attempts/events。

CLI 当前覆盖新版 LLM 尝试。旧版或 Jev 预留继续用 Store.reservations/settle 对应账单；无自动厂家账单拉取、自动轮询和擅自清零。

## 验收边界

本地测试证明路由和协议行为、Harness 兼容与费用状态转换。真实降本还需要各厂家的多轮推理、缓存命中、取消账单和代表性任务成功率测试。当前不提供真实节省百分比或生产质量保证；测试数据与报告均标记 synthetic。
