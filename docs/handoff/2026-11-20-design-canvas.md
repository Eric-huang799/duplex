# HANDOFF：设计画布（feat/design-canvas）

> 交接时间：2026-11-20 · 分支 `feat/design-canvas` · HEAD `9a429c9`
> PR #7（Draft，67 文件）：https://github.com/Eric-huang799/duplex/pull/7
> 基线：`master` = 0.3.0-beta.2（不稳定调试版，v0.2.10 仍是 Latest）

## 一句话状态

「设计师 + agent 共同编辑页面」的**最小闭环已经能跑**：画布渲染、patch 事务、拖拽/槽位交换、定位器/放大镜/测量、剪贴板快捷键、每轮 git、静态站点导出、多 agent 光标层；agent 侧 6 个 `design_*` 工具可经 MCP 调用并自动打开画布。门禁绿，**未合并进 master**，PR 仍是 Draft。

## 门禁与证据

```
npm run typecheck   # node + web + canvas 三个 project，通过
npx vitest run      # 73 files passed / 2 skipped；788 tests passed / 5 skipped
npm run build       # electron-vite build + vite build（canvas bundle）
```

实测过的行为（本机真应用 + CDP 驱动）：

- 画布 22 个 `data-did` 节点渲染；`✦ 设计` 打开
- MCP：`design_open → design_read → design_patch → design_commit → design_export` 全链路（提交 `37e049a`、导出 zip）
- 拖拽（自由摆放）：`card-b` → `position:absolute; left:925; top:750`（帧坐标）
- 槽位交换：拖 `card-a` 到第 3 位 → toast「流式布局：card-a 移到第 3 位」，无 absolute 样式
- 锁定保护：锁 `card-a` 后 agent 改子节点被拒（「目标节点已锁定」）
- 变体：`design_variants` → 画布 A/B 对比
- 多断点：390 预览下 `--frame-scale` 生效，元素不跑出画框
- 导出：zip 内含 `design.json + site/index.html + site/styles.css`；Chrome 打开导出页渲染正常（截图 `docs/screenshots/exported-site.png`）
- 快捷键：复制/粘贴/撤销/重做/再制/删除实测（粘贴 17 → 撤销 16 → 重做 17 → 再制 18 → 删除 17）
- agent 实时显示：不点工具栏、只调 MCP `design_patch` → 画布自动打开，新节点 1.2s 内可见
- 急停：持久化暂停重启后界面显示「恢复 AI」，恢复后工具可用且 `settings.aiPaused=false`

## 架构地图（按修改频率）

| 路径 | 作用 |
| --- | --- |
| `src/shared/design/model.ts` | 文档模型 + `applyPatch`（唯一修改入口）+ 锚点/吸附 + 约束 + `PatchOp.update.unset` |
| `src/shared/design/style.ts` | **唯一令牌解析器**：`resolveTokenValue`（画布）、`resolveTokenExpression(mode:'var')`（导出） |
| `src/shared/design/export.ts` | 文档 → `index.html` + `styles.css`（令牌→CSS 变量，x/y→百分比） |
| `src/main/design/service.ts` | 打开/applyOps/撤销重做/约束/变体/commitRound/exportZip/state |
| `src/main/design/store.ts` `git.ts` `validate.ts` `ipc.ts` | 原子读写、每轮 git、入参白名单、12 个 IPC |
| `src/main/design-wiring.ts` | 画布 URL、服务事件→画布消息、画布消息→服务、`runTool`（6 个 design 工具） |
| `src/canvas/*` | 画布页面：`main.ts` 入口、`render.ts` 渲染、`interact.ts` 拖拽/定位、`inspector.ts` 检视器、`toolbar.ts`、`variants.ts`、`shortcuts.ts`、`geometry.ts`、`preload.ts` |
| `src/overlay-preload/*` | 普通页面上的多 agent 光标（`cursor-layer.ts`）、放大镜、定位/测量 |
| `src/main/agent/runtime.ts` | 系统提示词：**做网页 → design_* 工作流**（不要改画布 DOM） |
| `src/main/site-consent.ts` + `index.ts` | 站点授权（actor,origin）+ 会话信任模式（内存、显式确认） |

