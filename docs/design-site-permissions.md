# 设计：站点权限白名单（Site Permissions Allowlist）

> 状态：待评审 · 2026-11-07
> 背景：0.2.11 的 `denyPagePermissions`（`src/main/index.ts:146-160`）对所有页面一律拒绝全部权限，且无放行入口，导致全屏、摄像头、通知、DRM、SSO、打印等能力静默失效。
> 目标：把"一刀切拒绝"换成"**按站点、可记忆、可被 AI 读写、但 AI 不能偷偷放宽**"的白名单。

---

## 一、目标 / 非目标

### 目标
1. 用户首次遇到权限请求时**在浏览器界面里**被询问，可选「仅本次 / 本次及以后 / 拒绝」。
2. 放行情况**按站点记住**，可随时在设置里查看与撤销。
3. **能直接跟 AI 说**：「以后 b 站别问全屏了」「把腾讯会议的麦克风关掉」，AI 通过工具改白名单。
4. **AI 不能单方面放宽**高危权限：放宽必须经过人工确认（复用现有审批卡片）。
5. 默认值仍然是安全优先，但**拒绝即破坏功能且无隐私风险**的能力（全屏、DRM、持久存储、唤醒锁…）默认放行。

### 非目标（v1 明确不做）
- 不做 `*.example.com` 通配（见 §十一 岔路 A）。
- 不做按 URL 路径 / 查询串的记忆（会把白名单变成历史记录）。
- 不做跨设备同步、不做导入外部浏览器权限。
- 不做"AI 自主判断该放行什么"——AI 只能执行用户的明确指令。

---

## 二、粒度：精确 origin

规则键 = **规范化 origin**，即 `scheme://host[:port]`，无路径、无查询、无凭据、无尾斜杠。

- `https://meeting.tencent.com` ✅
- `https://meeting.tencent.com:443` ❌（默认端口必须归一掉，与上者等价）
- `https://meeting.tencent.com/some/path` ❌（拒绝，含路径视为非法输入）

**为什么不用 hostname 或 eTLD+1**：
- `https://a.example.com` 的放行不能泄漏到 `http://a.example.com`（降级协议）或 `https://b.example.com`（子域接管）。
- eTLD+1 需要公共后缀表（额外依赖 + 数据更新负担），而真正需要授权的站点（会议、办公、政务）都是一站一 origin，精确匹配足够。
- 规范化必须处理：大小写、IDN → punycode、尾点（`example.com.`）、默认端口、`about:blank`（无 origin → 一律走默认，不记忆）。

---

## 三、权限分类（Electron 45 个权限 → 14 类）

Electron 的权限名用户无法理解，必须归类。**用 `Record<ElectronPermission, Category>` 全量映射，让 TypeScript 在 Electron 新增权限时直接编译报错**——把未来的静默漏洞变成编译期错误。

| 类别 | 覆盖的 Electron permission | 内置默认 | 说明 |
| --- | --- | --- | --- |
| `fullscreen` | `fullscreen`, `automatic-fullscreen` | **allow** | 拒绝即视频不能全屏，无隐私风险 |
| `drm` | `mediaKeySystem` | **allow** | 拒绝即奈飞/爱奇艺放不了 |
| `storage` | `persistent-storage`, `storage-access`, `top-level-storage-access` | **allow** | 拒绝即内嵌 SSO 读不到登录态 |
| `wake` | `screen-wake-lock`, `system-wake-lock`, `idle-detection` | **allow** | 看视频不息屏 |
| `print` | `web-printing`, `window-management`, `payment-handler`, `background-sync`, `periodic-background-sync` | **allow** | 低风险 |
| `pointer` | `pointerLock`, `keyboardLock` | **allow** | 在线 3D / 游戏 |
| `media` | `media`（按 `details.mediaTypes` 再分 camera / microphone，提示语区分） | **ask** | 摄像头麦克风 |
| `notifications` | `notifications` | **ask** | 网页通知 |
| `geolocation` | `geolocation`, `geolocation-approximate` | **ask** | 定位 |
| `clipboard-read` | `clipboard-read`, `deprecated-sync-clipboard-read` | **ask** | 粘贴图片/富文本 |
| `display-capture` | `display-capture`, `captured-surface-control` | **ask** | 屏幕共享 |
| `file-system` | `fileSystem` | **ask** | 本地文件读写 |
| `sensors` | `sensors`, `local-fonts`, `speaker-selection` | **ask** | 传感器/本地字体/扬声器选择 |
| `open-external` | `openExternal` | **ask** | 唤起外部应用（可启动任意协议） |
| `device` | `serial`, `usb`, `hid`, `midiSysex`, `smart-card`, `nfc`, `vr`, `hand-tracking` | **deny** | 硬件直通，高危，仅显式放行 |
| `local-network` | `local-network`, `local-network-access`, `loopback-network` | **deny** | 探测内网 |
| `other` | `midi`, `unknown` | **ask** | 兜底 |

