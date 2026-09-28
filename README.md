# Jev × DeepSeek Harness 路由插件 v0.2.1

[![CI](https://github.com/mattlennon/jev-harness-router/actions/workflows/ci.yml/badge.svg)](https://github.com/mattlennon/jev-harness-router/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

支持 DeepSeek、Kimi、ChatGLM / 智谱及同类 Chat Completions 服务的 TypeScript 插件。范围为文本、函数工具调用、厂家推理回放和 SSE；两个逻辑档位可登记任意数量的厂家与模型。

依赖锁定 **Harness 0.1.7-rc.2 / Cordis 4.0.4**，对应截至 2026-09-28 核验的最新已发布 Harness 版本（包含预发布版）。见 [官方 release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-rc.2) 与 [来源锁定](SOURCE_LOCK.json)。安装时复核 @deepseek-ai/dsh 的 latest/next 均指向此版本。项目尚未发布 npm，可用本地 bundle 或已编译 tgz 安装，见 [完整安装指南](docs/INSTALL.md)。

## 本地运行

需要 Node.js 24+；以下模拟验证不使用真实密钥：

```powershell
git clone https://github.com/mattlennon/jev-harness-router.git
cd jev-harness-router
npm ci
npm test
npm run demo
npm run eval
npm run doctor
```

demo 使用官方 AgentLoop、工具运行时与会话投影，通过本地 SSE 服务完成两次工具验证，演示 economy → economy → strong，并输出逐次账目。eval 为四组模拟对照，所有成本和质量数字均为测试数据。

## 已实现

| 范围 | 交付行为 |
|---|---|
| 新版适配 | RequestMessage、独立 tool 消息、完整工具投影、受管 LlmAdapter、持久化会话 surface 替换 |
| P0 | 完整请求预检、上下文哈希、逐次 usage/缓存/推理/费用/首 token 延迟、目标与阶段更新 |
| P1 | 质量门槛与预计费用排序、前缀缓存观察、切换收益与驻留门槛、升级预算、工具结果压缩、可追溯检查点 |
| P2 | DeepSeek / Kimi / GLM 专用推理配置及回放、真正增量 SSE、取消与断流结算、人工回执对账 |
| 路由与预算 | off/shadow/auto、固定模型、最多一次自动升级、SQLite 原子预留、重启恢复、未知费用持续占用预算 |
| 验证 | 官方核心运行时 + 本地 HTTP/SSE；真实厂家联调仍待配置 |

## 配置真实服务

```powershell
npm run build
node dist/src/cli.js init --reasoning --config config/router.local.json
Copy-Item .env.example .env
```

不需要推理时省略 `--reasoning`。模板保留实际模型 ID、能力、价格、验证记录和密钥变量，路由均未启用。按 [厂家说明](docs/PROVIDERS.md) 填写；Kimi preserved / always / k3 模式必须匹配实际模型。新模板默认 SSE，旧配置省略 transport 时继续 JSON。

```powershell
node --env-file=.env dist/src/cli.js doctor --config config/router.local.json
node --env-file=.env dist/src/cli.js smoke --config config/router.local.json --route deepseek-strong
node --env-file=.env examples/agent.mjs --config config/router.local.json --route kimi-strong --prompt "解释函数职责"
```

doctor 只检查配置和环境变量。smoke 与 agent 示例会产生真实请求；smoke 固定模型、跳过 Jev，仅验证一次响应，不能替代工具多轮、取消计费和真实任务评测。先验证各路由，再启用 shadow；填写校准报告、语言覆盖与兼容白名单后再启用 auto。

## 集成宿主

```js
import * as RouterPlugin from './dist/src/harness/plugin.js';
import { resolve } from 'node:path';
await ctx.plugin(RouterPlugin, {
  routerConfigFile: resolve('config/router.local.json'),
  databaseFile: resolve('data/router.sqlite'),
}).await();
```

使用与本项目一致版本的 Harness 服务，先挂载 llm 和 tools。Agent 的 provider / model 使用配置中一组受管路由。完整宿主见 [agent.mjs](examples/agent.mjs)。完整应用安装采用 dsh.bundle 配置层；同框架依赖声明为 peerDependencies，与宿主共享实例，开发测试另用 devDependencies。

```js
const router = ctx.jevRouter.engine;
router.beginTask(agent.id, userGoal, { taskId: businessTaskId, language: 'zh-CN' });
router.updateTask(agent.id, { phase: 'verification', facts: ['验证器已确认的事实'] });
router.recordEvidence(agent.id, {
  eventId: checkEventId, repairAttemptId, goalId: validationGoalId,
  category: 'task_validation', outcome: 'fail', evidenceRef: testReportPath,
});
router.fixRoute(agent.id, 'kimi-strong'); // null 解除固定；仍受历史兼容和预算约束
router.finish(agent.id, 'success'); // 由独立验收器确认，不能相信模型自报成功
```

未显式 beginTask 时，插件使用首次接受的用户输入创建会话任务。后续用户输入加入有限事实并触发重评；同一任务保留费用与升级计数。新业务任务应结束旧任务后再 beginTask。跨模型不直接移植原始推理状态；必要时使用宿主确认、保留证据的检查点。

## 交付文件

| 文件 | 内容 |
|---|---|
| [完整安装指南](docs/INSTALL.md) | 本机启动、模型/密钥配置、bundle 安装、更新和卸载 |
| [优化说明](docs/OPTIMIZATION.md) | P0/P1/P2、token 与成本、检查点、取消对账命令 |
| [迁移说明](docs/MIGRATION-0.2.md) | 新版 Harness API 与旧账本处理 |
| [实现说明](docs/IMPLEMENTATION.md) | 路由、并发、计费和实现边界 |
| [厂家配置](docs/PROVIDERS.md) | DeepSeek / Kimi / GLM 推理参数映射 |
| [验证记录](docs/VERIFICATION.md) | 测试、报告、真实服务未验证项 |
| [文本模板](config/router.example.json) / [推理模板](config/router.reasoning.example.json) | 未启用的多厂家路由 |
| [插件入口](src/harness/plugin.ts) / [适配器](src/harness/adapter.ts) | Cordis 事件与 LLM/SSE 接口 |

没有提供图像/音视频、辅助付费摘要预算、自动厂家故障迁移、厂家账单自动拉取、管理 UI。预计费用和质量门槛需要校准，不能据此宣称真实降本。

运行 `npm run check:repo` 检查受跟踪文件与文档链接，`npm run check:package` 检查安装包内容。`npm pack` 生成已编译 tgz；`powershell -ExecutionPolicy Bypass -File tools/package.ps1` 只从 Git HEAD 导出源码 ZIP。报告保持本地生成，详见 [报告说明](artifacts/README.md)。

欢迎按 [贡献指南](CONTRIBUTING.md) 提交问题与 PR；安全问题见 [SECURITY.md](SECURITY.md)。项目使用 [MIT 许可证](LICENSE)，变更记录见 [CHANGELOG.md](CHANGELOG.md)。
