> 已被 `docs/handoff/2026-11-24-v0.3.0.md` 取代（v0.3.0 已发布；本文保留为设计画布历史细节）。

# HANDOFF：设计画布（feat/design-canvas）

> 交接时间：2026-11-20 · 分支 `feat/design-canvas` · HEAD `9a429c9`
> PR #7（Draft，67 文件）：https://github.com/Eric-huang799/duplex/pull/7
> 基线：`master` = v0.3.0 正式版（2026-11-23）

## 一句话状态

「设计师 + agent 共同编辑页面」的**最小闭环已经能跑**：画布渲染、patch 事务、拖拽/槽位交换、定位器/放大镜/测量、剪贴板快捷键、每轮 git、静态站点导出、多 agent 光标层；agent 侧 6 个 `design_*` 工具可经 MCP 调用并自动打开画布。门禁绿，**未合并进 master**，PR 仍是 Draft。

## 最近一轮：评审修复（6587019）

外部评审在打包源码上做了一轮加固，已合入并全量验证：

- **模型/校验**：插入/替换拒绝 id 冲突、replace 必须保留 id、move 禁止移入自身后代与锁定目标、token 可删除（unset）、IPC 校验补上 update.unset（此前"回到流式"过不了 IPC）。
- **服务**：open() 先校验 projectId 再改状态；unset 的撤销回退为整节点快照；导出时构建提交失败直接报错，不再打包旧 HEAD；state 事件带真实 actor。
- **接线**：画布消息与 agent 工具参数统一走 validator（user-update 以前是原样信任）。
- **导出/CSS**：新增 src/shared/design/css.ts（画布与静态站点共用属性/值安全网与标签白名单）；类名改为 id 的 hex 编码避免碰撞；input 导出 value+readonly；绝对定位只在坐标确实为数字时生效。
- **技能**：.js 技能用 process.execPath + ELECTRON_RUN_AS_NODE=1，不再假设全局 node；启动失败给出真实错误。

**已知取舍**：画布不再接收增量 patch 消息（避免把含被拒条目的原始 ops 重放给页面），改为服务发布最终 document 触发整页更新。实时显示保留，但"diff 高亮动画"暂时缺失；恢复一条只含成功 op 的 patch 事件是明确的后续项。

测试：**804 passed / 5 skipped（74 文件）**。

## 本地全量验收（9d606c0）

在干净的 profile 上跑了完整验收：画布打开/渲染、agent 工具链（open/read/patch/commit/export）、写入校验（重复 id、移动成环）、剪贴板快捷键（复制/粘贴/撤销/重做/再制/删除）、槽位交换、自由摆放拖拽、定位器、变体选择、锁定拒绝、测量读数、390 预览、急停/恢复、导出与离线渲染。发现的三个"界面与意图不一致"问题已修：

1. **拖拽自由卡片里的文字会把文字拽出来**：现在拖拽会解析最近的绝对定位祖先，移动整张卡片，子元素留在流里。
2. **选择变体只记录 chosenIndex、页面不变**：现在 `chooseVariant` 会归一化 id 并通过 applyOps 真正替换区块（可撤销、有事件）；区块不存在时仍只记录选择。
3. **定位器第二次点击把目标重置成 root**：现在第一次点击锁定目标，后续点击只更新落点；root 保持 `position: relative`。

验收数据：节点 16→17 粘贴→16 撤销→17 重做→18 再制→17 删除；槽位交换 true 且无 absolute；自由卡片从内部文字拖拽后子元素无 absolute；定位 toast 目标为 `card-b-title`；变体标题变为「方案 A 已选」；急停拒绝并出现「恢复 AI」，恢复后工具可用；导出 zip 可离线渲染。


## 对话内 artifact 与本地资产（bccb629）

- **对话内**：SidePanel 顶部 WorkspaceTray 显示设计状态（第 N 轮/脏标记）与 打开/撤销/提交；画布仍是独立标签，不复制渲染器。
- **资产库**：`<cobrowseDir>/assets`，sha256 命名 + 原子索引；元数据 mime/字节/尺寸/时间/来源；同内容去重；单文件 64 MB、单次 50 个上限；只存本地、不上传。导入走原生文件对话框或 `assetsImport(paths)`。
- **画布图片**：`image` 节点用 `style.assetId`，通过 `duplex-asset://`（注册在 persist:cobrowse session）加载；渲染器不接受 style 里的 URL。
- **导出**：引用到的资产复制进 `site/assets/`，HTML 改成相对 `src`，zip 可离线打开；构建提交失败则不打包。
- **验证**：导入 2097×1200 PNG → tray chip → 插入 → 画布 `naturalWidth=2097` → 导出 zip 含 `site/assets/<id>.png` 且 HTML 有相对 src。

未做（下一轮）：资产删除/重命名/标签、EXIF/来源展示、agent 的 `asset_*` 工具、SVG 额外清洗。
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
7. **增量 patch 动画缺失**（评审修复后画布收全量 document，见上）；恢复只含成功 op 的 patch 事件。
8. **急停的设置页没有常驻状态指示**：目前靠顶部横幅；建议在设置页加显式开关/状态。
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
