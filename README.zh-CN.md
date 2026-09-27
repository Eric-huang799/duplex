# Duplex

**一个人与 AI 共用的浏览器** —— 人看渲染后的页面，AI 读 DOM 与源码；同一个标签、同一个实时会话，同时进行。

[English](README.md) | **中文**

![Duplex 起始页（暗色）](docs/screenshots/start-page-dark.png)

*Duplex 起始页（暗色主题），另附[亮色主题](docs/screenshots/start-page-light.png)。*

## 演示

### 第一幕：让 Duplex 在 B 站搜索并播放论文解读视频

[![点击播放演示视频](docs/screenshots/demo-video-cover.jpg)](docs/videos/act1-bilibili-demo.mp4)

*内置模型自主完成：切换模型 → 输入指令 → B 站搜索 → 挑选并播放视频。当前为无声先导版，配音版制作中。*

![用 Duplex 操控网页版 Excel](docs/screenshots/excel-web-demo.png)

*操控微软网页版 Excel——未安装任何表格编辑专用 skill，仅靠原厂 API 与少量简单自动化 skill 完成* 😅

> **这是可行性演示，不是推荐用法。** 由于没有专用 skill 可用，Duplex 只用原厂 API 和少量简单自动化 skill，临时摸索出剪贴板读写通道、DOM 探测等办法，把一整张成绩表写进了网页版 Excel。效果是有的，但过程非常费时、消耗了大量 token。😅

## 特性一览

- **一个真正的浏览器** —— 多标签、地址栏（支持百度 / Bing / Google 搜索）、前进 / 后退 / 刷新、加载状态、主题（亮色 / 暗色 / 跟随系统）、带时钟与搜索的壁纸起始页。
- **24 个 MCP 工具** —— `snapshot` 把任意页面压缩成紧凑的 DOM 大纲（可交互元素带 `[eN]` ref）；其余工具覆盖标签管理、导航、点击、输入、拖拽、文件上传、滚动、等待、控制台日志、JS 求值与页面标注。
- **零配置桥接** —— stdio MCP 桥 `mcp-bridge` 在第一次工具调用时自动拉起浏览器，免手动启动。适用于 opencode、Claude Code 及任意 MCP 客户端。
- **会话实时镜像** —— AI 通过 opencode 工作时，它的回复、思考与工具调用卡片实时流入侧边面板；在面板里发言可把消息注入同一个会话。
- **AI 操作可视化** —— 半透明光标、目标元素高亮与底部状态条（"AI 正在点击「…」· Esc 接管"）绘制在 Shadow-DOM 覆盖层中，AI 在页面上做什么一目了然。
- **Esc 接管** —— 随时按 `Esc`（或点击状态条）立即接管：正在执行的工具调用被中止、挂起等待提前返回，AI 会收到"用户已接管"的提示。
- **页面标注** —— 按 `?` 或调用 `annotation_mode`，在页面上画框 / 圆圈 / 箭头 / 点选并附上问题；标注会被编译成结构化文本（DOM 大纲 + 可见文本 + selector + 几何信息）发送给 AI。
- **内置模型（可选）** —— 接入任意 OpenAI 兼容 API（DeepSeek、Kimi、Qwen、GLM、Ollama……），让浏览器自己动手；模型配置支持从 opencode 一键导入。
- **对话历史** —— 内置模型的会话保存在本地，可随时从历史菜单重新打开。

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

### 7. AI 操作可视化与 Esc 接管

![AI 操作可视化](docs/screenshots/ai-action-visualization.png)

AI 的每一步操作都画在页面上：光标圆环、目标元素高亮、底部状态条。任何时候按 `Esc` 即可拿回浏览器——AI 立即停止并等待你的指示。

### 8. 页面标注

![页面标注](docs/screenshots/annotation-tools.png)

在页面任意区域画框（或圆圈 / 箭头 / 点选）并提问。标注会被转换成结构化的文本简报：区域的 DOM 大纲、可见文本、selector 与几何信息——即使纯文本的 AI 也能"看懂"你指的是什么。

## 快速开始

### 安装包（Windows）

1. 从 [Releases](../../releases) 下载 `Duplex Setup 0.1.0.exe`。
2. 运行安装并启动 Duplex。

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
| `click` / `dblclick` / `hover` | 单击 / 双击 / 悬停；`target` 支持 `eN` ref 或 CSS 选择器 |
| `type` / `press` | 输入文本（可附带回车提交）与按键，支持 `Control+A` 等组合键 |
| `drag` | 从一点 / 元素到另一点的真实拖拽 |
| `select_option` / `upload` | 原生 `<select>` 选项操作与按绝对路径上传文件 |
| `scroll` | 滚动页面或将指定元素滚入视口 |
| `wait` | 等待时间 / 选择器 / 文本——可被 Esc 打断 |
| `get_console` | 读取页面控制台日志（错误与警告） |
| `annotation_mode` | 进入 / 退出标注模式（人在页面上画框 / 圈 / 箭头 / 点选并提问） |
| `evaluate` | 在页面中执行 JS，返回可 JSON 序列化的结果 |

## 工作原理

![架构图](docs/screenshots/architecture.jpg)

- Electron 主进程在 `127.0.0.1` 上提供一个本地 HTTP API，使用每次启动生成的 bearer token 鉴权（端点信息写入 `~/.cobrowse/endpoint.json`）。
- `dist-bridge/index.cjs` 是一个 stdio MCP 服务，把工具调用代理到该 API，并在应用未运行时自动拉起。
- opencode 插件把会话事件（文本、思考、工具调用）推入面板，并以长轮询收取浏览器中排队的消息（注入延迟约 10 ms）。
- 面板消息与页面标注通过 `session.promptAsync` 注入当前活跃的 opencode 会话。
- 外部脚本也可注入消息：`POST /api/chat { "text": "..." }`。

## 已知限制

- iframe 与 shadow DOM 内部的页面元素不在 `snapshot` / `click` 覆盖范围内——shadow DOM 只做检测，不进入。
- `eN` ref 在页面导航后失效；页面变化后需重新 `snapshot`。
- 消息注入面向"当前活跃会话"，同时存在多个 opencode 会话时目标可能不确定。
- 镜像存储在内存中保存近期事件流，浏览器重启后清空。
- 内置模型是便捷选项：本地 / 小模型在长工具链任务上的可靠性明显低于完整的 opencode 方案。

## 路线图

- **Codex / Claude Code 兼容（下一阶段）** —— 为更多 AI 客户端提供一等集成：
  - MCP 桥本身是客户端无关的（标准 stdio MCP），工具层在设计上并不绑定 opencode。
  - 计划：为 **Codex**、**Claude Code** 等客户端提供官方适配与会话镜像，让它们的对话也能像 opencode 一样显示在侧边面板中。

## 开发

```bash
npm run dev        # 开发模式（electron-vite，渲染层 HMR）
npm run typecheck  # TypeScript 检查（node + web）
npm test           # 单元测试（vitest）
npm run smoke      # 端到端冒烟测试（拉起桥接与真实浏览器）
npm run dist       # 构建 Windows 安装包（electron-builder）
```

调试工具：

- `GET /api/debug/ui-snapshot` —— 截取当前窗口到 `~/.cobrowse/ui-snapshot.png`。
- `POST /api/debug/panel-eval` —— 在面板渲染进程执行 JS（仅当应用以 `COBROWSE_DEBUG_UI=1` 启动时可用）。
- 日志：`~/.cobrowse/app.log`（主进程 + 渲染进程日志）。

## 许可证

[MIT](LICENSE)
