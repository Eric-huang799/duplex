# Duplex 项目记忆（CoBrowse）

## 当前版本
- **0.2.6**（本地开发中，未推送 GitHub；基线 v0.2.5 = commit 3341679）
- 源码根：`C:\Users\lenovo\Desktop\CoBrowse-0.2.5`
- 发布资产（v0.2.5）见 Obsidian：`长期记忆/duplex-v0.2.5-资产交接.md`

## 0.2.6 关键变更（2026-10-07）
- 标注：`Ctrl+Shift+A` 进入/退出；提交双通道（内置模型走 AgentRuntime，opencode 走注入队列）；提交后 overlay 回执（成功/失败）；marker 文档坐标跟随滚动；退出清空；未提交标注保留可重开。
- 面板：默认「内置模型」，无 provider 首启自动弹配置；opencode 改为显式选择；`Ctrl+B` 开关面板；发送失败保留草稿。
- 急停：默认键改为 `F2` + `Ctrl+Shift+K`（Esc 不再接管，留给网页）；状态持久化；导航不再静默恢复 AI，仅发消息/点「恢复」恢复。
- 安全：导入凭据仅允许官方域名（自定义网关需勾选「我信任此网关」）；write_file/脚本确认弹窗显示内容预览；settings/会话存储原子写 + .bak；`/api/debug/*` 仅开发构建可用（`app.isPackaged` 门控，旧「打包前 stash」流程作废）。
- 浏览器基本功：Alt+←/→、Ctrl+±/0、Ctrl+1..9、标签溢出滚动/中键关闭/双击新建、Markdown 链接新开标签、AI 回复内链接不再覆盖当前页。
- 外部 agent：spawn 失败透传 stderr 摘要、启动超时杀进程、会话同步断开提示、Windows 命令转义、transcripts 大文件保护与缓存。

## 开发/验证命令
- `npm run typecheck`（tsc node+web）
- `npx vitest run`（205 用例）
- `npm run build` + `npm run build:bridge`
- `npm run smoke`（端到端，会真实启动浏览器窗口；用户在工作时勿跑）
- 打包：`npm run dist`（产物在 `release/`，gitignore）

## 注意事项
- 调试注入 API（http-server.ts/index.ts）曾为未提交调试文件，0.2.6 起已提交并加 `isPackaged` 门控：开发可用、打包版不可达。
- 待办（延后）：token/费用统计 UI、响应式适配、触屏标注、「下载前询问」开关 UI（当前默认询问，可在 settings.json 手动关：`confirmBeforeDownload: false`）。
