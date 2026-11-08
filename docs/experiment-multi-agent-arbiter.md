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
