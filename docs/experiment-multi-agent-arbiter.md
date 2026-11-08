# 多 agent 共用标签：仲裁实验记录（2026-11-08）

分支 `exp/multi-agent-arbiter`（从 0.3.0 的 master `48c438f` 切出，**未合并**）。
目的：验证三条产品规则在真实页面上是否成立，先拿数字再决定要不要动生产路径。

## 三条规则

| 规则 | 实现 | 失败语义 |
| --- | --- | --- |
| 导航屏障 | `requestNavigation()` 等该标签上其它 agent 的在途操作结束；默认上限 3s | 超时才抢占，并在报告里区分 `timedOut` |
| 误跳转回退 | `handleUnexpectedNavigation()` 急停其它操作并返回 `rollbackTo`；被中断的 token 在下次动作前 `assertNotAborted()` 抛错 | **明确失败** + 提示"重新观察页面"，绝不静默继续 |
| 争用排序 | `withTarget()` 同一 (标签, 目标) 只允许一个执行者；释放时把持有权**移交**给权重最高者 | 权重：显式 > id 末尾编号 > 稳定哈希；同权重先到先执行 |

## 方法

- 页面：`tools/probe-server.mjs` 的探针页（`#probe-btn` 有 `window.__CLICKS__` 真实计数）
- 动作：真实鼠标事件（优先 `webContents.sendInputEvent`；无焦点环境自动降级 CDP 派发并记录 `clickPath`）
- 导航：真实 `loadURL`，包含一次跳到 `/challenge` 再回退
- 三个场景在**同一标签**上顺序执行，每次前重置计数
- 运行开关：`DUPLEX_ARBITER_EXPERIMENT=1` + userData 里的 `run-arbiter-experiment` 标记文件（一次性，跑完即删）

## 结果（本次运行）

```json
{
  "startedAt": "2026-11-08T14:38:14.177Z",
  "scenarios": [
    { "name": "nav-barrier", "pass": true,
      "metrics": { "waitedMs": 404, "preempted": [], "clicksWhileWaiting": 5, "clicksTotal": 5, "timedOut": false } },
    { "name": "forced-navigate-preempt-rollback", "pass": true,
      "metrics": { "preempted": ["agent-1"], "abortedAtStep": 3, "completedBeforeAbort": 3,
                   "clicksAtAbort": 3, "urlAfterNav": "http://127.0.0.1:8799/challenge",
                   "urlAfterRollback": "http://127.0.0.1:8799/", "resumedClicks": 5,
                   "totalClicks": 8, "clicksAfterResume": 5 } },
    { "name": "same-target-contention", "pass": true,
      "metrics": { "clicks": 3, "maxConcurrent": 1, "order": "agent-1,agent-2,agent-3",
                   "queuedAgents": ["agent-3", "agent-1", "agent-2"] } },
    { "name": "environment", "pass": true,
      "metrics": { "innerWidth": 1398, "innerHeight": 800, "focused": true,
                   "hitAtCenter": "probe-btn", "clickPath": "in-process" } }
  ]
}
```

读法：

- **导航屏障**：agent-1 连点 5 次（约 500ms），agent-2 等到 **404ms** 才放行，等待期间 5 次点击全部落地（`clicksWhileWaiting = clicksTotal = 5`）——屏障不是"把别人打断"，而是"自己等"。
- **抢占 + 回退**：agent-2 强制导航时，agent-1 已在**第 3 步**之后、第 4 步之前被拦下（`abortedAtStep = 3`，`clicksAtAbort = 3`）；页面确实跳到了 `/challenge`，回退后回到 `8799/`，补做 5 次，总计 8 次 = 计划数。
- **争用**：三个 agent 抢同一个按钮，按钮被真实点击 3 次（每次恰好一次），**最大并发持有者 = 1**；入队顺序是 3、1、2，执行顺序是 1、2、3——权重生效。
- 单测 15 条（屏障时序、超时抢占、强制抢占、回退、20 并发互斥、加权顺序、异常释放锁）全绿。

## 这一轮**没有**验证的（下一轮）

