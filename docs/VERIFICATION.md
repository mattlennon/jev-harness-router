# 验证记录

日期：2026-09-28。Windows / Node.js 24.18.1；Harness 0.1.7-rc.2、Cordis 4.0.4，来源见 [SOURCE_LOCK](../SOURCE_LOCK.json)。

```powershell
npm ci
npm test
npm run demo
npm run eval
npm run doctor
```

测试全部连接 loopback 模拟服务，不调用付费端点。覆盖原有路由模式、Jev 超时/熔断/取消、升级证据、预算重启、跨 OS 进程竞争、官方宿主装配，以及以下新增路径：

- DeepSeek/Kimi/GLM 推理 → 分片工具调用 → 官方工具执行 → 下一轮完整推理回放。
- 内容在服务器结束前交付；UTF-8/CRLF 分片；最终 usage 与 [DONE] 检查。
- 最终用量已知/未知两类取消、断流；悬停生成器时关闭插件；未知费用持续预留。
- 回执请求 ID 校验、重复/冲突费用；Kimi always/k3 与 GLM effort 映射。
- 完整请求预检、质量和费用筛选、切换收益门槛、缓存精确前缀与模型/密钥/工具/TTL 隔离。
- token 保守上界、原子升级预留、任务更新保留费用、分类状态总字节上限。
- 官方 surface 工具压缩保持消息身份、原文检索隔离、完整工具边界检查点和跨模型推理隔离。

2026-09-28 本地验证 **57 项测试通过，0 失败**。编译、测试、demo、eval、doctor 均在本地执行。demo 使用 SSE，模型路线 economy/economy/strong，模拟已结算 1714 microUSD、待结算 0；该数字不是商业成本估算。当前提交的跨平台结果请查看 GitHub Actions。

报告由上述命令本地生成，不跟踪进 Git，见 [报告说明](../artifacts/README.md)。

## 未验证部分

没有真实厂家或 TypeSafe 密钥，未发送真实付费请求；具体账号的工具、推理参数、取消后的计费、价格、质量与节省比例均未验证。v0.2.1 已在本机完整 Harness Web profile 中启动、验证四条受管路由注册、共享 Cordis 实例及页面 HTTP 200；安装检查报告留在本地。尚未进行完整应用内的真实模型任务验收。厂家账单采用人工回执，没有自动拉取或实时停止计费保证。

## 真实评测接口

```powershell
node dist/src/cli.js eval --executor ./my-executor.mjs --tasks ./tasks.json --out artifacts/live-evaluation.json
```

模块导出 async execute(task, group)，返回 `{ success, costMicrousd, pendingMicrousd, elapsedMs, evidence }`。任务项为 `{ id, language, prompt, fixture, expected }`。分组 fixed-economy / fixed-strong / rules / jev，按固定种子轮换。每组重置环境、独立验收，费用包含 LLM + Jev + 重试与未结算预留。普通失败仍返回结果，执行器异常中止本轮。

每成功任务成本 = 所有任务已结算费用与未结算保守上限之和 / 成功数；没有成功时为 null。默认 synthetic:true，报告仅做描述统计，不自动给出生产质量门槛。costAware 的质量下界、输出长度和剩余调用数需要真实基准提供。