> 归到 `other` 的**新权限**必须显式出现，否则 TS 报错——不允许"没分类 → 默认允许"。

`clipboard-sanitized-write` **不参与**本策略：它无害（只能写净化后的文本），在任何窗口都直接放行（保持现有行为 `index.ts:148`）。

---

## 四、决策引擎（优先级从上到下，首个命中即返回）

```
1. aiPaused 或 急停激活            → deny（不给 AI 任何能力开口子）
2. 请求来自 AI 会话发起的标签写操作 → T1/T2 一律 deny
   （判据：collaboration.hasTask(tabId) && owner != null，读操作不拦）
3. 内存中的"仅本次允许"(session grant) → 命中即 allow
4. 持久规则命中（deny 优先于 allow）：
     - origin 规则里该 category 的显式决定
     - 否则 global 里该 category 的用户覆盖
5. 内置默认：allow / ask / deny
6. 决策 = ask → 提示用户；超时或无法提示 → deny
```

**关键语义**：
- `setPermissionCheckHandler` **只在命中 allow 时返回 true**，其余一律 false。这是 Electron 规定的配套用法（"多数 Web API 先做 check，check 被拒才发 request"）——否则 `ask` 永远走不到请求阶段。
- **fail-closed**：任何异常、无法计算 origin、`webContents` 为 null（worker 发起的请求）、应用窗口不可见 → `deny`。

---

## 五、交互：提示条必须由主进程绘制、由浏览器界面渲染

### 5.1 为什么不能画在页面里
页面能伪造任何 UI。**提示条只能出现在浏览器 chrome（地址栏下方），origin 文本必须来自主进程的 `details.requestingUrl`**，绝不能取页面提供的值（这是 Chrome 的做法，也是本条设计的硬约束）。

### 5.2 提示条内容
```
[图标]  meeting.tencent.com  想使用你的 摄像头和麦克风
        [仅本次允许]  [本次及以后允许]  [拒绝]
        来源：meeting.tencent.com（内嵌自：office.example.com）   ← 跨源 iframe 时才显示
```

### 5.3 必须的防护
| 防护 | 规则 |
| --- | --- |
| 超时 | 30s 无响应 → `deny`（不记忆） |
| 后台标签 | 标签不活跃且用户 8s 内无输入 → 直接 `deny`，不弹（防"后台标签刷弹窗"） |
| 应用窗口隐藏/最小化 | 直接 `deny` |
| 限流 | 同一标签同时最多 1 个待决请求；同一 (origin, category) 60s 内重复请求合并 |
| 速率熔断 | 同一 origin 每分钟超过 3 次拒绝后，静默 `deny` 直到用户重新激活该标签 |
| 不可伪造 | origin 由主进程计算并随请求下发；渲染层只做展示，不回传 origin |

