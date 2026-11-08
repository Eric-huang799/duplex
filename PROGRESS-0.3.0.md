# Duplex 0.3.0 原型机 · 进度日志

> 定位：**0.3 系列的原型机**。从 `fix/robustness-0.2.11`（`5a08c8f`）继续，尚未合并、尚未推送、**尚未重新打包**。
> 目的：先在本地把"审计结论 + 站点权限白名单 + 减重"固化成一个可回溯的基线，实机验收通过后再推远端。
> 相关文档：`AUDIT-2026-11-07.md`（全量审计与滚动修复状态）、`docs/design-site-permissions.md`（权限设计）。

---

## 一、版本与产物状态

| 项 | 值 |
| --- | --- |
| 版本 | **0.3.0**，五处已对齐：`package.json`、`package-lock.json`（根与 `packages[""]`）、`src/mcp-bridge/index.ts` 的 `VERSION`、`npm/duplex-bridge/package.json`、`npm/duplex-bridge/server.json`（2 处） |
| 分支 | `fix/robustness-0.2.11`（未改名、未推送；远端 `master` 仍是 `a5015f5` / 0.2.10） |
| 安装版 | **仍是 0.2.11 的旧构建**（`resources/app.asar` 未替换）。本机运行中的实例报告的也是 0.2.11——版本号要到下次打包才生效 |
| 发布产物 | `release\Duplex-0.2.11-win64*` 仍是旧产物；本轮**没有**重新 build / 打包（按要求） |

---

## 二、本轮做了什么

### 1. 站点权限白名单（新功能，按产品原则设计）

产品原则：**AI 在安全范围内可以做一切有益于用户的事情。** 落地判据只有一条——**出错能不能撤回**。

| 档 | 类别 | AI 可否自行放宽 |
| --- | --- | --- |
| `silent` | 全屏、DRM、站点存储/SSO、唤醒锁、打印、指针、剪贴板写 | 可以，不打扰用户 |
| `sensitive` | 通知、定位、剪贴板读、传感器、唤起外部应用、兜底 | 可以，记录 `source: agent` 并标黄、可一键撤销 |
| `high-risk` | 摄像头/麦克风、屏幕共享、本地文件、USB/串行/HID/NFC/VR、内网探测 | **必须人工确认**（复用 `PermissionCard` 审批流） |

新增文件：

- `src/shared/permissions.ts` — 18 个类别、三档、默认值、origin 规范化、决策引擎（纯函数，无依赖）
- `src/main/permission-policy.ts` — **46 项 Electron 权限全量映射**。类型取自 `Session['setPermissionRequestHandler']` 签名，Electron 将来新增权限会**编译失败**而不是静默落到默认
- `src/main/permission-store.ts` — 独立 `permissions.json`：原子写 + `.bak` + 500 条上限 LRU + 稀疏存储 + 「仅本次」内存授权
- `src/main/permission-runtime.ts` — Session 处理器、去重、拒绝熔断、30s 超时、fail-closed
- `src/main/agent/permission-tools.ts` — `list_site_permissions` / `set_site_permission` / `remove_site_permission`（`internal`，外部 MCP 客户端不可见，故 `tools/list` 仍为 25 个）
- `src/renderer/src/components/PermissionBar.tsx` + `permission-bar.css` — 浏览器 chrome 内的提示条
- 接线：`index.ts`（替换原"一刀切拒绝"）、`tabs.ts`（隐身分区也挂策略、规则不落盘）、`preload/index.ts` + `env.d.ts`、`i18n-text.json`（+24 条中英文）

安全要点：提示条只显示**主进程**从 `details.requestingUrl` 算出的 origin；渲染层回传只带答案。`permission:ui-ready` 之前主进程不弹窗；运行时未就绪时显式全拒，不依赖 Electron 默认行为。

### 2. 审计修复（P0 / P1）

| 问题 | 修法 |
| --- | --- |
| **P0** `browser-data` 读失败静默返回空库 → 被写回覆盖，书签/历史/下载永久丢失 | 读失败先救 `.bak`；救不到进**只读降级并拒绝写盘**；仅 ENOENT 且无备份算全新安装 |
| P1 隐身标签 URL 落盘、重启后变普通标签 | `browser-session.update()` 过滤 `incognito` |
| P1 `duplex-open` shim `fetch` 后立即 `process.exit` → 请求一个都发不出去 | `await fetch` + 3s 超时后再退出 |
| P1 协作锁 owner 残留（跨 caller 排队后永久 `[LOCKED]`） | 释放不再绑队尾，改深度计数 + 身份校验 |
| P1 `awaitWithAbort` 不 race → 卡死工具永久占住 agent 与标签锁 | 改 `Promise.race`，abort 即抛，`finally` 一定执行 |
| P1 `ToolArgsAbortError` 落盘非法历史 → 会话永久报废 | 该分支补 `patchIncompleteToolCalls()` |
| P1 agent 会话保存失败静默 + 退出不 flush | 记录错误 + 新增 `flushPersistence()` 并在 `will-quit` 调用 |