1. **两个真 LLM**：这里两个"agent"是同一进程里的脚本，没有模型延迟、没有各自的 snapshot、没有真实的观察-决策循环。
2. **多标签**：只测了单标签争用；"每标签一个写者"的跨标签调度未测。
3. **误跳转的自动检测**：`handleUnexpectedNavigation` 目前是显式调用；生产上需要监听 `did-navigate` 并判定"这次跳转是不是我们同意的"。
4. **权限不能跨 agent 继承**：`site-consent` 仍按 origin 记，多 agent 下必须改成 `(actor, origin)`，这一条是安全边界，实验没覆盖。
5. **ref 命名空间**：两个 agent 各自 snapshot 后 `[eN]` 会撞车，实验里用同一个选择器绕过了这个问题。

## 复现

```powershell
node tools\probe-server.mjs 8799
npm run build
$dir = "$env:TEMP\duplex-arbiter-exp"
New-Item -ItemType File -Force "$dir\electron\run-arbiter-experiment" | Out-Null
$env:DUPLEX_DATA_DIR = $dir; $env:DUPLEX_ARBITER_EXPERIMENT = '1'
npx electron . --user-data-dir="$dir\electron"
# 约 40s 后读 $dir\electron\arbiter-experiment.json
```

## 结论

三条规则在真实页面上成立，且**失败是显式的**——这是比性能更重要的性质：被抢占的 agent 会报错而不是带着脏状态继续。

但结论的适用范围要说清：它证明的是**仲裁层正确**，不是"多 agent 协作已经可用"。可用性还缺 ref 命名空间、跨 agent 权限隔离、以及真模型下的延迟/重复劳动测量。

## 第二轮：两个真实模型在同一标签上协作（2026-11-08 晚）

装置：`tests/two-agent-live.test.ts`（`DUPLEX_LIVE_DUAL_AGENT=1` 才运行）。
每个 agent 是**独立的模型循环**（自己的消息历史、自己的工具调用、自己的观察-决策轮次），
通过 CDP 驱动已启动应用里的探针页；点击经过"是否真的生效"校验，未生效自动回退并记录。
模型：DeepSeek V4.1 Flash（`deepseek-flash`）。

| 用例 | 墙钟 | 模型调用 | 模型耗时合计 | 最终计数 | 结果 |
| --- | --- | --- | --- | --- | --- |
| 并行协作（A 点 2 次 / B 输入 duplex） | 6639 ms | 4 + 3 | 4171 + 3105 = 7276 ms | 2 次 · 输入 duplex | ✅ 精确 |
| 串行基线（单 agent 做两件事） | 6654 ms | 5 | 5993 ms | 2 次 · 输入 duplex | ✅ 精确 |
| 争抢同一按钮（两 agent 各点 2 次） | 7770 ms | 6 + 6 | 6693 + 7371 ms | **4 次** | ✅ 精确，无重复点击 |

读法与结论：

- **没有重复点击**：两个真模型同时抢同一个按钮，按钮正好被点 4 次。这是上一轮脚本争用结论在**真模型**下的复现。
- **并行收益有限**：并行 6639 ms vs 串行 6654 ms，几乎一样。原因很直白——这两个任务的目标不同，本来就不互斥，并行省下的只是模型等待的重叠；而**模型延迟（7.3 s）远大于动作本身（<1 s）**，所以墙钟由模型决定。
- 由此得到一个重要的设计结论：**多 agent 的瓶颈不是浏览器仲裁，是模型轮次**。仲裁层要做的是"不出错"，不是"变快"。
- 争用用例 7770 ms：两次点击的 agent 各自 6 次模型调用，总模型耗时 14 s，墙钟 7.8 s——并发确实重叠了一半以上，但每个 agent 都因为"要 read 确认计数"而多花轮次（互相干扰导致步数上涨）。

### 装置的两个坑（已修，记录以免重犯）

1. `browser.close()` 在 CDP 连接上会连带影响后续用例取到的页面，表现为"点击派发了但计数读到 0"。改为全程共用一个连接。
2. `page.mouse.click(x,y)` 在这条连接上偶发不产生点击，而 `fill/type` 正常。现在每次点击后校验计数，未生效回退 `locator` 点击并记录原因；否则会把"派发成功"误当成"人点到了"。