### 5.4 记忆语义
- **仅本次**：只写内存 session grant，进程结束即失效，不落盘。
- **本次及以后**：写持久规则 `origin + category = allow`，`source: 'user'`。
- **拒绝**：本次 `deny`；提示条同时提供「以后都拒绝」的小链接（写 `deny` 规则）。
- 撤销入口：设置页 + 点击地址栏左侧的权限图标。

---

## 六、存储

**独立文件 `~/.cobrowse/permissions.json`**，不塞进 `settings.json`。
理由：`settings.json` 是整体重写的配置对象（含 API key），站点列表会随使用无限增长，需要自己的原子写、`.bak` 恢复、容量上限与 LRU。

```ts
// src/shared/permissions.ts
export type PermissionCategory =
  | 'fullscreen' | 'drm' | 'storage' | 'wake' | 'print' | 'pointer'
  | 'media' | 'notifications' | 'geolocation' | 'clipboard-read'
  | 'display-capture' | 'file-system' | 'sensors' | 'open-external'
  | 'device' | 'local-network' | 'other'

export type Decision = 'allow' | 'ask' | 'deny'

export interface OriginRule {
  origin: string                       // 规范化 origin，键
  /** 只存与内置默认不同的类别（稀疏），默认变更可自动继承 */
  decisions: Partial<Record<PermissionCategory, Decision>>
  updatedAt: number
  source: 'user' | 'agent'             // 审计：谁改的
}

export interface PermissionStoreFile {
  version: 1
  /** 用户对全局默认的覆盖（可选） */
  global: Partial<Record<PermissionCategory, Decision>>
  origins: Record<string, OriginRule>
}
```

**可靠性要求**（全部按现有 `browser-session.ts` 的成熟模式）：
- 原子写：`tmp → rename`。
- `.bak`：写成功前保留上一版；读取失败 → 读 `.bak` → 仍失败 → **回落到内置默认**（绝不回落成"全部允许"）。
- 上限 **500 个 origin**，超出时按 `updatedAt` 淘汰最旧，并写一行日志。
- 单人使用；不做跨进程文件锁（单实例锁已保证）。
- 不写日志时输出 origin 列表以外的东西；日志里出现完整 URL 视为缺陷。

---

## 七、Agent 工具（本设计的核心差异点）

新增 **2 个工具**，v1 标记 `internal: true`（只给内置 agent，不暴露给外部 MCP 客户端）：

### 7.1 `list_site_permissions`（只读，无确认）
```json
{} 
→ {
  "global": { "media": "ask", ... },          // 仅列出被覆盖的项
  "origins": [
    { "origin": "https://meeting.tencent.com",
      "decisions": { "media": "allow" },
      "source": "agent", "updatedAt": 1762... }
  ],
  "session": ["https://bilibili.com (fullscreen, 仅本次)"]
}
```

### 7.2 `set_site_permission`（写）
```json
{ "origin": "https://meeting.tencent.com", "category": "media", "decision": "allow" }
```

**权限与确认策略（关键安全边界）**：

| 操作方向 | 是否需人工确认 | 理由 |
| --- | --- | --- |
| `allow` 且类别属 T1/T2（media / notifications / geolocation / clipboard-read / display-capture / file-system / sensors / open-external / device / local-network） | **必须确认** | 放宽高危权限；提示注入可能借 AI 之手给自己开摄像头 |
| `allow` 且类别属 T0（fullscreen / drm / storage / wake / print / pointer） | 不需要 | 无隐私风险，放宽也无害 |
| `deny` / `ask`（收紧） | 不需要 | 收紧永远是安全方向，fail-closed |

确认复用现有 `confirmScript` → `PermissionCard`，卡片显示：
```
AI 想允许  meeting.tencent.com  使用 摄像头和麦克风
[允许]  [拒绝]
```
- 卡片里的 origin 由**主进程重新规范化**得到，并校验：必须是裸 origin（`new URL()` 可解析、`pathname === '/'`、无 query/hash/username），非 `https:` 只允许 `localhost`/`127.0.0.1`。
- 工具返回值明确告知："已记录规则，等待用户确认后才生效"。
- 用户拒绝 → 规则不写入，工具返回 `denied by user`。

