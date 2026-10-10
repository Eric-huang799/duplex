# Duplex

[![build](https://github.com/Eric-huang799/duplex/actions/workflows/build.yml/badge.svg)](https://github.com/Eric-huang799/duplex/actions/workflows/build.yml)
[![Glama](https://glama.ai/mcp/servers/Eric-huang799/duplex/badges/score.svg)](https://glama.ai/mcp/servers/Eric-huang799/duplex)
[![awesome-mcp-servers](https://img.shields.io/badge/awesome--mcp--servers-listed-blue)](https://github.com/punkpeye/awesome-mcp-servers)
[![freemcp.space](https://img.shields.io/badge/freemcp.space-listed-orange)](https://freemcp.space/featured/duplex)

> **收录与展示**：[awesome-mcp-servers](https://github.com/punkpeye/awesome-mcp-servers) · [freemcp.space](https://freemcp.space/featured/duplex) · [Glama](https://glama.ai/mcp/servers/Eric-huang799/duplex)

<p align="center"><img src="docs/screenshots/mascot.png" width="360" alt="Duplex 吉祥物"></p>

**一个人与 AI 共用的浏览器** —— 人看渲染后的页面，AI 读 DOM 与源码；同一个标签、同一个实时会话，同时进行。

[English](README.md) | **中文**

![Duplex 起始页（暗色）](docs/screenshots/start-page-dark.png)

*Duplex 起始页（暗色主题），另附[亮色主题](docs/screenshots/start-page-light.png)。*

## 演示

![Duplex 演示 —— AI 搜索 B 站论文解读视频、打开并播放，侧栏同步镜像每一步](docs/screenshots/demo.gif)

*AI 在操作：搜索 B 站、打开视频并开始播放，侧栏实时镜像每一步。*

**完整演示 —— 3 分钟，中英双语字幕 + 配乐：**

[![点击播放完整演示](docs/screenshots/demo-video-cover.jpg)](docs/videos/duplex-demo.mp4)

*一条完整走查：第一幕 —— 内置模型自主搜索 B 站并播放论文解读视频；第二幕 —— Kimi 打开 Claude 询问「CUDA 是什么」并回来总结答案；功能亮点 —— 多模型协议、Skills 技能、外部 Agent、急停接管；以及获取方式。*

![用 Duplex 操控网页版 Excel](docs/screenshots/excel-web-demo.png)

*操控微软网页版 Excel——未安装任何表格编辑专用 skill，仅靠原厂 API 与少量简单自动化 skill 完成* 😅

> **这是可行性演示，不是推荐用法。** 由于没有专用 skill 可用，Duplex 只用原厂 API 和少量简单自动化 skill，临时摸索出剪贴板读写通道、DOM 探测等办法，把一整张成绩表写进了网页版 Excel。效果是有的，但过程非常费时、消耗了大量 token。😅

## ⚠️ 使用提示

- **安全边界（高危，务必注意）**：Duplex 让 AI 直接操控你**真实的浏览器会话**——包括登录态、Cookie 与本地数据。在这种架构下，AI 的误操作可能触及真实账号与数据（发消息、提交表单、修改或删除内容等），潜在后果可能很严重。请勿在登录了敏感账号的环境里让 AI 无人值守地执行任务。急停快捷键（默认 `F2` / `Ctrl+Shift+K`，可在设置中自定义）是最后一道人工刹车，但它**不能替代你对"AI 可以碰什么"的判断**。

- **你和 AI 共用一个页面——优先听你的。** 当你在滚动、输入或与页面交互时，AI 会继续观察，但**暂停自己在该页面的修改**，而不是和你抢同一份输入；顶部状态条会列出处于"人工接管"的页面，你准备好后可以逐页一键交还。急停仍是最后的硬刹车：一键切断全部 AI 操作、它启动的 CLI 子进程和排队消息。

## v0.2.9 新增

- **人机协作（以人为先）** —— AI 会给你让路：你一滚动 / 输入 / 触摸 / 聚焦，它继续读取和思考，但暂停自己在该页面的修改；状态条展示被人工接管的页面，点一下即可逐页交还。即使 AI 正在操作，你的滚动位置与焦点也不会被夺走。
- **底层换上 Playwright** —— 页面操作改为驱动浏览器自己的 Chromium：locator 在 DOM 变化后依然稳定，iframe 与开放 shadow DOM 直接可用，等待与脚本执行可取消；AI 的合成输入会被标记，应用能把你和 AI 的操作区分开。
- **任务标签绑定与消息完整性** —— 每个 AI 任务绑定在自己的标签上：切换可见标签不会"带走"AI，任务标签被关掉会明确报错，而不是改去操作别的页面。面板消息与标注携带来源标签 / 文档标识 / 目标会话；注入单次领取（60 秒租期 + 续租 + ACK），不会串进错误会话，重试也不重复投递。
- **会话恢复** —— 退出时保存标签、顺序与活动页面，下次启动自动恢复（空白页可恢复；本地 `file:` / `data:` 页面不持久化）。
- **更干脆的停止语义** —— 停止内置任务会取消该任务的模型调用、工具与待确认操作；急停再额外终止本应用启动的 CLI 子进程并清空排队注入。

*本版同时包含 0.2.6 批次的能力：全量快捷键自定义、完整书签管理、原生右键菜单、进文档流的查找条、`F2` / `Ctrl+Shift+K` 急停与诚实的标注投递。*

## 和同类项目比，Duplex 的差异在哪

| | **Duplex** | browser-use | Browser MCP | Playwright MCP | AI 浏览器（Atlas / Comet）|
|---|---|---|---|---|---|
| 形态 | 桌面浏览器（Electron 应用）| Python 自动化框架 | MCP 服务器（浏览器扩展）| MCP 服务器（微软官方）| 闭源产品 |
| 谁在用浏览器 | **人与 AI 共用同一个标签、同一个实时会话** | AI 独占（独立自动化实例）| AI 控制你当前的 Chrome | AI 独占（Playwright 实例）| AI 助手在侧边/代操作 |
| AI 的感知 | DOM 大纲快照 + 源码 + 截图 | 视觉 + DOM | 截图 + 可访问性树 | 可访问性树 | 内部实现 |
| 人机协作 | **同屏实时协作；按急停键即可随时打断 AI 操作** | 事后看日志 | 人旁观 | 人旁观 | 有限人工干预 |
| 两边同时操作同一页时 | **AI 给人让路：逐页暂停 + 一键交还** | — | — | — | — |
| 可接入的 AI | **内置模型 + opencode / Codex / Claude Code / Gemini / Qwen / 任意 MCP 客户端** | 需自配 LLM | 任意 MCP 客户端 | 任意 MCP 客户端 | 仅官方模型 |
| AI 对话可见性 | **侧边面板实时镜像（含外部 CLI 的对话与工具调用）** | 日志/终端 | 客户端内 | 客户端内 | 应用内 |
| 数据 | 完全本地 | 本地/云 | 本地 | 本地 | 云 |

> 一句话：browser-use / Playwright MCP 解决的是"让 AI **替你跑**流程"；Duplex 解决的是"让 AI **和你一起用**你正开着的那一个浏览器"——同一个标签、同一个会话；当你们同时伸手碰页面时，**你先**。

## 特性一览

- **一个真正的浏览器** —— 多标签、地址栏（百度 / Bing / Google 搜索）、前进 / 后退 / 刷新、主题、壁纸起始页，外加**全量可自定义的快捷键**与**完整的书签管理**（文件夹、编辑、排序、搜索）。
- **人机协作（以人为先）** —— AI 在绑定的标签上工作；你操作时它只观察不抢；你接管后它暂停该页修改，准备好后逐页交还。同一个标签、同一个实时会话，互不踩脚。
- **24 个 MCP 工具，Playwright 驱动** —— `snapshot` 把任意页面压缩成紧凑 DOM 大纲（可交互元素带 `[eN]` ref）；点击、输入、拖拽与读取走 Playwright locator（DOM 变化后仍稳定、支持 iframe 与开放 shadow DOM、等待可取消）；其余覆盖标签管理、导航、上传、控制台、JS 求值与页面标注。
- **零配置桥接** —— stdio MCP 桥 `mcp-bridge` 在第一次工具调用时自动拉起浏览器，免手动启动。适用于 opencode、Claude Code 及任意 MCP 客户端。
- **会话实时镜像** —— AI 通过 opencode 工作时，它的回复、思考与工具调用卡片实时流入侧边面板；在面板里发言可把消息注入同一个会话。
- **AI 操作可视化** —— 半透明光标、目标元素高亮与底部状态条（"AI 正在点击「…」· F2 急停"）绘制在 Shadow-DOM 覆盖层中，AI 在页面上做什么一目了然。
- **急停** —— 按配置的急停键（默认 `F2` / `Ctrl+Shift+K`，可在设置中修改）或点击状态条立即接管：正在执行的工具调用被中止、面板发起的外部进程被终止、待确认操作被拒绝、排队消息被清空。挂起状态重启后仍保留——发消息或点「恢复」即可继续。
- **页面标注** —— 按 `Ctrl+Shift+A`（或工具栏 ✎ 按钮，或调用 `annotation_mode`），在页面上画框 / 圆圈 / 箭头 / 点选并附上问题；标注会被编译成结构化文本（DOM 大纲 + 可见文本 + selector + 几何信息）发送给 AI——带投递回执，过期标注会被拒绝。
- **内置模型（可选）** —— 接入任意 OpenAI 兼容 API（DeepSeek、Kimi、Qwen、GLM、Ollama……），让浏览器自己动手；模型配置支持从 opencode 一键导入。
- **对话历史与会话恢复** —— 内置模型的会话保存在本地，可随时重新打开；浏览器标签与活动页面在重启后自动恢复。

## 功能导览

### 1. 起始页

![暗色起始页](docs/screenshots/start-page-dark.png)

起始页展示时钟、日期与搜索框，壁纸跟随当前主题自动切换（亮色壁纸与暗色壁纸随系统明暗实时更换）。

### 2. 内置模型直接操控浏览器

![内置模型工作中](docs/screenshots/agent-mode.png)

在侧边面板用中文或英文给内置模型下指令。它会调用工具（`navigate`、`snapshot`……），每次调用以卡片展示，并在面板中汇报结果——页面同步发生变化。

### 3. opencode 会话镜像

![opencode 会话镜像](docs/screenshots/mirror-panel.png)

当 AI 通过 opencode 工作时，它的消息与工具调用被镜像到面板，同时操控同一个可见的浏览器。面板顶部 "opencode / 内置模型" 两个标签页在两种工作方式间切换。

### 4. 会话选择

![会话选择](docs/screenshots/session-picker.png)

选择面板连接的 opencode 会话。"自动"跟随最近的对话。

### 5. 模型服务管理

![模型服务管理](docs/screenshots/providers-panel.png)

管理内置模型的 OpenAI 兼容服务商：新增、编辑、删除，或直接从 opencode 配置导入。通过 Ollama（`http://localhost:11434/v1`）使用本地模型开箱即用。

### 6. 对话历史

![对话历史](docs/screenshots/agent-history.png)

内置模型的对话保存在本地，可随时重新打开。

### 7. AI 操作可视化与急停

![AI 操作可视化](docs/screenshots/ai-action-visualization.png)

AI 的每一步操作都画在页面上：光标圆环、目标元素高亮、底部状态条。任何时候按急停键（默认 `F2`）即可拿回浏览器——AI 立即停止并等待你的指示。

### 8. 页面标注

![页面标注](docs/screenshots/annotation-tools.png)

在页面任意区域画框（或圆圈 / 箭头 / 点选）并提问。标注会被转换成结构化的文本简报：区域的 DOM 大纲、可见文本、selector 与几何信息——即使纯文本的 AI 也能"看懂"你指的是什么。

## 快速开始

### 安装包（Windows / macOS / Linux）

1. 从 [Releases](../../releases) 下载最新安装包：Windows 为 `Duplex Setup x.y.z.exe`，macOS 为 `.dmg`（Apple Silicon / Intel），Linux 为 `.AppImage`。
2. 运行安装并启动 Duplex。

> 不想装？每个 Release 也附带免安装 **压缩包**（解压任意目录，双击 `Duplex.exe` 即用）。

### 从源码构建

```bash
npm install
npm run build          # Electron 应用 -> out/
npm run build:bridge   # stdio MCP 桥 -> dist-bridge/index.cjs
```

> 如果 Electron 二进制下载失败（例如镜像缓慢），可用：
> `$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"; node node_modules/electron/install.js`

运行：

```bash
npm run dev    # 开发模式（HMR）
# 或
npm start      # 预览生产构建
```

> 想和已安装版并行跑开发版？把 `DUPLEX_DATA_DIR` 指到另一个目录，两者就不共享配置与本地端点。

### 接入 opencode（推荐）

1. 安装镜像插件：把 `integrations/opencode/plugins/cobrowse-mirror.ts` 复制到全局插件目录（`~/.config/opencode/plugins/`），或项目的 `.opencode/plugins/`。
2. 在 opencode 配置（`opencode.json`，项目级或全局）中注册 MCP 服务，参考 [`opencode.example.json`](opencode.example.json)：

```json
{
  "mcp": {
    "duplex": {
      "type": "local",
      "command": ["node", "C:\\path\\to\\Duplex\\dist-bridge\\index.cjs"],
      "enabled": true
    }
  }
}
```

3. 在 opencode 里让 AI 浏览：*"打开 example.com 介绍下这个页面"*。浏览器会在第一次工具调用时自动启动（无需手动打开）。
4. 在 Duplex 侧边面板选择 **opencode** 标签，选择要跟随的会话（或保持"自动"）。

### 使用内置模型（不依赖 opencode）

面板 → **内置模型** → **模型配置** → 添加 OpenAI 兼容服务商（base URL、API Key、模型名），或点击 **从 opencode 导入** 复用已有配置。本地模型把 base URL 指向 Ollama 即可，如 `http://localhost:11434/v1`。

## MCP 工具

| 工具 | 说明 |
|---|---|
| `list_tabs` / `new_tab` / `close_tab` / `switch_tab` | 标签管理——人与 AI 共用同一批标签 |
| `navigate` / `search` / `history` | 打开网址（非 URL 自动转为搜索）、搜索（默认百度，可选 Bing / Google）、后退 / 前进 / 刷新 |
| `snapshot` | **页面文本化**——紧凑 DOM 大纲，可交互元素带 `[eN]` ref |
| `get_html` / `query` | 原始 HTML，或按 CSS 选择器获取元素详情 |
| `screenshot` | 可视区域 PNG 截图（供多模态模型） |
| `click` / `dblclick` / `hover` | 走 Playwright 的单击 / 双击 / 悬停；`target` 支持 `eN` ref 或 CSS 选择器，操作会等待元素可交互 |
| `type` / `press` | 输入文本（可附带回车提交）与按键，支持 `Control+A` 等组合键 |
| `drag` | 从一点 / 元素到另一点的真实拖拽 |
| `select_option` / `upload` | 原生 `<select>` 选项操作与按绝对路径上传文件 |
| `scroll` | 滚动页面或将指定元素滚入视口 |
| `wait` | 等待时间 / 选择器 / 文本——可取消；你正在交互时会带原因让位 |
| `get_console` | 读取页面控制台日志（错误与警告） |
| `annotation_mode` | 进入 / 退出标注模式（人在页面上画框 / 圈 / 箭头 / 点选并提问） |
| `evaluate` | 在页面中执行 JS，返回可 JSON 序列化的结果 |

## 工作原理

![架构图](docs/screenshots/architecture.jpg)

- Electron 主进程在 `127.0.0.1` 上提供一个本地 HTTP API，使用每次启动生成的 bearer token 鉴权（端点信息写入 `~/.cobrowse/endpoint.json`）。
- `dist-bridge/index.cjs` 是一个 stdio MCP 服务，把工具调用代理到该 API，并在应用未运行时自动拉起。
- 页面自动化是**跑在浏览器自己 Chromium 上的 Playwright**：应用读取 `DevToolsActivePort`、按 `targetId` 对应到每个标签，驱动 locator、iframe、开放 shadow DOM、可取消等待与脚本执行——操作的就是你眼前这个页面，而不是另一个自动化实例。
- **协作层**把每个任务绑定到它的标签、对同页写操作串行化、监听真实的人工输入（滚轮 / 触摸 / 键盘 / 焦点）并逐页暂停 AI 修改；状态条反映这些状态，并提供逐页一键交还。
- opencode 插件把会话事件（文本、思考、工具调用）推入面板，并长轮询取走排队消息；投递单次领取（60 秒租期、自动续租、ACK 确认），且面向**绑定的会话**而不是"当前活动会话"。
- 面板消息与页面标注都带身份注入：标注会记录来源标签、URL 与文档标识，过期即拒绝——不会串进错误的会话。
- Codex 与 Claude Code 的对话从本地会话记录实时尾随镜像；面板发送的消息以无头模式续接同一会话（`codex exec resume` / `claude --resume`）注入，新回合经同一尾随通道流回面板。启动对象按结构化会话 ID 匹配，而不是"最近被修改的文件"。
- 浏览器状态（标签顺序、HTTP(S) URL、活动页）在退出时保存、下次启动时恢复。
- 外部脚本也可注入消息：`POST /api/chat { "text": "..." }`。

## 已知限制

- 你与页面交互期间，AI 在该页面的输入是合成 DOM 事件（`isTrusted=false`）；依赖真实键鼠、`contenteditable` 或自定义控件的站点需要人工协调，且已经发生的副作用无法撤销。
- 取消粒度：在途 Playwright 调用以 200–250 ms 轮询为界——已经完成的点击 / 提交 / 写入不能回滚。
- `evaluate` 会清理其作用域内的计时器 / RAF / fetch，但无法撤销通过 `document.defaultView` 等途径注册的外部回调；该高级能力的使用范围还在进一步收紧。
- 元素 ref 与快照绑定：导航或 DOM 大改后请重新 `snapshot`（过期 ref 会明确报错，而不是点错元素）。
- 直接使用 MCP 的客户端共享一个默认调用方身份；明确的任务开始 / 结束 / 交接协议计划在 0.3.0 提供。
- opencode 的消息去重依赖插件；若其断网超过租期，已接受但未确认的消息可能重复投递——精确去重需要上游提供消息 ID。
- 缺少结构化启动身份的自定义 CLI，只在出现唯一新记录文件时被接受；同时有多个候选会直接拒绝，而不是乱猜。
- 内置多模态图片上下文、站点特殊控件与跨平台交互验收尚未完全覆盖。
- 内置模型是便捷选项：本地 / 小模型在长工具链任务上的可靠性明显低于完整的 opencode 方案。
- 通过操作系统打开网页的 CLI 工具（Claude Code、Codex 等）跟随**系统默认浏览器**。想让它们落在 Duplex，只需在系统设置里把 Duplex 选为默认一次即可——`⋯ → 设为默认浏览器…` 会帮你打开那个设置页（绝不强迫）。由 Duplex 启动的 CLI / 命令还会带上 `BROWSER=duplex-open` 垫片，可覆盖尊重该环境变量的工具。

## 路线图

- **v0.3.0 —— 协作继续深化**：
  - 为 MCP 调用方提供明确的任务生命周期 / 交接协议（开始、结束、恢复），并把动作拆成粒度更细的可取消步骤。
  - `contenteditable` 与自定义控件的回退方案；更完整的 CLI 会话生命周期；多模态验收。
  - 社区 backlog：命令面板、标签搜索、阅读模式、书签 HTML 导入 / 导出等（维护中的清单见 `docs/待办与用户反馈.md`）。

## 开发

```bash
npm run dev        # 开发模式（electron-vite，渲染层 HMR）
npm run typecheck  # TypeScript 检查（node + web）
npm test           # 单元测试（vitest，300+ 用例）
npm run smoke      # 端到端冒烟测试（拉起桥接与真实浏览器）
npm run dist       # 构建 Windows 安装包（electron-builder）
```

自包含冒烟（隐藏 Electron + 独立临时数据目录，不碰你自己的会话）：

```bash
node tests/playwright-connection-smoke.mjs   # Playwright 层对隐藏 fixture 浏览器的全项检查
node tests/private-029-smoke.mjs             # 11 个主进程协作场景
```

调试工具：

- `GET /api/debug/ui-snapshot` —— 截取当前窗口到 `~/.cobrowse/ui-snapshot.png`。
- `POST /api/debug/panel-eval` —— 在面板渲染进程执行 JS（仅当应用以 `COBROWSE_DEBUG_UI=1` 启动时可用）。
- `POST /api/debug/ui-action` —— 驱动面板动作（测试用，如 `{"action":"panel-mode:opencode"}`）。
- 日志：`~/.cobrowse/app.log`（主进程 + 渲染进程日志）。

## 来自作者的一点话

我不是专业程序员，只是一个对 AI 好奇的普通计算机小白。Duplex 是我在业余时间一点一点做出来的爱好项目——边学边做（也借了不少 AI 编程工具的力）。

所以它还很粗糙：一定有我没发现的 bug、会让人不爽的设计、以及我自己没意识到的坑。如果你愿意试用，任何反馈对我都极其珍贵——不管是 bug、崩溃、让人摸不着头脑的步骤，还是一句"它在我这儿没跑起来"。欢迎开 [Issue](https://github.com/Eric-huang799/duplex/issues) 告诉我，中文英文都可以。

谢谢你看完这里，也谢谢你愿意试它。

## 许可证

[MIT](LICENSE)
