# 实测报告：自动化特征 / 广告拦截 / 验证码交接

> 2026-11-08 · 分支 `feat/ollama-native` · 原型 `release-0.3.0-prototype`（348 MB）
> 数据来源：运行中的实例 + 本地探针页，不是推断。

---

## 一、方法：自己造一个"能看见自己"的页面

站点判定机器人的第一手依据，是页面里能被读到的信号。所以我们先造一个探针页，把**页面能看到的自己**列出来：

```
node tools/probe-server.mjs 8799     # 本地静态服务
# 应用内打开 http://127.0.0.1:8799/
# 然后 evaluate: return window.__PROBE__()
```

探针覆盖：`navigator.webdriver`、UA / UA-CH brands、语言/插件/时区/硬件、WebGL 供应商、
我们自己的 DOM 属性与全局变量、ChromeDriver/Puppeteer/Playwright 常见全局、
以及"被替换过的方法是否还带 `[native code]`"。

---

## 二、修复前后的真实对比

| 信号 | 修复前 | 修复后 | 判定依据 |
| --- | --- | --- | --- |
| `navigator.webdriver` | **true** | **false** | 最强、最直接的"这是机器人"标记 |
| UA 里的产品 token | 已无 Electron/app token | 无 | 早前已处理 |
| 我们自己的 DOM 属性 | `data-duplex-document` | `data-page-token`（不再带产品名） | 唯一指纹 |
| 我们自己的全局变量 | `__duplexEvaluations` 常驻 | 仅在 evaluate 执行期间存在 | 用完即删 |
| ChromeDriver/Puppeteer/Playwright 全局 | 无 | 无 | — |
| 原生方法完整性 | 全部 native | 全部 native | 未被替换 |
| UA-CH brands | `Chromium/152` | 同左（**未解决**） | 见 §五 |

`navigator.webdriver` 的根因不是"我们像爬虫"，而是**嵌入方式的副产物**：应用为了自动化开了
`remote-debugging-port`，Playwright 通过 CDP 接管后，Blink 就把这个标记置为 true。
修法是关掉 `AutomationControlled` 这个 blink feature——引擎行为一点没变，只是不再对外
宣布"我是被自动化驱动的"。**这不是破解验证码**，验证码交给用户（见 §四）。

### 2.1 顺带挖出的更严重问题：两个功能一直是死代码

做验证码交接的端到端测试时，日志里连监控注册的痕迹都没有。查下去发现：

```
[challenge] contents created type=window
[challenge] contents created type=window      ← 每个都是 window
```

**`webContents.getType()` 对 WebContentsView 的页面、甚至 iframe 一律返回 `'window'`。**
而元素隐藏与挑战监控原来都写着 `if (wc.getType() !== 'browserView') return`——于是
**两者自上线起就从未执行过**：元素隐藏一条 CSS 都没注入，挑战检测一次都没跑。

这是"看起来接好了、实际没接"的典型：没有报错、没有日志、开关能点、状态能读。
修正判据为**身份比较**（`wc.id === win.webContents.id` 才是应用自身 UI），两处都改。
修完后立刻验证：

```
[adblock] 元素隐藏已注入 bytes=224640 url=http://127.0.0.1:8799/
[challenge] 检测到 unknown：http://127.0.0.1:8799/challenge conf=0.85（验证路径）
[challenge] AI 已在标签 10 上暂停
```

全仓再查 `getType()`，只有这两处，没有第三个受害者。

---

## 三、广告拦截：从"空转"到真的拦

### 3.1 规则来源（启动时联网拉取 + 缓存回退）

```
[adblock] rules source=network bytes=2080206
[adblock] source=network accepted=68504 skipped=10094 domains=44700 regex=9 cosmetic=23787
```

- 首次启动：联网拉取 2,080,206 字节 → **68,504 条规则**（44,700 域名 / 9 正则 / 23,787 元素隐藏）
- 二次启动：`source=cache`（7 天 TTL 内不再请求），规则数一致
- 中国区列表原来的 URL 是 404，已换成 Adblock Plus 下载站地址
- 请求走 Electron `net`（跟随系统代理）——本机不走代理到不了外网

### 3.2 拦截是否生效（页面内实测）

```js
fetch('https://securepubads.g.doubleclick.net/tag/js/gpt.js')
  → BLOCKED (Failed to fetch)          ✅ 被拦
fetch('https://example.com/favicon.ico')
  → ALLOWED                            ✅ 正常放行
```

`googletagmanager` / `google-analytics` 放行是**正确行为**：EasyList 本身不拦它们（那是 EasyPrivacy 的职责）。

### 3.3 三条安全线（单测覆盖）

