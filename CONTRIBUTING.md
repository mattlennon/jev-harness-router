# 贡献指南

需要 Node.js 24+、npm 和 Git。从 main 建立独立分支，小范围修改并说明行为和验证结果。

```sh
git clone https://github.com/mattlennon/jev-harness-router.git
cd jev-harness-router
npm ci
npm test
npm run check:repo
npm run demo
npm run eval
```

代码在 src，回归测试在 test，厂家配置模板在 config，文档在 docs。依赖变更同时更新 package-lock.json；与 Harness 共享实例的包保持 peerDependencies + devDependencies 声明。

修改付费、取消、工具或历史转换路径时，增加能观察外部行为的回归测试。不得以吞掉异常、删除未知费用或放宽历史兼容检查使测试通过。模拟测试只连接 loopback；真实厂家测试需要操作者自行配置，不应在 PR 或 CI 中发送付费请求。

不提交 .env、真实服务配置、数据库、安装目录、依赖备份、诊断日志或含原始会话的报告。artifacts 中的报告均为本地生成，不进入 Git；漏洞请按 [安全说明](SECURITY.md) 私下报告。

PR 描述说明问题、最终行为和验证方式。GitHub Actions 在 Windows 与 Linux 上执行编译、57 项现有测试、仓库检查和打包检查。新增测试后不要求维持固定数量。

本项目使用 [MIT 许可证](LICENSE)。提交贡献意味着同意按该许可证提供相应代码；引用第三方代码时保留其许可证与来源。
