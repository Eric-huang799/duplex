# Duplex 0.3.0-beta.1（测试版）

这是 0.3 系列的第一个可分发构建，定位是**原型机**：核心能力齐了，但还没有自动更新源、没有代码签名，遇到问题请提 issue。

## 这一版最重要的变化

### 1. AI 不再"自曝"是机器人

- `navigator.webdriver` 实测从 **true 变成 false**（关掉 `AutomationControlled` blink feature），这是站点判定"机器操作"最直接的信号。
- 页面里我们自己的指纹清掉了：`data-duplex-*` 属性改为中性名并在用后移除，`__duplexEvaluations` 用完即删。
- **读取与点击/输入都不再需要 DevTools 附着**：`snapshot`/`query`/`get_html` 走进程内 `executeJavaScript`，点击与输入走 `webContents.sendInputEvent`。仍是 CDP 的只剩滚轮、组合键、整页截图。

### 2. 人机验证：检测 + 交接，不对抗

检测 reCAPTCHA / hCaptcha / Turnstile / 极验 / Cloudflare / 滑块（8 项单测 + 端到端实测），命中即**暂停 AI 并交还用户**，同时允许 AI 导航离开、用户通过后可继续。**不实现自动过验证码**。

### 3. 敏感站点与未授权站点：默认服从用户，越界先问

- 判定器覆盖邮箱/银行支付/政务/身份认证/医疗，以及 `/login`、`/reset-password` 这类路径级信号。
- 硬闸门在主进程：AI 访问前先判、需要时弹确认，拒绝后禁止换标签/改 URL/换搜索引擎绕过。
- 授权按 **精确 origin** 记录，用户可在设置里查看与撤销。
- **检索中立**：不过滤、不降权；提示词明确禁止在总结时遗漏或改序。

### 4. 广告拦截真正生效

启动时联网拉取 EasyList + EasyList China（**80,729 条规则**（2,577,696 字节），7 天缓存回退），失败优雅降级为"不拦截"。修复了两个会让页面变形的问题：`#@#` 例外规则不再被丢弃；通用规则默认不套用（注入量从 224 KB 降到约 1 KB/页）。

### 5. 浏览器基本功补齐

打印 / 另存为 PDF、页面 DevTools（F12 / Ctrl+Shift+I）、拼写检查与右键建议、Ctrl+P。这些原来只有一部分或完全没有。

### 6. AI 面板

- 模型配置 / 站点授权 / 技能 / 操作时间线合并为**「模型与授权」下拉面板**，头部同一时刻只开一个。
- **模型选择单独放在头部**，切换即生效。
- 10 条**预置任务**（比价、填表、摘要、日程比对…），点一下直接发。
- **对话导出为 Markdown**（递归脱敏 api key/token/password）。
- 长回复不再被 `<think>` 思考文本污染；`evaluate` 接受裸表达式。

## 发布前修正（来自三方审查）

- 修复「恢复还原点后权限判定用旧实例」的问题（会导致撤销的权限不生效、并用旧快照覆盖新规则）。
- 挑战页判定现在会读 iframe 与页面正文——此前只按 URL/标题，登录页内嵌 reCAPTCHA 这类最常见情形根本不会触发停手。
- 站点闸门改为对**解析后的 URL** 判定（`mail.google.com` 这类无 scheme 写法不会再绕过授权）。
- 导出脱敏补上 `Cookie` / `Authorization: Basic|Token` / 正文里的 `x-api-key`。
- **权限历史不再刷屏**：已处理的授权折叠成一条可展开的汇总，只保留最近 30 条。
## 已知限制（不要当成 bug）

| 限制 | 说明 |
| --- | --- |
| 无自动更新源 | 代码路径已通，但还没配 `build.publish` 与代码签名，所以升级要靠手动下载 |
| 无 Chrome 扩展 | Electron 的扩展 API 不完整，MV3 基本不可用；能力由内置实现替代 |
| 不保存密码 | 加密库与 origin 匹配已就绪且测试通过，但未接 UI；决策见 `docs/design-passwords.md` |
| 长会话仍用截断 | 摘要压缩方案见 `docs/design-context-compression.md`，留待 0.3.x |
| 整页截图/滚轮仍走 CDP | 进程内没有等价能力 |
| UA-CH 仍自称 Chromium | 只有品牌化构建能声称 Google Chrome |

## 验证

- `npm run typecheck`、`npx vitest run`（599 项）、`npm run build` 全绿。
- 实测记录：[docs/verification-2026-11-08.md](verification-2026-11-08.md)
- 兼容性清单（20 站）：[docs/compat-checklist.md](compat-checklist.md)

## 升级注意

- 从 0.2.x 升级请先导出书签；数据目录默认仍是 `~/.cobrowse`。
- 这是测试版，主版本语义还没冻结，接口与配置可能变化。