### 7.3 幂等与撤销
- 重复设置同值 → 返回 `unchanged`，不写盘、不打扰用户。
- `remove_site_permission { origin, category? }` 一并实现（省略 category 则清空该 origin 全部规则），无需确认。

### 7.4 为什么这条能做**产品差异**
现有所有"AI 浏览器"都把权限当隐式能力：AI 能让页面调摄像头，用户不知道。这里反过来——**AI 必须向你申请，且它的每一次改动都记录在案（`source: 'agent'`）**。设置页可以做成"AI 改过哪些权限"的审计列表，这既是对外讲的故事，也是内部评测的证据。

---

## 八、UI 改动

| 位置 | 内容 |
| --- | --- |
| 地址栏下方 | 权限提示条（§5.2）；同时是权限图标入口 |
| 地址栏左侧权限图标 | 显示当前站点的已授权项，点击展开��可撤销 |
| 设置 → 站点权限 | 列表：`origin` / 已放行类别 / 来源（你 / AI）/ 最后修改时间；行内可改 + 删除；顶部「全部清除」 |
| 设置 → 站点权限 | 「AI 改动」筛选器（`source: 'agent'`）——审计视图 |

---

## 九、兼容与迁移

- 首次启动无 `permissions.json` → 按内置默认运行，**无需迁移**。
- 与现有逻辑的关系：`denyPagePermissions` 被替换为 `attachPermissionHandlers(ses)`；`clipboard-sanitized-write` 保持原有放行；`emergencyStop`/协作锁的语义不变（只在决策引擎里新增第 1、2 条前置规则）。
- **隐身标签**（`incognito-*` 分区）也必须注册同一套处理器（修 A2），但**隐身态一律不记忆**：`仅本次允许` 可用，`本次及以后` 置灰并解释"隐身模式不记忆权限"。
- i18n：新增约 45 条文案进 `i18n-text.json`；必须用文档 §七 提到的同一正则扫描，避开 electron-vite ESM-shim 的误判陷阱。

---

## 十、测试计划

**单元（纯函数，最高价值）**
1. origin 规范化：大小写 / IDN→punycode / 尾点 / 默认端口 / 带路径或凭据 → 拒绝 / `about:blank` → 不记忆。
2. 类别映射**穷尽性**：断言 Electron 权限联合里的每个值都有映射（靠 `Record` 类型 + 一个运行期的"未分类即 other"兜底）。
3. 决策引擎真值表：aiPaused × 协作锁 × session × origin 规则 × global × 默认，至少 20 组。
4. 稀疏存储：只写偏离默认的项；默认值变更后旧规则自动继承。
5. 存储健壮性：损坏 → `.bak` → 内置默认；500 上限 LRU 淘汰。
6. 确认策略：T1/T2 的 `allow` 必须经过 confirm；`deny`/`ask` 不经过。

**集成（Electron 离屏夹具 + `DUPLEX_DATA_DIR`）**
7. 页面请求 → 提示条出现 → 仅本次 → 第二次仍询问；本次及以后 → 第二次直接允许。
8. 应用窗口隐藏时请求 → 立即 deny。
9. agent 调 `set_site_permission(allow, media)` → 确认卡片出现 → 同意后生效、`source: 'agent'`；拒绝则不写。
10. 隐身标签不产生持久规则。

---

## 十一、已定（2026-11-07，依据产品原则）

> 产品原则：**AI 在安全范围内可以做一切有益于用户的事情。**
> 落地判据只有一条：**出错时能不能撤回。能撤回就不打扰用户。**

### A. 粒度 → 精确 origin（已定）
只支持裸 origin（`https://meeting.tencent.com`）。不做 `*.example.com` 通配：需要引入公共后缀表依赖，且必须在 UI 上解释"包含所有子域"，收益不抵风险。见 §二。

