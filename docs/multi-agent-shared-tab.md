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

## 第三轮：真正耦合的协作任务（两个加数）

前两轮的任务可以各干各的；这一轮**谁都单独完成不了**：探针页新增两张输入框 + 「求和」按钮，
求和只有在两个加数都非空时才有意义。

| 角色 | 指令 | 结果 |
| --- | --- | --- |
| agent-1（规划者） | 只能填「加数 A」=6；读不到「加数 B」就继续 read 等待；两个都非空后点「求和」 | 6 次模型调用，1 次点击 |
| agent-2（填充者） | 只把「加数 B」填成 7，不碰 A、不点按钮 | 3 次模型调用，0 次点击 |

最终页面状态：`submits=1`、`a=6`、`b=7`、`sum=13`，墙钟 **7.93 s**，模型耗时合计 **9.83 s**。

三件被验证的事：

1. **没有提前提交**：agent-1 在 B 未填时没有点求和（否则 `sum` 会是 `null`，计数仍为 1 但结果错）。
2. **没有重复提交**：`submits` 正好 1 次。
3. **没有互相覆盖**：两个 agent 各写一个输入框，两个值都存活。

同时暴露了一个真实成本：**靠轮询等待很贵**。agent-1 的 6 次调用里有 3–4 次是"再 read 一次看看 B 有没有填"。
这直接指向一个待做的基础能力：**`wait_for(条件)` 或仲裁器级的"目标就绪"原语**，
让 agent 用一次调用等待，而不是花模型轮次轮询。这条比再造并发机制有价值得多。

## 第四轮：`wait` 原语，以及一个反直觉的发现

第三轮发现"轮询等待很贵"，于是给 `wait` 加了两种条件：`selector + hasValue`（等到某个输入框非空）、
`selector + value`（等到等于某个值），命中时**直接回传观察到的值**，省掉等待后的那次 read。

实测三次（同一任务、同一模型设置）：

| 运行 | agent-1 模型调用 | 是否用 wait | 阻塞时长 | 结果 |
| --- | --- | --- | --- | --- |
| 未提供 wait | 6 | — | — | sum=13 ✅ |
| 提供 wait + 一般描述 | 6 | ❌（继续 read 轮询） | 0 ms | sum=13 ✅ |
| 提供 wait + 显式要求 | 8 | ✅ 用了 | 58 ms | sum=13 ✅ |

结论（比"优化成功"更重要）：

1. **原语本身不是瓶颈，采纳才是。** 工具存在、描述清楚，模型仍然更习惯 `read` 轮询；
   强行要求它用 wait，反而因为多了一次工具往返让调用数从 6 升到 8。
2. 这个任务的等待窗口本来就很短（另一个 agent 一两秒就填完），wait 省下的时间小于
   多一次工具调用的模型延迟——**在小任务上 wait 不划算**，在大任务/慢站点上才可能。
3. 真正稳定的收益方向是"**减少模型轮次**"：把状态随动作结果一起回传（已做），
   以及让运行时在关键节点自动注入状态，而不是期待模型主动少问一次。

这一轮没有把"优化"包装成成功：三次运行里两次模型根本没用新工具，一次用了反而更慢。
需要更长的任务（多次跨 agent 依赖）才能验证 wait 的真实收益。

## 第五轮：多个**内置**会话并行

之前 `AgentRuntime` 是单例：一个实例装所有会话、同一时刻只跑一个，且工具调用硬编码 `builtin`。
也就是说"多 agent"只对**外部** agent 成立，内置会话再多也只是同一个人。

现在的做法（`src/main/agent/session-runner.ts`）：

1. **每个后台会话一个 runtime 实例**，各自 `load` 只看见自己那一个会话。
2. **身份**：工具调用包在 `withCaller('builtin:<sessionId>')` 里，授权 / ref 命名空间 / 仲裁因此按会话隔离。
3. **保存合并**：后台实例保存时**重新读盘、只替换自己的那条**，不覆盖别的会话。
4. **协作绑定**：每个后台会话用自己的 caller 绑定标签，互不抢对方的锁。
5. **事件带 sessionId**：渲染层收到 `agent:background-event`，可以归到对应会话。

IPC：`agent:parallel-start(text, sessionId?)`、`agent:parallel-running()`。

### 实测（真模型，两个会话同时跑）

```json
{
  "wallMs": 7115,
  "starts": [{ "ok": true, "sessionId": "demo-a" }, { "ok": true, "sessionId": "demo-b" }],
  "toolCounts": { "demo-a": 12, "demo-b": 8 },
  "final": { "clicks": 2, "input": "duplex" },
  "callers": ["builtin:demo-a", "builtin:demo-b"]
}
```

两个会话都指向同一个标签：demo-a 点按钮两次、demo-b 输入 duplex。**7.1 秒内 20 次工具调用**，
最终页面状态完全正确（2 次点击、输入框 `duplex`），且两个身份不同。

### 这条路上抓到并修掉的 bug

`sessionCallerId` 最初把非 ASCII 字符全部删掉，于是「会话 一号」和「会话 二号」都变成
`builtin:session` —— 两个内置会话共用授权与 ref 命名空间，比不隔离更糟。
现在只要发生截断/清空就拼上原 id 的哈希，测试覆盖了这条。

### 仍然存在的边界

1. 后台会话**没有 UI 表面**：事件已经发到渲染层，但面板还没有"运行中的会话"列表/徽标。
2. 保存是"读盘-改-写"，同一个会话不会互相覆盖；但多个实例同时写**不同**会话时，
   仍可能丢掉对方刚写的那一版（窗口毫秒级）。生产化需要一把文件锁。
3. 主实例仍独占会话列表与 UI 当前会话；后台会话要等一次保存后才出现在列表里。