### 3. 发布前置

`predist:mac` / `predist:linux` 补齐（此前 mac/linux 打包会用旧 `out/`）；`release-build.cmd` 改为先 `build:bridge` → `build` → 打包且失败即中止；`open-shim` 支持 `DUPLEX_DATA_DIR`；npm 子包版本对齐。

### 4. 减重（零视觉、零功能损失）

| 改动 | 效果 |
| --- | --- |
| 流式条目 key 由 `ev.id`（每次快照都变）改为稳定的 `partID`，并给条目加 `memo` | 修掉"AI 打字时工具卡自动收起 / 思考块闪断 / 整段 Markdown 重解析"；长会话流畅度提升 |
| `electronLanguages: ["zh-CN","en-US"]` | 安装包里的 55 个语言包 → 2 个，预期体积 **395.8 MB → 约 350 MB**（推算，未重新打包验证） |

**故意没动**：Win11 亚克力透明（属"前端效果"）、`backgroundThrottling: false`（属"后端功能"，改为按 AI 占用动态开关会改变行为）。这两项需要产品决策。

---

## 三、验证状态

| 项 | 结果 |
| --- | --- |
| `npm run typecheck` | ✅ 通过 |
| `npx vitest run` | ✅ **387 passed / 1 skipped**（31 files + 1 skipped）；基线 343 → 新增 44 项 |
| `npm run build` | ✅ 通过（`out/main` 460 kB、`out/preload` ×2、`out/renderer` 含新 CSS） |
| 构建产物抽查 | ✅ `permissions.json` / `permission:ui-ready` / `set_site_permission` 均在 `out/main/index.js` 里 |

**未验证（本轮明确没做）**：

1. **没有重新打包**：安装版仍是 0.2.11 旧构建，`app.getVersion()` 要下次打包才报 0.3.0。
2. **没有实机点过提示条**：应用一直在运行，我没有重启它。建议实机验收：访客视频站全屏、腾讯会议摄像头、通知、SSO 内嵌登录、隐身标签不落盘。
3. **locale 裁剪后的实际体积**只做了配置，未打包核对。
4. **GPU 疑点未查**：GPU 进程 140 MB / CPU 29.8s 是全app最高，安装目录带 `vk_swiftshader.dll`；若实际走软件渲染，"重"的主因不在代码。需 `chrome://gpu` 或带日志启动确认。

---

## 四、本地验收清单（建议顺序）

1. `npm run typecheck && npx vitest run` —— 应为 387 passed / 1 skipped。
2. `npm run dev` 启动开发构建，确认：提示条能弹出、三个按钮各自生效、设置里没有新增报错。
3. 用 `DUPLEX_DATA_DIR` 指向临时目录跑一次隔离会话，确认 `permissions.json` 写在临时目录里（不再污染真实数据）。
4. 实机站点抽查：视频全屏、会议摄像头、网页通知、内嵌 SSO、隐身标签。
5. 验收通过后再：`npm run dist`（会顺带 build）→ 核对 `locales` 只剩 2 个 → 覆盖安装 → 确认 `/health` 报 0.3.0。
6. 最后才推送/合并（当前**未推送**）。

---

## 五、独立原型构建（未覆盖安装版）

```
npx electron-builder --win --dir --publish never --config.directories.output=release-0.3.0-prototype
→ release-0.3.0-prototype\win-unpacked\Duplex.exe
```

| 项 | 安装版（0.2.11） | 本次原型 | 差 |
| --- | --- | --- | --- |
| 总体积 | 395.8 MB | **348.3 MB** | **−47.5 MB** |
| `locales` | 55 个 / 48.3 MB | **2 个 / 1.12 MB** | −47.2 MB |
| `app.asar` | 27.9 MB | 26.7 MB | −1.2 MB |

`%LOCALAPPDATA%\Programs\Duplex` **未被改动**（asar mtime 仍是 10/30 14:50）。原型可直接运行 `release-0.3.0-prototype\win-unpacked\Duplex.exe`，与已装版本互不影响（但注意：两者共用默认数据目录时会被单实例锁挡住，测试请用 `DUPLEX_DATA_DIR`）。

---

## 六、本地模型工具调用改善（2026-11-07 追加）

现象：接 Ollama 等本地模型时"经常无法有效调用工具"。除模型本身能力外，代码侧有三个可改的点：

1. **只认原生 `tool_calls`**：小模型/去审查微调常把调用写成正文（JSON / 代码块 / `<tool_call>` / `name({...})`），运行期拿到零调用就当成普通回答。
   → 新增 `src/main/agent/llm/tool-repair.ts`，在 `chatStream` 出口统一兜底恢复，**只接受工具名单里的名字**（宁可漏认也不误执行），并把那段文字从回答里摘掉。
