# 本地生成的验证报告

本目录只跟踪本说明文件。报告可能包含本机路径、服务配置或任务内容，不自动提交或打包发布。

| 命令 | 本地输出 |
|---|---|
| npm test | 标准输出；可由终端保存到 test-results.txt |
| npm run demo | demo.json，本地模拟官方 AgentLoop + SSE |
| npm run eval | evaluation.synthetic.json，模拟对照 |
| npm run doctor | 配置声明检查的标准输出 |
| 显式安装检查 overlay | harness-installation.json，本机 Harness 激活与路由注册 |

安装检查工具只在明确传入 tools/check-installed-plugin.patch.yml 时加载。它会写入本机解析路径，不应将输出公开。真实服务 smoke/eval 报告同样保持在本地。