- 回环地址（localhost / 127.0.0.0/8 / [::1]）**永不拦截**——拦了会掐断自家 AI 面板与 MCP 桥
- 非 http(s) 协议不拦
- 元素隐藏**只注入 `display:none`**，绝不移除 DOM（AI 的 snapshot 必须和人看到的一致）

---

## 四、人机验证：检测 + 交接（不对抗）

产品决定：**不自动过验证码**。检测到挑战就暂停 AI，把控制权交回用户。

支持的信号（8 项单测）：

| 类型 | 依据 |
| --- | --- |
| reCAPTCHA / hCaptcha / Turnstile / 极验 | iframe 域名，置信度 0.9 |
| Cloudflare 挑战页 | `/cdn-cgi/challenge-platform/`、`cf-chl`、`/sorry/`，0.85 |
| 文本/标题 | "Verify you are human"、"unusual traffic"、"请完成安全验证"、"人机验证"，0.7 |
| 滑块 | "拖动滑块"、"slide to verify"，0.75 |

达到暂停阈值（≥0.75）时：该标签被标记 → **AI 的修改类工具直接被拒绝**，返回明确指令
"让用户手动完成验证，不要尝试自动通过"；同时浏览器 chrome 顶部出现提示条。

反例测试确保不误报：普通文章里的 "verification"、普通 YouTube 嵌入、普通登录页都不触发。

### 4.1 端到端实测（不是只有单测）

造了一个 `/challenge` 测试页（标题 `Verify you are human` + 正文"请完成安全验证" +
reCAPTCHA iframe），在运行中的实例里打开，然后让 AI 点击页面：

```
[challenge] 检测到 unknown：http://127.0.0.1:8799/challenge conf=0.85（验证路径）
[challenge] AI 已在标签 10 上暂停

click → 这个页面要求人工验证（人机验证/挑战页）。AI 已暂停：请告知用户在浏览器里
         手动完成验证，完成后你再继续。不要尝试自动通过验证码，也不要换入口绕过。
```

**修改前同一条点击是成功的（`clicked: true`）**——这就是它作为回归证据的价值。

### 4.2 交接之后必须能恢复（两个自己挖出来的坑）

端到端一跑就暴露出两个设计错误，都已修：

1. **标记是粘住的**：挑战状态在页面加载时就锁定，用户就地通过验证后 AI 会一直被拒。
   改为**每次调用实时判定**（当前 URL + 标题），过了就是过了。
2. **连 `navigate` 都被拒**：AI 被永久困在挑战页上，连"离开"都做不到。导航类工具
   （navigate / new_tab / switch_tab / close_tab）现在放行——不碰验证，但能走开并告知用户。

修复后的完整链路实测：

```
1) 挑战页点击      → 被拒绝（交接话术）
2) 挑战页导航离开  → 成功（https://example.com）
3) 普通页点击      → clicked: true      ← 恢复正常
```

---

## 五、诚实结论：内核这件事，数据说了什么

### 5.1 你的直觉有一处是对的

UA-CH（`navigator.userAgentData.brands`）实测是：

```
["Not?A_Brand/24", "Chromium/152"]
```

真实 Chrome 会说 `Google Chrome/152`。这不是我们能改的——brands 来自构建期的产品标识，
**只有品牌化的 Chromium 构建（fork 或自编译）才能声称自己是 Google Chrome**。

这是目前唯一一条"必须在引擎/构建层解决"的信号。它是支持"自己搞内核"的唯一硬证据，
但请注意：**它也是唯一一条**。其余所有信号（webdriver、DOM 痕迹、全局变量、行为节拍）
都在应用层可以处理。

### 5.2 但"写内核"仍然不是性价比最高的路

- 广告拦截：CEF 的 `OnBeforeResourceLoad` 与 Electron 的 `webRequest.onBeforeRequest`
  **是同一层、同一能力**。我们已经在拦了，换内核不会多拦一条。
- 行为节拍与 IP/登录态：**任何内核都改不了**，那是服务端的判定。
- 去掉 CDP：这是 CEF 的真实收益，但 Electron 也能做（`sendInputEvent` 进程内输入），
  差别是工作量，不是可能性。

**建议顺序**：先把进程内输入做掉并实测（见 §六），再决定要不要为了 UA-CH brands 下沉到 CEF/Fork。

### 5.3 已核实的开源候选

| 候选 | 定位 | 对我们是否可行 |
| --- | --- | --- |
| CEF | Chromium 的嵌入框架 | 唯一现实的"下沉一步"：同引擎、无 CDP、可控注入面 |
| Chromium fork（Brave 系等） | 整棵浏览器树 | 成本高；Brave 的 `adblock-rust` 可以**直接当库用**，不必 fork |
| Servo | 新布局引擎 | 已可作 crates 嵌入，但真实站点兼容性不足以撑日常浏览器 |
| Ultralight | 小型商业引擎 | 授权与生态都不合适 |
| WebKit（WPE/GTK） | 可嵌入 | 站点兼容 + 无 Widevine |
| GeckoView | Android | 只对安卓端有意义 |