2. **请求参数对本地端点不友好**：原来既不发 `tool_choice`，也没关并行调用，也没控温度。
   → 带工具时补 `tool_choice: "auto"`、`parallel_tool_calls: false`；**本地端点**再加 `temperature: 0`，并把超长工具描述压到首句（≤280 字符），给真正有用的参数腾上下文。
3. **上下文不足时静默失败**：`finish_reason === 'length'` 原来被丢弃。
   → 现在会写一条明确日志（提示换更大模型或调高 `num_ctx`），便于定位"模型好像不会用工具"。

未做（需要进一步验证或产品决策）：Ollama 原生 `/api/chat` 以直接设置 `num_ctx`；工具结果没调通时的自动"再催一次"重试。

新增测试：`tests/tool-repair.test.ts`（11 项）。



来自 `AUDIT-2026-11-07.md` §〇·补 的进度表，剩两条 + 若干 P2：

## 七、仍未修的已知项（不在本轮范围）

- **P1**：abort 后动作仍在跑却报"已中断" → 客户端重试造成**二次点击**（下单/删除类高风险）
- **P1**：`settings.json.bak` 保留已清除的 API Key
- P2：`agents.json` 非原子写；i18n 英文 `{monthName}` 占位符错配；`downloads` 清空后活动项被写回；agent 会话 3.76 MB × 每 800 ms 全量重写；`browser:data-update` 全量快照（当前 310 KB/次，2 万条时约 5.6 MB）；历史面板无虚拟化

---

## 八、功能增量（2026-11-07，分支 `feat/ollama-native`）

按"补洞 → 差异化"的顺序做了 6 项，每一项都独立提交、独立过门禁。

| # | 功能 | 做了什么 | 提交 |
| --- | --- | --- | --- |
| 1 | **站点权限设置页** | 侧栏 🛡 打开：列出每条 origin 规则（类别 + 允许/询问/拒绝），AI 改过的标橙色；支持单类别重置、整站撤销、全部清除。**只能查看与撤销**——放行必须由用户在提示条上点击产生 | `fca3771` |
| 2 | **Ctrl+K 命令面板** | 新建/隐身/重开/关闭标签、重载、按名字切换标签、收起展开 AI 面板、标注、清历史。捕获阶段监听，输入法安全 | `6bc0230` |
| 3 | **划词即问** | 选中网页文字 → 右键「问 AI：选中内容」→ 展开侧栏并把内容以引用块预填进输入框。**用原生右键菜单而非注入浮动按钮**（`selectionText` 主进程本来就有，零注入面） | `c23c029` |
| 4 | **模型能力徽标** | 模型列表里对 Ollama 端点自动 `/api/show`：支持工具→绿点 + 上下文长度；不支持→橙字「换模型才能解决」 | `fca3771` |
| 5 | **AI 操作时间线** | 工具调用（名字/标签/成败/失败摘要）+ 人工接管 + 交回 AI，追加写到 `~/.cobrowse/timeline.jsonl`；侧栏 🕒 可回看，一键导出 Markdown 到下载目录。2 MB 轮转保留一代 | `3fe778b` |
| 6 | **双向驾驶权交接** | 协作栏原来是单向的（只能把方向盘交回 AI）。新增 `collaboration:pause`，按钮变成双向开关：「我来接管」/「恢复此页 AI」；当前标签排最前 | `5a7ec50` |

发现并更正的判断：上一轮说"界面里没有任何协作 UI"是**错的**——`App.tsx` 早就有 `collaboration-bar`，缺的是**收回方向盘的那一半**。

门禁：`typecheck` ✅ / **418 passed, 1 skipped** ✅ / `build` ✅（每项提交前都跑过）。


## 九、实测与修复（2026-11-08）

完整报告见 [docs/verification-2026-11-08.md](docs/verification-2026-11-08.md)。核心结论：

| 项 | 结果 |
| --- | --- |
| 
avigator.webdriver | **true → false**（关掉 AutomationControlled blink feature） |
| 页面里的自有 DOM 记号 | data-duplex-document → 中性 data-page-token |
| 广告拦截规则 | 启动时联网拉取 EasyList + EasyList China：2,577,696 字节 / **80,219 条**；有 7 天缓存回退 |
| 拦截实测 | doubleclick.net 被拦、普通请求放行；回环永不拦 |
| 人机验证 | 8 项检测（reCAPTCHA/hCaptcha/Turnstile/极验/Cloudflare/滑块），命中即暂停 AI 并交回用户 |
| 裸表达式 | valuate 现在 document.title 也能返回值（原来必须自己写 return） |
| UA-CH brands | 仍是 Chromium/152 —— 只有品牌化构建能声称 Google Chrome（唯一真正需要引擎层的信号） |

未完成：输入从 CDP 迁到 sendInputEvent、data-page-token 改 Symbol、真实站点端到端验证码验证。
