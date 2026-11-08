# 多 agent 共用一个标签：机制、实测与边界

分支 `exp/multi-agent-arbiter`（从 0.3.0 `48c438f` 切出，**未合并、未打 tag**）。
这份文档是这一轮的全部产出：设计、实测数字、怎么用、以及**哪些事还没做到**。

## 一句话结论

多 agent 能安全地同时用浏览器了，但**瓶颈不是浏览器，是模型轮次**。仲裁层的价值是"不出错"，不是"更快"。

## 四层机制

```
身份(caller)  →  仲裁(arbiter)  →  授权(actor, origin)  →  ref 命名空间
谁在操作          谁能动手          能进哪些站             点的是谁的元素
```

| 层 | 实现 | 保障 |
| --- | --- | --- |
| **身份** | 内置 agent 为 `builtin`；外部 agent 走 MCP 头 `duplex-caller-id`，默认 `bridge:<安装哈希>-<工作目录哈希>`，可用 `DUPLEX_CALLER_ID` 覆盖 | 同一项目重启后身份稳定；不同项目是不同 agent |
| **仲裁** | `src/main/multi-agent-arbiter.ts`，接入 `executeWithWake`：mutating 工具登记在途操作；导航走屏障；同一目标按权重串行；被抢占的调用在下一次动作前失败 | 不静默继续、不两个 agent 同时按同一个键 |
| **授权** | `SiteConsentStore` 按 `(actor, origin)`；`decideAccess` 缺 `agentId` 即拒绝，无共享白名单 | A 同意的站点 B 仍要单独问 |
| **ref** | 多 agent 时输出 `a<actor>:eN`；前缀不符直接报错；每个 ref 带指纹（tag+文本+坐标+token），动作前只读比对 | 不会点到别人的元素；元素变过就作废 |

页面内**零新增 DOM 属性与全局变量**（指纹只存在主进程内存里）——这条是产品底线，专门写测试守住。

## 仲裁的三条规则

1. **导航屏障**：要跳转的 agent 等该标签上其它操作结束（上限 3s，超时才抢占）。
2. **抢占后硬失败**：被跳转打断的 agent 在下一个动作前拿到明确错误（"重新观察页面"），不会带着脏状态继续。
3. **同目标加权串行**：同一按钮/输入框只有一个执行者；权重 = 显式 > id 末尾编号 > 稳定哈希，同权重先到先执行。

误跳转（页面自己重定向、脚本跳转）由 `did-navigate` 检测：没有 agent 请求过的跳转 → 急停该标签上所有在途操作、写时间线、给出可回退地址。**生产实现里不自动回退**，回退由被中断的 agent 或用户决定（实验证明回退机制本身可行）。

## 实测数字

### 仲裁（脚本 agent，真实页面，真实输入/导航）

| 场景 | 结果 |
| --- | --- |
| 导航屏障 | 等 404 ms，期间对方 5 次点击全部落地，0 次抢占 |
| 强制导航抢占 | 在第 3 步后被拦下，跳转 `/challenge` 后回退成功，补做 5 次，总 8 = 计划 8 |
| 三 agent 抢同一按钮 | 真实点击 3 次，最大并发持有 1，执行顺序按编号 1→2→3（入队 3,1,2） |

### 两个真模型同标签（DeepSeek V4.1 Flash）

| 用例 | 墙钟 | 模型耗时 | 最终状态 |
| --- | --- | --- | --- |
| 并行协作 | 6.64 s | 7.28 s | 2 次点击 + `duplex` ✅ |
| 串行基线 | 6.65 s | 5.99 s | 同上 ✅ |
| 争抢同一按钮 | 7.77 s | 14.1 s | **4 次点击，无重复** ✅ |

**并行没有更快**（6.64 vs 6.65）：两件事目标不同、本来不互斥，而模型延迟（7 s+）远大于动作本身（<1 s）。所以多 agent 要追求的是"分工与等待重叠"，不是"同一件事提速"。

### 端到端（真实 MCP 链）

`smoke-agent-1` 走 HTTP MCP：navigate → snapshot（`e8…`）→ click → `evaluate` 得 `{"count":1}`；`smoke-agent-2` 同时读取得到 `{"count":1}`（只读不被写者阻塞）。

## 怎么用

1. 应用内启动内置 agent（身份 `builtin`）。
2. 外部 agent（Codex / Claude Code / 任意 MCP 客户端）通过 bridge 接入，各自在**不同工作目录**启动 → 自动获得不同身份；同一目录多开时用 `DUPLEX_CALLER_ID=agent-a` / `agent-b` 区分。
3. 敏感站点：每个 agent **各自**弹一次确认。
4. 运维：时间线里能看到 `[arbiter]` 的抢占/等待记录；`/health` 仍是主进程单一入口。

## 已知边界（不要当成已完成）

1. **只有一个内置 agent 运行时**：`AgentRuntime` 是单例，多处硬编码 `'builtin'`。多个**内置**会话并行还没做；外部 agent 多开是支持的。
2. **iframe 内元素**无命名空间/指纹（`iframe >>> inner` 选择器仍可用）。
3. **动态文本误判**：时钟/价格/轮播或布局位移 >2px 会让旧 ref 作废（宁可多报错，不点错）。
4. **指纹不是节点身份**：同 tag/文本/位置被替换无法区分。
5. `agentMayBrowseUnlisted` 仍为 `true`：未授权的**非敏感**普通站点照旧放行（与 0.3.0 一致）。要"未授权即拒绝"需要改总闸。
6. **`run_command`/curl 不走这张授权表**，仍只靠确认卡提醒（既有缺口）。
7. 页面侧 refMap 只保留最近 3 次快照（全局），多 agent 交替快照可能提前挤掉旧 ref → 明确报"请重新 snapshot"，不会点错。

## 复现

```powershell
# 1) 仲裁实验（真实页面、真实输入）
node tools\probe-server.mjs 8799
$env:DUPLEX_DATA_DIR = "$env:TEMP\duplex-arbiter-exp"
New-Item -ItemType File -Force "$env:DUPLEX_DATA_DIR\electron\run-arbiter-experiment" | Out-Null
$env:DUPLEX_ARBITER_EXPERIMENT = '1'
npx electron . --user-data-dir="$env:DUPLEX_DATA_DIR\electron"

# 2) 双真模型（需要已启动应用 + provider 配置）
$env:DUPLEX_DATA_DIR = "$env:TEMP\duplex-030"
$env:DUPLEX_LIVE_DUAL_AGENT = '1'
npx vitest run tests/two-agent-live.test.ts

# 3) 真实 MCP 链（两个身份）
node tools\mcp-smoke.mjs smoke-agent-1
```

## 测试

```
Test Files 58 passed | 2 skipped
Tests      642 passed | 4 skipped
typecheck  通过（node + web）
```

本分支新增：仲裁器 15 条、ref 命名空间 11 条、授权 26 条（改造后）、身份 4 条。