### B. agent 放宽权限 → 按"可撤回性"三档，而不是一律确认（已定）

| 档 | 类别 | AI 能否自行放宽 | 用户感知 |
| --- | --- | --- | --- |
| `silent` | 全屏、DRM、存储/SSO、唤醒锁、打印、指针、剪贴板写 | **可以，不打扰** | 无感；只在设置页"AI 改动"里可见 |
| `sensitive` | 通知、定位、剪贴板读、传感器、唤起外部应用、兜底 | **可以，但要说一声** | 对话里一行提示 + 权限图标标黄 + 一键撤销 |
| `high-risk` | 摄像头麦克风、屏幕共享、本地文件、串行/USB/HID/NFC/智能卡/VR、内网探测 | **必须人工确认** | 阻塞式确认卡（复用现有 `PermissionCard`） |

**为什么媒体仍归 high-risk**：确认弹窗是摩擦，但"录下你的摄像头画面"一旦发生就无法撤回（帧已经出去了）。这正是原则里"安全范围"的边界——**可撤回性决定自主权**，不是"可信不可信"。

**为什么把一大半能力移到 silent/allow**：拒绝全屏、DRM、SSO 存储、打印不带来任何安全收益，却直接让浏览器不能用。上一版的一刀切正是"亮点没出来"的主要原因之一。

### 收紧永远不需要确认
把规则改成 `deny` 或 `ask` 是安全方向，AI 可以随时做，不需要打扰用户（fail-closed）。


---

## 十二、改动文件清单与工作量估算

| 文件 | 类型 | 内容 | 估算 |
| --- | --- | --- | --- |
| `src/shared/permissions.ts` | 新增 | 类别/映射/默认值/决策引擎（纯函数） | 180 行 |
| `src/main/permission-store.ts` | 新增 | 原子写 / .bak / 上限 / 稀疏合并 | 130 行 |
| `src/main/index.ts` | 改 | 替换 `denyPagePermissions`；提示 IPC；agent 确认接线 | ~180 行 |
| `src/shared/tools.ts` | 改 | 3 个工具（list / set / remove），`internal: true` | ~70 行 |
| `src/preload/index.ts` | 改 | `onPermissionRequest` / `respondPermission` / `sitePermissions*` | ~40 行 |
| `src/renderer/src/components/PermissionBar.tsx` | 新增 | 提示条（防伪造：只展示主进程给的 origin） | 170 行 |
| `src/renderer/src/components/SitePermissionsPanel.tsx` | 新增 | 设置页列表 + 审计筛选 | 220 行 |
| `src/renderer/src/App.tsx` / `SidePanel.tsx` | 改 | 挂载提示条 / 设置入口 | ~60 行 |
| `src/shared/i18n-text.json` | 改 | 约 45 条中英文 | — |
| `tests/permissions.test.ts` | 新增 | §十 的 1–6 | 260 行 |
| `tests/permission-policy-e2e.mjs` | 新增 | §十 的 7–10 | 180 行 |

合计约 **1,500 行**（含测试），不含 UI 样式打磨。建议拆两个提交：
1. **策略内核 + 存储 + 决策引擎 + 单测**（可独立合入，行为立即从"全拒"变成"按默认分级"）
2. **提示条 UI + 设置页 + agent 工具 + E2E**

---

## 十三、这一版不解决、但要记住的

- **A2 隐身分区一致性**：本设计顺带修掉（隐身也注册处理器），但仍需单独验证隐身态的默认值是否与普通态一致。
- **审计**：`source` 字段只记录"谁改的"，不记录"哪次对话"。若将来需要追责，可加 `sessionId`，但要注意隐私（不要把对话内容写进权限文件）。
- **企业/多用户**：当前是单用户模型；若将来支持多账户，白名单必须按账户隔离，否则会串权限。