---

## 五点五、输入路径 A/B：CDP vs 进程内 `sendInputEvent`

### 实现

`click` / `dblclick` / `hover` 现在默认走**进程内输入**：

1. 用元素 `getBoundingClientRect()` 取视口中心点（要求元素在 main frame、可见、在视口内）
2. `webContents.sendInputEvent()` 依次发 mouseMove → mouseDown → mouseUp（`isTrusted` 真事件）
3. 不满足条件（iframe 内 / 不可见 / 滚不进来）时**回退 Playwright**，行为不变
4. `DUPLEX_INPUT_PATH=cdp` 可强制旧路径，用来做 A/B

### 实测（同一台机器、同一页面、各 10 次点击）

| 路径 | 结果 mode | 页面收到的点击 | isTrusted | 平均耗时 |
| --- | --- | --- | --- | --- |
| A) CDP（Playwright） | `playwright` | 10 / 10 | 全部 true | 48 ms |
| B) 进程内（sendInputEvent） | `process-input` | 10 / 10 | 全部 true | 45 ms |

**页面侧看不出区别**——两条路径都产生 trusted 事件。真正的差异在进程侧：进程内输入不经过
CDP 的 `Input` 域，是"最终能把 CDP 会话整个拿掉"的必要一步；而且它顺带修掉了一个真 bug（见下）。

### 顺带修掉的自我暂停 bug

第一次 A/B 时两条路径都被自己的协作锁暂停了：

```
[PAUSED] 人工正在操作页面；请由用户恢复此标签的 AI 操作
```

原因不同但根因相同——**AI 自己的动作被页面里的 overlay 报成了"人工活动"**：

- 进程内路径：`sendInputEvent` 真的穿过浏览器输入管线，overlay 如实上报
- CDP 路径：Playwright 点击前会把元素滚进视口，**那次滚动**被报成"人工滚动"

修法是给主进程一个"AI 输入窗口"（`aiInputSuppressUntil`），窗口内的 humanActivity 事件忽略。
修完后两条路径都是 10/10 且不再暂停——**CDP 路径的这个 bug 在改动之前就在**，只是没人测过。

### 结论（对"要不要换内核"的意义）

进程内输入能拿掉的是 **CDP 的 Input 域**，但 `snapshot` / `query` / `screenshot` 仍然依赖
CDP 的 DOM 与截图能力。所以"彻底去 CDP"还没有完成，剩下的量级是**把快照与查询也改成
进程内实现**——这是 CEF 唯一真正的技术收益，但同样可以在 Electron 内完成。

---

## 六、没做完的（明确列出，不冒充完成）

1. **`type` / `scroll` / `press` 仍走 CDP**。本轮只迁了点击类动作；输入与滚动要模拟
   真实按键序列与滚轮事件，工作量更大，而且 `type` 还需要处理 IME 与逐字输入。
2. **`snapshot` / `query` / `screenshot` 仍依赖 CDP**——所以 CDP 会话暂时还拿不掉，
   §五点五 的结论仍然成立：去 CDP 的下半场是"快照与查询进程内化"。
2. **UA-CH brands 仍是 Chromium**（需品牌化构建，见 §5.1）。
3. **`data-page-token` 仍是一个属性**，只是不再带产品名。彻底方案是改成不落 DOM 的
   Symbol 属性或主进程侧映射，会牵动标注/导航校验，单独一轮做。
4. **元素隐藏的通用规则每页注入约 224 KB CSS**（全部 origin 无关规则）。功能正确，但
   大站点上可能带来样式重算开销，值得按"当前站点命中的规则"裁剪后再注入。
5. `list_tabs` 在会话没有绑定标签时可能报"没有任务标签"，需要复核（本轮遇到过一次）。
6. 元素隐藏对同一页面会重复注入（多个 contents 各注入一次），可去重。

---

## 七、复现方式

```powershell
# 1) 探针服务
node tools/probe-server.mjs 8799

# 2) 启动原型（隔离数据目录，别碰真实配置）
$env:DUPLEX_DATA_DIR = "$env:TEMP\duplex-030"
release-0.3.0-prototype\win-unpacked\Duplex.exe --user-data-dir="$env:TEMP\duplex-030\electron"

# 3) 看规则加载情况
Get-Content "$env:TEMP\duplex-030\app.log" | Select-String '\[adblock\]|\[challenge\]|\[ua\]'

# 4) 打包（本机必须给 electron-builder 代理，否则 ECONNRESET）
$env:HTTPS_PROXY='http://127.0.0.1:7890'; $env:HTTP_PROXY='http://127.0.0.1:7890'
npx electron-builder --win --dir --publish never --config.directories.output=release-0.3.0-prototype
```
