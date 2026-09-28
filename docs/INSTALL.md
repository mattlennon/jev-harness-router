# 安装与使用

需要 Node.js 24+、Git 和 npm。当前项目锁定 Harness 0.1.7-rc.2 / Cordis 4.0.4；RC 属于预发布版本。请按锁文件使用，不单独升级一部分 Harness 包。

## 安装 Harness 与源码插件

```sh
npm install -g @deepseek-ai/dsh@0.1.7-rc.2 pnpm@10
dsh --version
git clone https://github.com/mattlennon/jev-harness-router.git
cd jev-harness-router
npm ci
npm run build
```

以下创建独立 jev Web profile，只需首次执行；已存在时跳过初始化：

```sh
dsh --profile jev --from-default-profile web --dump-config
```

在插件仓库中创建未启用模型的用户配置（不会覆盖已有文件）：

```sh
node tools/init-user-config.mjs
dsh plugin --profile jev add .
dsh --profile jev --dump-config
```

此时插件已加入 profile，但模型模板仍未启用。接着填写模型与密钥，最后在希望模型操作的项目目录运行：

```sh
dsh jev
```

它等价于 dsh --profile jev，自动打开浏览器。默认 3080 端口；端口占用时加 --port 3081。使用终端打印的完整登录 URL（含 token），按 Ctrl+C 停止。不要在公开 issue 中分享登录 URL。

Windows 可使用 [启动脚本](../tools/start-harness.ps1)，用 -Workspace 指定工作目录、-HarnessRoot 指定可选的独立安装目录。某些打包应用会重定向用户级 npm 路径，导致框架被重复加载；这种环境可用 `npm install -g --prefix <独立目录> @deepseek-ai/dsh@0.1.7-rc.2 pnpm@10`，并通过该目录的 dsh 启动。

## 模型与密钥

默认用户目录为 ~/.dsh；可用 DSH_HOME 指定其他目录。

| 相对用户目录的文件 | 用途 |
|---|---|
| jev-router/router.json | 模型 ID、厂家协议、能力、价格、预算与路由模式 |
| .env | DEEPSEEK_API_KEY / KIMI_API_KEY / ZHIPU_API_KEY / TYPESAFE_API_KEY |
| jev-router/ledger.sqlite | 持久化费用账本 |
| profiles/jev/package.json | Harness 管理的依赖和 bundle 列表 |
| profiles/jev/cordis.patch.yml | 你自己的配置覆盖 |

先准备一条实际路由：填写 model、endpoint、上下文、收费输出上限、价格与 priceVersion、verifiedAt、outputIncludesReasoning，匹配 reasoning profile 后设 ready:true。其他路由保持 ready:false。初次建议 mode:off 验证界面所选单模型；off 不要求 Jev 密钥。自动路由需后续校准并明确允许向 Jev 传送状态。

密钥在本机 .env 中填写，勿提交 Git。插件读取环境变量；Harness 会加载工作目录和用户目录的 .env，但内置 Models 页的 managed credentials 不会自动变成环境变量，因此仅在内置厂家设置页填密钥不代表插件可以读取。

在插件仓库运行不付费检查：

```sh
node dist/src/cli.js doctor --config /path/to/router.json
```

doctor 的 keyPresent 只检查该进程继承的环境变量；需要读取 .env 时可在 node 后添加 `--env-file=/path/to/.env`。它不验证厂家实际能力。更多配置见 [厂家说明](PROVIDERS.md)。

重启 dsh 后，在新会话的模型选择器选择 **jev-router-...** 路由。选择普通内置厂家 provider 不经过本插件。本项目不自动修改默认模型。修改 router.json/.env 后应重启；已有任务受配置指纹保护，必要时结束旧任务并开新会话，账本费用保留。

## 打包、更新与卸载

本地链接依赖源码目录：修改代码后 npm run build，再重启 dsh。移动目录后重新 dsh plugin --profile jev add 新路径。

```sh
npm pack
# 将生成的已编译 tgz 安装到已准备好的 profile
dsh plugin --profile jev add ./jev-harness-router-0.2.1.tgz
```

tgz 包含编译结果，目标端无需再次 build；独立配置与密钥仍要创建。源码 ZIP 必须先解压、npm ci、编译，再 add 目录。不要假定从 Git URL 直接 add 会自动编译源码；推荐显式 clone/build 或使用 tgz。

移除插件：

```sh
dsh plugin --profile jev remove jev-harness-router
```

这只移除 profile 中的依赖与配置层，不删除源代码、密钥、历史会话或预算账本。

JEV_ROUTER_CONFIG / JEV_ROUTER_DATABASE 环境变量可覆盖默认文件位置，也可在 profile 的 cordis.patch.yml 覆盖：

```yaml
- id: jev-router
  config:
    routerConfigFile: '/absolute/path/router.json'
    databaseFile: '/absolute/path/ledger.sqlite'
```

config 是整体替换，两个字段都要保留。Windows YAML 可使用 C:/path 格式。

依据：[官方插件打包](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.7-rc.2/docs/user/develop/basic/publish.md)、[官方 CLI/profile](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.7-rc.2/apps/cli/reference/README.md)。
