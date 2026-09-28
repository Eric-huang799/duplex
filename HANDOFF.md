# HANDOFF — Duplex 交接说明（v0.2.0）

> 给接手的新对话 / 协作者的快速上手指南。

## 项目是什么

Duplex：**人与 AI 共用的浏览器**（Electron + React + TypeScript）。
人看渲染后的页面，AI 通过 24 个 MCP 工具读 DOM/源码并操作**同一个标签、同一个实时会话**。

## 当前状态

- 版本：**v0.2.0**
- 测试：**116 通过 / 1 跳过**（跳过的 live 测试需 `LLM_LIVE=1` 且读本机配置）
- 构建：`npm run build`（应用）/ `npm run build:bridge`（MCP 桥）/ `npm run dist`（Windows 安装包）
- 主要开发/验证平台：Windows

## 架构地图（src/）

| 路径 | 职责 |
|---|---|
| `main/index.ts` | 应用入口：窗口、IPC、内置 agent 装配、外部工具会话管理、急停 |
| `main/tabs.ts` | WebContentsView 标签管理（含**渲染看门狗**，窗口遮挡恢复后自动唤醒）|
| `main/tool-handlers.ts` | 24 个浏览器工具的 CDP 实现 |
| `main/http-server.ts` | 本地 HTTP：`/mcp`、`/api/agent/*`、`/api/session/*`、`/api/mirror`、调试端点 |
| `main/agent/runtime.ts` | 内置 agent 循环：会话、工具调用、**忙碌排队**、空响应提示、15 分钟看门狗 |
| `main/agent/llm/` | 4 个协议适配器（openai-chat / anthropic / openai-responses / gemini）+ SSE + 容错解析 |
| `main/agent/skills.ts` + `skill-tools.ts` | Skill 扫描/导入/启停 + `read_skill` 等工具（脚本执行前弹窗确认）|
| `main/agent/fs-tools.ts` | `write_file` / `run_command`（弹窗确认、realpath 防护、进程树超时终止）|
| `main/agent/auth-import.ts` | 从 Codex / opencode 登录凭据导入密钥（只读，不写回）|
| `main/agent/providers.ts` + `settings.ts` | providers（含 protocol/authType）+ `~/.cobrowse/settings.json` |
| `main/integrations/agents.ts` | 外部 CLI 注册表 + 检测 + `buildStartPlan`（无头启动计划）|
| `main/integrations/transcripts.ts` | Codex / Claude / Gemini 系 / 通用 JSONL-JSON 会话解析 |
| `main/integrations/setup.ts` | Codex MCP 配置写入（备份+校验）|
| `mcp-bridge/` | stdio MCP 桥（对外客户端接入，internal 工具已过滤）|
| `renderer/` | 面板：模式栏（内置/外部工具）、会话菜单（顶部"＋新建对话"）、Skills 面板、确认弹窗、急停 toast |
| `shared/` | `tools.ts`（工具定义 + `internal` 标记）、`llm.ts`（协议常量）、`protocol.ts`、`search.ts` |
| `integrations/opencode/` | opencode 镜像插件（用户侧安装，双向）|

## 关键机制备忘

- **镜像隔离**：外部工具模式下静音 opencode 事件（`mirrorSource`）；切回时补发 `session-info` 重置面板流
- **确认机制**：写文件 / 跑命令 / 自定义工具启动 → renderer 弹窗（`App.tsx`）；主进程 120 秒超时自动拒绝
- **急停**：`Esc`/`F2` → `agentAbort` + `agentsStop`（杀进程树）+ overlay 接管；键位存 settings、工具栏 ⌨ 可改
- **内置 agent 排队**：忙碌时新消息入队并显示"已排队"，当前任务完成后自动执行
- **外部工具启动**：`buildStartPlan` 生成无头命令（stdin 传 prompt；custom 支持 `{prompt}` 占位）；custom 必须过确认弹窗
- **渲染看门狗**：窗口 `show/restore/focus` + 每 30 秒检测活动页面 `visibilityState`，hidden 时自动重挂载视图

## 已知限制（如实）

- 外部工具镜像为**只读**（回复需在对应 CLI 中进行；opencode 例外——双向）
- ChatGPT 订阅（Codex 凭据）的 `responses` 端点**未做端到端实测**
- opencode 会话无法从面板删除（请在 opencode 侧清理）
- 外部工具历史不入 MirrorStore（面板刷新后需重开会话）
- 协议适配器对异常历史（空消息 / 连续 user 角色）无本地兜底（错误透传给模型）
- 自定义工具暂无编辑入口（删除后重建）

## 敏感边界（务必遵守）

- 用户数据全在 `~/.cobrowse/`（`settings.json`、`agent-sessions.json`、`agents.json`、日志）——**绝不提交**
- 测试使用假密钥；live 测试读本机配置但不落仓库（仅 `LLM_LIVE=1` 时运行）
- **切勿**在代码/测试/文档中硬编码个人路径、账号或凭据

## 常用命令

```bash
npm install
npm run build && npm run build:bridge   # 构建应用 + MCP 桥
npm run test                            # 单元测试
npm run dev                             # 开发模式（HMR）
npm run dist                            # 打 Windows 安装包（输出到 release/）
```

## 近期质检结论（v0.2）

4 个独立视角（安全 / 集成一致性 / 健壮性 / 测试缺口）交叉审查，已修复：
skill 导入跟随 junction、custom 命令无执行确认、`write_file` 链接绕过、`theme:get` 泄露明文 Key、
stdin 管道崩溃、子进程树未终止、tail 截断停滞、镜像切换错位、SSE 无上限、渲染冻结等；
测试从 101 增至 116。
