# 实现说明 v0.2.0

本项目为 Jev 路由核心加 Harness 插件；设计包在同工作区 jev-harness-docs。可执行配置以 src/config.ts 为准。锁定 Harness 0.1.7-rc.2 / Cordis 4.0.4。

| 模块 | 职责 |
|---|---|
| engine / policy / jev | 任务、候选、语义判断、升级、上下文版本和付费门控 |
| wire / planner | 完整请求投影、厂家参数、历史预检、成本和缓存估算 |
| harness/plugin / context | 官方生命周期、任务更新、持久化压缩、检索工具、检查点 |
| harness/adapter / sse / usage | 增量解析、厂家回放、用量归一化、取消结算 |
| storage / telemetry / money | SQLite 预算、逐次调用、决策、事件、回执、上下文原文 |
| evaluation / demo | 四组评测接口与本地官方运行时演示 |

## 请求流程

agent/pre-step 在接受输入后建立或更新任务，必要时压缩历史工具文本。system-prompt/assemble 记录当前系统提示和工具定义。agent/request 收集历史与新输入，对每个候选做完整请求预检，再由预算、能力、质量门槛筛选；有经济/强档选择价值时调用 Jev。返回新的 LlmCallConfig，不改写冻结配置。

Jev 只接收目标、语言、阶段、有限事实和最近验证证据。整个序列化 state 有字节上限；截断时保守选强档，另检查输入上限。新目标可调用 updateTask，但不重置花费、预留和升级计数。普通步骤保持模型，阶段重评可选同档更合适路由；默认不自动降级。

同一 goal 的不同 repairAttemptId 验证失败才累计；eventId 去重，pass 清除该 goal 的失败累计。阈值可按 taskKind 配置。网络、鉴权、权限、环境错误不充当能力失败。宿主负责实际验证器，不自动相信模型声明。

shadow 保存建议而保留原模型，显式固定仍生效；off 关闭 Jev/自动选型而保留预算。adapter 发出请求前再次完整预检、检查取消、决定版本与原子预算。实际发送才记录 appliedRouteId。单次请求取消不触发隐式兜底或免费重试。

## 预算与恢复

1 USD = 1,000,000 microUSD，向上取整。SQLite 使用 WAL 与 BEGIN IMMEDIATE，跨进程竞争不能重复使用同一余额。默认按整个上下文容量的最贵输入价格加输出上限预留；配置经验证的 tokenBound 后使用本次请求保守上界。bytes/3 只排序估算，不用于硬预算。经济档可原子保留额外升级余额。

SSE 终止原因与最终 usage 到达后结算；流中间 usage 仅观察。断流或取消缺少最终用量则保留预留。已知费用即使随后断流仍计入账本。reasoning 是 completion 的子集，不重复加收；缓存从 prompt 中扣除后按缓存价计费。

费用超过预留仍记录真实费用并封锁该任务。硬预算依赖厂家价格、token 上界与输出计费约定，不能消除厂家违反约定造成的账单。取消本地传输不能保证厂家停止计费。回执校验和命令见 [优化说明](OPTIMIZATION.md)。

每个 task 绑定一个 session，不自动合并子 Agent 预算。配置 SHA-256 指纹改变时旧任务停止，账目保留。SQLite 持久化并不代替 Harness 会话持久化，宿主需配置会话存储。卸载会取消在途请求、完成本地账目标记后再关闭数据库。

## 重试与故障

Jev 每次仅一次请求。adapter 声明可重试错误与上限，但不自行重试；需要宿主的 request-error 中间件安排。演示未启用自动重试插件。每次重试必须重新路由和预留，不能叠加 SDK 隐藏重试；此前不确定费用仍占用预算。

| 错误 | 行为 |
|---|---|
| NO_ELIGIBLE_ROUTE / BUDGET_DENIED | 付费请求前停止；检查历史、生成参数、能力、预算 |
| STALE_CONTEXT / CANCELLED | 旧决定失效，不开始兜底调用 |
| TASK_CONFIG_CHANGED | 保留旧费用，用新 taskId 开始新业务任务 |
| REASONING_HISTORY_INCOMPATIBLE | 禁止混用原始推理历史；使用有证据的检查点 |
| STREAM_TRUNCATED / INVALID_USAGE | 不宣告成功；已知费用结算，未知费用保留 |
| BUDGET_OVERRUN | 保存真实费用，封锁后续付费 |
| SETTLEMENT_CONFLICT / RECEIPT_REQUEST_MISMATCH | 拒绝冲突回执，不覆盖旧费用 |

## 数据与边界

密钥从环境变量读取，正文和密钥不进入错误日志。账本保存目标、事实、证据引用、usage 和费用；压缩原文也保存于 context_artifacts，属于业务数据，宿主应按其存储规则管理。当前无加密、自动删除、权限系统或 OTel 导出。allowStateTransmission 只控制 Jev 状态传输。

Jev 与 v0.1 遗留预留没有新版 LLM attempts 元数据，使用 Store.reservations(taskId) 和 Store.settle(attemptId, actualMicrousd) 按原账单处理。pending/reconcile CLI 当前面向新版 LLM 尝试，不实现厂家账单抓取。其他限制见 [验证记录](VERIFICATION.md)。