## 运行与验收

```powershell
# 0) 干净 profile（不要复用旧 acceptance profile 的 designs/）
$dir = Join-Path $env:TEMP "duplex-handoff-$(Get-Date -Format HHmm)"
New-Item -ItemType Directory -Force "$dir\electron" | Out-Null
# 如需 DeepSeek：从 ~/.cobrowse/settings.json 复制 agentProviders/activeProviderId 到 $dir\settings.json

# 1) 启动（构建产物在 out/）
$env:DUPLEX_DATA_DIR = $dir
npx electron . --user-data-dir="$dir\electron"

# 2) 取 CDP 端口
$port = (Get-Content "$dir\electron\DevToolsActivePort" -TotalCount 1)

# 3) 验收脚本（都可重复跑）
node tools/design-ui-check.mjs $port            # 打开画布 + 截图 + 节点统计
node tools/design-mcp-smoke.mjs design-agent-1  # agent 侧全链路（需 $env:DUPLEX_DATA_DIR）
node tools/design-interact-check.mjs $port      # 拖拽 + 提交 + 手机视口
node tools/design-lock-variants-check.mjs $port # 锁定拒绝 + 变体弹层
```

> 脚本依赖 `%TEMP%\duplex-*` 数据目录里的 `endpoint.json`（端口/token）。改动后先 `npm run build`，再重启 Electron。

## 还没做 / 已知坑（下一任先读）

1. **移动模式没有显式 UI**：目前靠"有无 `x/y`"隐式判定（绝对=自由拖，流式=交换），`Ctrl+Shift+L` 回流程。下一步应在检视器里显示当前模式并提供切换，而不是让用户记快捷键。
2. **变体缩略图是简化渲染**：只画文本/背景，选后应用完整节点。
3. **定位器/放大镜不覆盖 iframe 与嵌套滚动容器**（overlay 报告已列，测量线会漂）。
4. **导出不含图片/字体/脚本**：`image` 节点导出成空 div；没有资源流水线。
5. **撤销栈只在内存**：重启后只能靠 git 轮次回退；约束/变体不进撤销栈。
6. **信任模式 UI 未手动验收**：需要真人点原生确认框（默认按钮是取消）；代码只允许"跳过询问"，不覆盖策略 deny，仅内存态。
7. **急停的设置页没有常驻状态指示**：目前靠顶部横幅；建议在设置页加显式开关/状态。
8. **`src/canvas/tsconfig.json` 已并入 typecheck**；以后新增构建入口记得同步，否则新目录会悄悄逃过类型检查。
9. **provider key 在 profile 的 settings.json 里是明文**（历史行为），发布前应迁 `safeStorage`；测试密钥建议轮换。

## 建议的下一步（按价值排序）

1. **检视器里的移动模式开关 + 断点意图**：让"自由摆放 / 槽位交换 / 某断点下隐藏"成为可见概念，而不是隐式约定。
2. **导出资源流水线**：图片/字体进 zip，生成可部署目录；给 `image` 节点真实 `img`。
3. **信任模式与急停的状态可见性统一**：设置页常驻状态 + 启动回读清单（这次隐形急停就是缺少启动回读）。
4. 变体缩略图用真实 `renderDocument` 缩放到小容器。
5. 把 `design_*` 工具接到 UI 的"设计模式"入口（现在只有工具栏按钮 + agent 自主调用）。

## 交接守则

- 不要 force push / 直接改 `master`；所有改动走 `feat/design-canvas` 或新分支，PR 保持 Draft 直到验收。
- 不要复用旧 acceptance profile 的 `designs/` 目录：里面是测试时反复拖动/撤销的脏文档。
- 后台 subagent 已全部停止，无运行中的 job。
- 修改后最少跑：`npm run typecheck` + `npx vitest run tests/design-*.test.ts tests/canvas-*.test.ts`，再重启应用做一次画布冒烟。
