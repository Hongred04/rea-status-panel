# REA 状态面板

> A local status panel for [rea-agents](https://www.npmjs.com/package/rea-agents) — checks version, client integrations, analysis engines, and updates with one click. Windows, single-file build, zero dependencies.

一个围绕 `rea-agents`（REA）的本地状态面板。把「装了没、接的是哪个客户端、引擎齐不齐、有没有新版本」这类每次都要敲命令才知道的事，做成一个独立窗口。

它不是 REA 的一部分，也不修改 REA 的行为——只读取本地安装状态、调用官方 `doctor`，并在你确认后执行更新。

## 它解决什么问题

REA 装好之后，日常会遇到几类不确定性：

- 版本对不上：全局装的是旧版，`doctor` 不告诉你有没有新版
- 接入失效：Node 升级后全局包装在旧版本目录里，`mcp.json` 里的绝对路径悄悄失效
- 多个客户端各接各的：WorkBuddy 接 6.8，DSH 接 6.9，不知道该信哪个
- 引擎状态不透明：Hopper / Ghidra / IDA / JADX 装没装、能不能用，只有跑 `doctor` 才知道
- 更新要回终端：知道有新版本，还得切到命令行执行

这个面板把这些集中到一个窗口里，并给出可执行的修复动作。

## 功能

| 卡片 | 内容 |
|---|---|
| 版本与更新 | 本地与上游版本对比、一键更新（流式日志） |
| 命令行 | REA 版本与安装位置 |
| WorkBuddy 接入 | `mcp.json` 路径校验、接入版本、一键修复 |
| DeepSeek Harness | Cordis 补丁校验、DSH 版本、MCP 插件版本匹配、一键对齐 |
| 运行环境 | Node 版本与官方要求区间比对 |
| 深度分析引擎 | Hopper / Ghidra / IDA / JADX / Kuna 状态 |
| 技能包 | 分析工作流指令是否就位 |
| 当前能力范围 | 按引擎与接入情况判定「全功能」或「仅静态分析」 |

设计上的几个判断：

- **更新检查以 npm registry 为主源**，GitHub Releases 只做增强。原因是在某些网络环境下 `api.github.com` 不可达，但 registry 可达；只信 GitHub 会导致永远显示「无法检查」。
- **版本判定优先读更新器记录**。DeepSeek Harness 的 `runtime.json` 不会随桌面程序升级而更新，用它判断版本会误报插件不匹配。
- **接入失效时给一键修复**，而不是让你手改 JSON。修复动作有三条约束：原文件不是合法 JSON 就中止、写前备份、写后回读校验路径真实存在。

## 快速开始

### 直接使用打包版

从 Releases 下载 `REA-Panel.exe`，双击运行。

双击后是一个独立窗口（无地址栏、无标签页、无控制台）。关闭窗口即停止后台服务。

> 未签名 exe 首次运行可能触发 SmartScreen，需点「更多信息 → 仍要运行」。

### 从源码运行

```bash
node server.cjs
```

开发模式下前端从 `ui/` 目录读取，改完刷新即可，不必重新打包。

```bash
node server.cjs --no-open      # 不自动开窗口
REA_PANEL_PORT=7800 node server.cjs
```

## 构建单文件 exe

```bash
node build/build-exe.mjs
```

产物在 `dist/REA-Panel.exe`，约 83 MB，**自带 Node 运行时**，目标机器不需要装 Node。

构建做了四件事：

1. `node --experimental-sea-config` 生成注入 blob
2. 复制本机 `node.exe` 作为 exe 基础
3. `postject` 把 blob 注入，并处理 SEA fuse
4. 修改 PE 可选头的 Subsystem 为 `GUI(2)`，双击不弹控制台

## 冒烟测试

```bash
node build/smoke.mjs
```

启动打包后的 exe，断言接口可用性、首页渲染、以及两条安全约束（跨站写请求、非回环 Host），退出码即结果。

## 卸载

```bash
node build/uninstall.mjs                    # 预览，不动手
node build/uninstall.mjs --apply            # 移除接入与插件
node build/uninstall.mjs --apply --all      # 连面板自身一起清
node build/uninstall.mjs --apply --only wb-mcp   # 只处理某一步
```

默认是预览模式。**配置文件只做精确条目移除，不删整文件**——`cordis.patch.yml` 和 `mcp.json` 里还有你其他的配置，改动前一律备份。

## 技术说明

### 安全

本地 HTTP 服务天然暴露给浏览器，因此做了两层校验：

- **Host 校验**：所有请求要求 Host 为回环地址。防的是 **DNS rebinding**——攻击者把域名解析到 127.0.0.1 后，浏览器会视为同源，仅靠 CORS 挡不住。
- **Origin 校验**：写操作只放行回环来源。否则任意网页都能 POST `/api/update` 在本机触发安装。

### 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/status` | 快速状态（CLI、接入、DSH、Node、技能包），< 200ms |
| GET | `/api/doctor` | 官方 `doctor` 明细（引擎、权威 Node 版本），30s 缓存 |
| GET | `/api/release` | 上游版本比对，60s 缓存 |
| POST | `/api/update` | 执行 `rea update` |
| GET | `/api/update` | 更新任务状态与日志 |
| POST | `/api/repair-mcp` | 重写 WorkBuddy 接入配置 |
| POST | `/api/repair-dsh` | 对齐 DSH 的 MCP 插件版本 |
| GET | `/api/repair-dsh` | 对齐任务状态与日志 |

### 窗口实现

用 Edge 或 Chrome 的 `--app=<url>` 模式承载页面，并配**独立 `--user-data-dir`**。独立配置目录是关键：不指定的话 `--app` 会把请求转给已运行的浏览器实例然后自身退出，拿不到窗口的生命周期，也就无法实现「关窗即退服务」。

同时传 `--disable-sync` 与一组 `--disable-features`，避免浏览器账号体系弹出登录/同步引导。

## 环境要求

- **Windows**（PE 子系统修改、Edge 窗口、进程树终止都是平台特定实现）
- **Node 22+**（仅开发与构建需要；打包后的 exe 自带运行时）
- 目标机器需已安装 `rea-agents`

## 已知限制

- exe 未做代码签名，首次运行可能触发 SmartScreen
- 面板自身没有自动更新通道，改前端需重新构建
- 只自动对齐 REA 自己的 DSH 插件，第三方插件（如 `@linxin666/*`）只提示不自动改
- `server.cjs` 为单文件（SEA 单入口的取舍），未做模块拆分

## 关于 REA

REA 是一个反向工程工具链，作者是 [morluto](https://github.com/morluto/rea)。本项目只是它的外围面板，遇到 REA 本身的问题请到其仓库反馈。

## License

MIT
