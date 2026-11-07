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

## 五、仍未修的已知项（不在本轮范围）

来自 `AUDIT-2026-11-07.md` §〇·补 的进度表，剩两条 + 若干 P2：

- **P1**：abort 后动作仍在跑却报"已中断" → 客户端重试造成**二次点击**（下单/删除类高风险）
- **P1**：`settings.json.bak` 保留已清除的 API Key
- P2：`agents.json` 非原子写；i18n 英文 `{monthName}` 占位符错配；`downloads` 清空后活动项被写回；agent 会话 3.76 MB × 每 800 ms 全量重写；`browser:data-update` 全量快照（当前 310 KB/次，2 万条时约 5.6 MB）；历史面板无虚拟化
