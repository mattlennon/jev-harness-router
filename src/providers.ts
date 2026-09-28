/** Endpoint presets only. No model capability or price is inferred from a brand. */
export const providers = {
  deepseek: { name: 'DeepSeek', endpoint: 'https://api.deepseek.com/chat/completions', keyEnv: 'DEEPSEEK_API_KEY',
    docs: 'https://api-docs.deepseek.com/api/create-chat-completion/', requestOptions: { thinking: { type: 'disabled' as const } } },
  kimi: { name: 'Kimi / Moonshot', endpoint: 'https://api.moonshot.cn/v1/chat/completions', keyEnv: 'KIMI_API_KEY',
    docs: 'https://platform.moonshot.cn/docs/api/chat', requestOptions: { thinking: { type: 'disabled' as const } } },
  zhipu: { name: 'ChatGLM / 智谱', endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions', keyEnv: 'ZHIPU_API_KEY',
    docs: 'https://docs.bigmodel.cn/api-reference/模型-api/对话补全', requestOptions: { thinking: { type: 'disabled' as const } } },
};
