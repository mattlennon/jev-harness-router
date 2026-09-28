# 多厂家文本、工具与推理接入

vendor 选择协议，tier 来自业务评测，二者没有固定对应。每个实际模型使用独立 route/provider（jev-router-*）；同厂家可有多条路由。

| 厂家 | 完整 endpoint 预设 | 密钥变量 |
|---|---|---|
| DeepSeek | https://api.deepseek.com/chat/completions | DEEPSEEK_API_KEY |
| Kimi | https://api.moonshot.cn/v1/chat/completions | KIMI_API_KEY |
| GLM / 智谱 | https://open.bigmodel.cn/api/paas/v4/chat/completions | ZHIPU_API_KEY |
| openai-compatible | 用户指定完整 HTTPS URL | 用户指定 |

地域、账号、模型版本与价格以实际服务为准。模板不硬编码“最强/最便宜”模型，全部 ready:false。先确认模型 ID、上下文、最大收费输出、工具与推理行为、价格版本、验证记录，再设 ready:true。outputIncludesReasoning 表示最大输出和 completion 用量包含收费推理，不等于所有历史都兼容。

## 厂家推理映射

所有 profile 都保留 reasoning_content，并以 Harness replayState 标记协议、模型与推理块。文本/工具历史允许白名单转换，原始推理状态只允许相同厂家、模型、profile 回放。跨厂家/模型需先建立有证据的检查点，不能靠 compatibleFrom 绕过。

| reasoning 配置 | 实际请求 | 适用说明 |
|---|---|---|
| `{ "profile": "deepseek", "effort": "high" }` | thinking.enabled + reasoning_effort | low/high/max；默认 high；以实际模型能力为准 |
| `{ "profile": "kimi", "kimiMode": "preserved" }` | thinking.enabled + keep:all | 可开关且支持保留思考的 Kimi；省略 kimiMode 采用此映射 |
| `{ "profile": "kimi", "kimiMode": "always" }` | 不发送 thinking | 始终思考的 Kimi 系列；不透传 effort |
| `{ "profile": "kimi", "kimiMode": "k3", "effort": "high" }` | 不发送 thinking；发送 reasoning_effort | K3 模式 low/high/max |
| `{ "profile": "zhipu" }` | thinking.enabled + clear_thinking:false | 保留 GLM 推理；不声明 effort 支持 |
| `{ "profile": "zhipu", "effort": "high" }` | 上述参数 + reasoning_effort | 显式声明已验证模型支持 effort；实现 common low/high/max 子集 |

GLM 的 effort 需按模型选择：当前官方文档将该功能限定到相应较新模型，旧模型不能凭厂家名称启用。推理路由拒绝显式 temperature；其他不支持的控制项同样在请求前失败。Kimi always/k3 配置必须删除 requestOptions.thinking，不能同时声明 enabled/disabled。

依据：[DeepSeek 思考模式](https://api-docs.deepseek.com/guides/thinking_mode/)、[Kimi Thinking Models](https://platform.kimi.ai/docs/guide/use-thinking-models)、[GLM 深度思考](https://docs.bigmodel.cn/cn/guide/capabilities/thinking-mode)、[GLM 对话 API](https://docs.bigmodel.cn/api-reference/模型-api/对话补全)。这些映射已通过本地协议和官方 Harness 运行时测试；没有替代真实厂家验收。

## SSE 与用量

设置 transport:sse；DeepSeek/Kimi 请求 stream_options.include_usage，GLM 使用其原生终段 usage，不发送该扩展。解析 UTF-8 分片、CRLF、多行 data、注释、reasoning_content、文本、工具 ID/名称/参数片段与 [DONE]。仅完整且参数合法的工具块结束后才交给运行时执行。超时覆盖整个响应。

要求一个 choice、标准 tool_calls、usage.prompt_tokens/completion_tokens；缓存接受 prompt_tokens_details.cached_tokens 或 prompt_cache_hit_tokens。reasoning_tokens 是 completion 子集。最终用量配合 finish_reason 才结算，缺少 [DONE] 不能视为成功。兼容 JSON 回退；transport 省略默认 JSON。

## 配置字段与切换

| 字段 | 要求 |
|---|---|
| capabilities.compatibleFrom | 目标能接续哪些源 route 的文本/工具历史；需真实多轮验证 |
| contextWindow / maxOutputTokens | 实际支持上限，输出必须覆盖收费推理 |
| pricing | USD/百万 token，输入、输出、可选缓存读；其他币种需明确换算与 priceVersion |
| tokenBound | 可选，已验证的 bytes→token 保守上界及引用；省略则完整上下文预留 |
| performance | 可选，expectedOutputTokens、remainingCalls、qualityLowerBound、reportId；用于 costAware |
| cacheTtlMs | 本地缓存命中观察的最长有效时间，默认 5 分钟，不是厂家缓存保证 |
| optimization | 见 [优化说明](OPTIMIZATION.md)，需要评测参数 |

costAware:false 时简单任务选首个合格经济路由；true 时按估计剩余成本排序。强档复杂任务仍使用 defaultRouteId；并未实现自动厂家排行榜或故障迁移。

先固定一个模型验证基本请求，再测工具多轮、推理回放、取消后账单、上下文上限；最后验证源→目标切换，填写 compatibleFrom。smoke 不涵盖完整验收。所有受管 LLM 请求需要 sessionId 和路由决定，标题/自动摘要等辅助付费调用尚无独立预算，当前拒绝。
