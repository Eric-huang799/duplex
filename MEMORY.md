# Duplex 项目记忆（CoBrowse）

## 当前版本
- **0.2.6**（已推送 GitHub：`master` + 分支 `codex/v0.2.6` + tag `v0.2.6`；**CI 全绿，Release 已发布并设为 Latest**：https://github.com/Eric-huang799/duplex/releases/tag/v0.2.6）
- **覆盖版（2026-10-09，commit `9746392`）**：tag 已重指到该提交并覆盖发布（修复标注失步致命 bug + external 标注投递 + FB-001）；本机安装版已同步覆盖升级。CI 已加"上传后强制发布"步骤（`40cad45`），避免重打标签后 Release 变草稿。全部历史 Release 已公开（v0.2.5 草稿亦已发布；v0.2.6 为 Latest）。
- 基线 v0.2.5 = commit 3341679；README 中英双版已更新到 0.2.6 行为（急停键语义、收录强调、作者邀请测试段落）
- 首次 tag CI 曾因 macOS 腿的 3 条"未固定平台"测试失败；修复（显式平台参数）后重指标签重跑 → 三平台全绿、Release 自动生成
- 源码根：`C:\Users\lenovo\Desktop\CoBrowse-0.2.5`
- 发布资产（v0.2.5）见 Obsidian：`长期记忆/duplex-v0.2.5-资产交接.md`

## 0.2.6 关键变更（2026-10-07）
轮次 1（commit `143a418`）：
- 标注：`Ctrl+Shift+A` 进入/退出；提交双通道（内置模型走 AgentRuntime，opencode 走注入队列）；提交后 overlay 回执（成功/失败）；marker 文档坐标跟随滚动；退出清空；未提交标注保留可重开。
- 面板：默认「内置模型」，无 provider 首启自动弹配置；opencode 改为显式选择；`Ctrl+B` 开关面板；发送失败保留草稿。
- 急停：默认键改为 `F2` + `Ctrl+Shift+K`（Esc 不再接管，留给网页）；状态持久化；导航不再静默恢复 AI，仅发消息/点「恢复」恢复。
- 安全：导入凭据仅允许官方域名（自定义网关需勾选「我信任此网关」）；write_file/脚本确认弹窗显示内容预览；settings/会话存储原子写 + .bak；`/api/debug/*` 仅开发构建可用（`app.isPackaged` 门控，旧「打包前 stash」流程作废）。
- 浏览器基本功：Alt+←/→、Ctrl+±/0、Ctrl+1..9、标签溢出滚动/中键关闭/双击新建、Markdown 链接新开标签、AI 回复内链接不再覆盖当前页。
- 外部 agent：spawn 失败透传 stderr 摘要、启动超时杀进程、会话同步断开提示、Windows 命令转义、transcripts 大文件保护与缓存。

轮次 2（commit `61f1a79`，三视角体验审计后修复）：
- 原生菜单（标签右键/搜索引擎/工具菜单），打开菜单不再隐藏网页；查找条进文档流（页面可见+计数+上/下+停止加载）。
- 零标签死路修复（地址栏/搜索自动建标签）；下载完成/中断 toast；打开/定位失败提示；toast 堆叠。
- 中文输入法 Enter 误发修复（面板+标注卡）；急停单键在网页编辑器不触发、组合键始终有效、toast 带计数。
- 标注诚实回执（外部模式拒绝/opencode 排队 warning/无提问说明）；草稿按模式持久化；自定义工具支持工作目录；DeepSeek/OpenAI/Ollama 预置。
- Mac 平台感知快捷键显示与校验；冲突表补全；地址栏焦点下缩放/数字切换/Alt 导航可用。

轮次 3（commit `9cf4a6d`，实机调试）：`/api/emergency/resume` 显式恢复；CSP 允许 http 图；smoke/visual-check 适配 0.2.6 语义；inject-latency 改 opt-in。

轮次 4（快捷键自定义 + 书签完整 + 借鉴功能包，见 Obsidian 记录最新一节）：
- 快捷键全部可自定义：16 动作、`⋯`→快捷键设置、录制/恢复/冲突校验、地址栏+网页双层生效；`Ctrl+1..9` 保留。
- 书签面板完整：文件夹增删改、书签增改删、新标签打开（Ctrl/中键）、复制链接、排序、搜索。
- 借鉴功能（Chrome/Zen/Floorp/Vimium 调研）：页面右键原生菜单、标签静音、最近关闭列表、复制为 Markdown、所有标签存书签。
- 调试基建：`POST /api/debug/ui-action`（仅开发）驱动渲染层动作，供 UI 自动化/测试确定性。

## 开发/验证命令
- `npm run typecheck`（tsc node+web）
- `npx vitest run`（240 用例）
- `npm run build` + `npm run build:bridge`
- `npm run smoke`（端到端 34 项，会真实启动浏览器窗口；用户在工作时勿跑）
- 打包：`npm run dist`（产物在 `release/`，gitignore）
- 调试模式：`COBROWSE_DEBUG_UI=1` 启动后可用 `/api/debug/ui-action`、`/api/debug/exec`（exec 用表达式形式，顶层 return 不允许）

## 注意事项
- **0.2.6 覆盖版修复（2026-10-09）**：
  ① 标注致命 bug：页面导航/刷新后 overlay 重置但主进程每标签状态未同步 → 首击 ✎ 无反应、画框静默失效；修复：overlay `ready` 时主进程重置该标签标注状态并推送给渲染层。
  ② external 模式（Claude Code 等）标注改为投递到当前打开的会话（复用面板续聊通道）；无可用会话时给出明确指引。
  ③ **FB-001 落地**：候选浏览器注册（Windows HKCU，仅打包版、绝不改默认）+ `duplex-open` shim 与 `BROWSER` 注入（面板 CLI / run_command / 脚本）+ 启动参数/second-instance/open-url URL 接收 + `POST /api/open` + 菜单「设为默认浏览器…」。
- 调试注入 API（http-server.ts/index.ts）曾为未提交调试文件，0.2.6 起已提交并加 `isPackaged` 门控：开发可用、打包版不可达。
- **待办管理**：用户反馈与延后项统一登记在 `docs/待办与用户反馈.md`（FB-001 起），**积累到 0.3.0 统一实施**（紧急/阻塞项除外）。
- **测试对象候选（2026-10-09 记）**：后续端到端测试可加 `info.cern.ch`（世界上第一个网站，CERN 托管，极简纯文本、长期稳定）作为第二测试页——example.com 曾因页面改版导致 smoke 断言失效。已在待办登记，**下次迭代纳入 smoke**。
- **社区收录（2026-10-08）**：Duplex 已被 punkpeye/awesome-mcp-servers 正式收录（PR #15385 已 merge，GitHub API 实查）；freemcp.space 自动列出（未验证，claim/opt-out 可选）；README 中英双版已加两枚收录徽章并推送 GitHub master（commit `3d311e3`）。注：本机到 github.com 主站间歇性超时，push 可用 `git -c http.curloptResolve=github.com:443:<IP> -c http.version=HTTP/1.1`（**IP 会变**，先 curl 探测；常用候选 20.27.177.113 / 20.205.243.166 / 140.82.113.4 / 140.82.112.3）。
- 待办（延后）：命令面板/标签搜索/会话恢复/阅读模式/标签固定/多选批量/书签 HTML 导入导出、token/费用统计 UI、响应式适配、触屏标注。
- 本机已安装 0.2.5 与开发版可并存：开发版需 `--user-data-dir` 独立目录避开单例锁；**本机安装版已于 2026-10-07 覆盖升级到 0.2.6**。
