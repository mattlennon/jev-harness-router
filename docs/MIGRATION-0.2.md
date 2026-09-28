# v0.1 → v0.2 迁移

目标依赖为 Harness 0.1.7-rc.2、Cordis 4.0.4；核验日期 2026-09-28。[官方 release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-rc.2) 对应 commit 477b4f420553e8a52c2fbccc464d7561b239c443。此次“最新”包含 RC，不能解释成稳定版标签。

## 代码适配

- RequestMessage 包括已持久化消息和即时输入；不再要求所有输入有 id/source。
- 工具结果使用独立 role:tool 与 toolCallId，内容是普通文本块；保留工具调用参数原始 JSON。
- 用 projectToolUpdates 展开当前工具定义，避免把 Harness 的工具更新元数据直接发给厂家。
- 接入 system-prompt/assemble 与 agent/request，先检查完整请求，再返回新 LlmCallConfig。
- 推理以 reasoning-delta 与 replayState 持久化；回放检查厂家、模型、profile 和协议版本。
- 上下文修改使用 session surface replacement，保留原始事件和来源序列；工具结果只替换 content，不新建消息身份。

## 配置与数据库

保留 schemaVersion:1，新增字段可选。旧配置缺少 transport 时保持 JSON；新增模板默认 SSE。优化需要 optimization；成本排序默认关闭，真实校准后启用。配置需匹配实际模型协议，推理模板并不声明真实服务 ready。

数据库通过 additive CREATE TABLE IF NOT EXISTS 增加 attempts、cache_observations、context_artifacts，保留原 task、decision、reservation、event 及未结算费用。字段增加不重置余额。

配置指纹不同会拒绝继续旧任务，防止在同一账目下悄然换价格或边界。先备份 SQLite（使用 SQLite 备份或在进程完全关闭并完成 WAL checkpoint 后复制），结束旧任务，再以新 taskId 启动；历史预留仍须对账，不能通过删除数据库规避费用。v0.1 没有 attempts 元数据的预留仍用旧 Store.reservations/settle 路径。

宿主服务必须一起升级到相容版本，避免不同版本消息类型并存。使用 npm ci 复现 package-lock；仅 npm install @deepseek-ai/dsh-agent@latest 可能得到旧标签，且留下不一致 peer 依赖。

## 实际验证顺序

1. 本地 npm test、demo、eval、doctor，确认官方核心运行时和账本行为。
2. 填写真实 endpoint/model/价格/能力，固定单路由测试文本、SSE、工具多轮和推理回放。
3. 验证取消后的最终 usage/账单，检查断流时预留和人工回执。
4. 验证文本工具跨模型历史及检查点切换，再填写 compatibleFrom。
5. 用真实任务校准 Jev 与 performance，观察 shadow，最后启用 auto / costAware。

v0.2.0 未向真实厂家发送付费请求。v0.2.1 已补齐可安装 bundle 并在完整 Web profile 完成启动与注册检查，见 [安装指南](INSTALL.md)。迁移前应保留旧配置和费用账本备份；备份、安装诊断与本机路径不进入公开仓库。
