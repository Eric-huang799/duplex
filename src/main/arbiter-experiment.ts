/**
 * 多 agent 仲裁实验：在真实页面上验证三条规则。
 *
 * 为什么单独一个模块而不是直接改主执行链：先把规则跑出数字，
 * 再决定要不要动生产路径。这里的动作都是**真实输入事件**（sendInputEvent）
 * 和**真实导航**（loadURL），不是模拟点击——否则测不到争用与抢占。
 */
import type { WebContents } from 'electron'
import { MultiAgentArbiter } from './multi-agent-arbiter'

export interface ExperimentReport {
  startedAt: string
  scenarios: Array<{
    name: string
    pass: boolean
    metrics: Record<string, number | string | boolean | string[]>
    notes: string[]
  }>
}

export interface ExperimentDeps {
  page: WebContents
  log: (message: string) => void
  sleep?: (ms: number) => Promise<void>
}

const sleepDefault = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export async function runArbiterExperiment(deps: ExperimentDeps): Promise<ExperimentReport> {
  const { page, log } = deps
  const sleep = deps.sleep ?? sleepDefault
  const arbiter = new MultiAgentArbiter()
  const tabId = 1
  const report: ExperimentReport = { startedAt: new Date().toISOString(), scenarios: [] }

  const evaluate = async <T>(body: string): Promise<T> =>
    (await page.executeJavaScript(`(() => { ${body} })()`, true)) as T

  const countOf = async (): Promise<number> =>
    evaluate<number>('return window.__CLICKS__ ? window.__CLICKS__.count : -1')

  const resetClicks = async (): Promise<void> => {
    await evaluate('if (window.__CLICKS__) { window.__CLICKS__.count = 0; window.__CLICKS__.trusted = [] }')
  }

  /**
   * 真实点击。优先进程内 `sendInputEvent`；实测在**无焦点**窗口里鼠标事件不会产生
   * 点击效果（`document.hasFocus() === false`，计数不动），所以自动退回 CDP 派发。
   *
   * 说明：CDP 只用于实验测量（它能让点击在无焦点时也生效），产品路径仍是进程内输入。
   */
  let clickPath: 'in-process' | 'cdp' = 'in-process'
  const cdpClick = async (x: number, y: number): Promise<void> => {
    const dbg = page.debugger
    if (!dbg.isAttached()) dbg.attach('1.3')
    await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 })
    await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  }

  /** 真实鼠标点击：移动 → 按下 → 抬起。 */
  const clickCenter = async (selector: string): Promise<void> => {
    // 没有 focus 时 sendInputEvent 不会落到这个 WebContentsView（生产路径也这么做）
    try {
      page.focus()
    } catch {
      /* 窗口可能正在失焦，仍然发送 */
    }
    const point = await evaluate<{
      x: number
      y: number
      w: number
      h: number
      hitId: string
    } | null>(`
      const el = document.querySelector(${JSON.stringify(selector)})
      if (!el) return null
      const r = el.getBoundingClientRect()
      const x = Math.round(r.left + r.width / 2)
      const y = Math.round(r.top + r.height / 2)
      const hit = document.elementFromPoint(x, y)
      return {
        x,
        y,
        w: window.innerWidth,
        h: window.innerHeight,
        hitId: hit ? (hit.id || hit.tagName) : 'none'
      }
    `)
    if (!point) throw new Error(`找不到元素 ${selector}`)
    if (point.x <= 0 || point.y <= 0 || point.x >= point.w || point.y >= point.h) {
      throw new Error(
        `元素不在视口内：(${point.x},${point.y}) 视口 ${point.w}×${point.h}，点击不会命中`
      )
    }
    if (clickPath === 'cdp') {
      await cdpClick(point.x, point.y)
      return
    }
    page.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y })
    page.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 })
    page.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 })
  }

  /** 用一次探测点击判断哪条派发路径真的能生效（无焦点窗口里 sendInputEvent 会静默失效）。 */
  const calibrateClickPath = async (): Promise<void> => {
    await load('http://127.0.0.1:8799/')
    await resetClicks()
    await clickCenter('#probe-btn')
    await sleep(120)
    if ((await countOf()) === 0) {
      clickPath = 'cdp'
      await cdpClick(0, 0).catch(() => undefined)
      await resetClicks()
      await clickCenter('#probe-btn')
      await sleep(120)
      log('[arbiter-exp] 进程内输入在此环境无效，实验改用 CDP 派发点击')
    } else {
      log('[arbiter-exp] 进程内输入有效，按 sendInputEvent 测量')
    }
    await resetClicks()
  }

  const viewportInfo = async (): Promise<Record<string, number | string>> =>
    evaluate<Record<string, number | string>>(`
      const btn = document.querySelector('#probe-btn')
      const r = btn ? btn.getBoundingClientRect() : null
      const point = r ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } : null
      const hit = point ? document.elementFromPoint(point.x, point.y) : null
      return {
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        focused: document.hasFocus(),
        visibility: document.visibilityState,
        buttonRect: r ? [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)].join('x') : 'none',
        hitAtCenter: hit ? (hit.id || hit.tagName) : 'none'
      }
    `)

  const load = async (url: string): Promise<void> => {
    const done = new Promise<void>((resolve) => {
      page.once('did-finish-load', () => resolve())
      setTimeout(resolve, 8000)
    })
    void page.loadURL(url)
    await done
    await sleep(150)
  }

  await calibrateClickPath()
  const viewport = await viewportInfo()    // 先记录环境：点击是否可能命中\n
  // ── 场景 1：导航屏障 ────────────────────────────────────────────────
  {
    await load('http://127.0.0.1:8799/')
    await resetClicks()
    const token = arbiter.beginOperation('agent-1', tabId)
    const work = (async (): Promise<void> => {
      for (let i = 0; i < 5; i++) {
        await clickCenter('#probe-btn')
        await sleep(100)
      }
      arbiter.endOperation(token)
    })()

    await sleep(130)
    const decision = await arbiter.requestNavigation('agent-2', tabId, { timeoutMs: 3000 })
    const clicksWhileWaiting = await countOf()
    await work
    const clicksTotal = await countOf()

    const pass = decision.preempted.length === 0 && clicksTotal === 5 && decision.waitedMs > 150
    report.scenarios.push({
      name: 'nav-barrier',
      pass,
      metrics: {
        waitedMs: Math.round(decision.waitedMs),
        preempted: decision.preempted,
        clicksWhileWaiting,
        clicksTotal,
        timedOut: decision.timedOut
      },
      notes: [
        'agent-1 连点 5 次（共约 500ms），agent-2 在此期间请求导航',
        `agent-2 等待 ${Math.round(decision.waitedMs)}ms 后才被放行`,
        `等待期间 agent-1 的点击未被截断（此时已完成 ${clicksWhileWaiting} 次）`
      ]
    })
    log(`[arbiter-exp] nav-barrier pass=${pass} waited=${Math.round(decision.waitedMs)}ms clicks=${clicksTotal}`)
  }

  // ── 场景 2：强制导航抢占 + 回退续做 ────────────────────────────────
  {
    await load('http://127.0.0.1:8799/')
    await resetClicks()
    const token = arbiter.beginOperation('agent-1', tabId)
    let abortedAt = -1
    let completed = 0
    const work = (async (): Promise<void> => {
      for (let i = 0; i < 8; i++) {
        try {
          arbiter.assertNotAborted(token, 'click')
        } catch {
          abortedAt = i
          break
        }
        await clickCenter('#probe-btn')
        completed++
        await sleep(80)
      }
      arbiter.endOperation(token)
    })()

    await sleep(200)
    const decision = await arbiter.requestNavigation('agent-2', tabId, { force: true })
    await work
    const clicksAtAbort = await countOf()

    // agent-2 真的跳走了
    await load('http://127.0.0.1:8799/challenge')
    const urlAfterNav = page.getURL()
    // 回退：回到原页继续 agent-1 未完成的操作
    const interrupted = arbiter.handleUnexpectedNavigation(tabId, 'agent-2', 'http://127.0.0.1:8799/')
    await load(interrupted.rollbackTo)
    const urlAfterRollback = page.getURL()

    const resumeToken = arbiter.beginOperation('agent-1', tabId)
    let resumed = 0
    for (let i = abortedAt < 0 ? 8 : 8 - completed; i > 0; i--) {
      arbiter.assertNotAborted(resumeToken, 'click')
      await clickCenter('#probe-btn')
      resumed++
      await sleep(40)
    }
    arbiter.endOperation(resumeToken)
    const clicksAfterResume = await countOf()

    const pass =
      decision.preempted.includes('agent-1') &&
      abortedAt >= 0 &&
      urlAfterNav.includes('/challenge') &&
      urlAfterRollback.endsWith('8799/') &&
      resumed + completed === 8

    report.scenarios.push({
      name: 'forced-navigate-preempt-rollback',
      pass,
      metrics: {
        preempted: decision.preempted,
        abortedAtStep: abortedAt,
        completedBeforeAbort: completed,
        clicksAtAbort,
        urlAfterNav,
        urlAfterRollback,
        resumedClicks: resumed,
        totalClicks: completed + resumed,
        clicksAfterResume
      },
      notes: [
        'agent-2 强制导航：agent-1 在动作前被 assertNotAborted 拦下（不是静默继续）',
        `agent-1 已完成 ${completed} 次后中断，回退到原页后补做 ${resumed} 次`,
        '回退地址由 handleUnexpectedNavigation 给出，页面最终回到原 URL'
      ]
    })
    log(
      `[arbiter-exp] preempt pass=${pass} abortedAt=${abortedAt} completed=${completed} resumed=${resumed}`
    )
  }

  // ── 场景 3：同一目标争用 ────────────────────────────────────────────
  {
    await load('http://127.0.0.1:8799/')
    await resetClicks()
    let active = 0
    let maxActive = 0
    const order: string[] = []
    const guardedClick = async (actorId: string): Promise<void> =>
      arbiter.withTarget(actorId, tabId, '#probe-btn', async () => {
        active++
        maxActive = Math.max(maxActive, active)
        order.push(actorId)
        await clickCenter('#probe-btn')
        await sleep(40)
        active--
      })

    // 先由 holder 占住目标，把三个 agent 压进等待队列，检验权重排序
    const holder = arbiter.withTarget('agent-9', tabId, '#probe-btn', async () => {
      active++
      maxActive = Math.max(maxActive, active)
      await sleep(150)
      active--
    })
    await sleep(20)
    const queued = ['agent-3', 'agent-1', 'agent-2'].map((id) => guardedClick(id))
    await Promise.all([holder, ...queued])
    const clicks = await countOf()

    const pass = clicks === 3 && maxActive === 1 && order.join(',') === 'agent-1,agent-2,agent-3'
    report.scenarios.push({
      name: 'same-target-contention',
      pass,
      metrics: {
        clicks,
        maxConcurrent: maxActive,
        order: order.join(','),
        queuedAgents: ['agent-3', 'agent-1', 'agent-2']
      },
      notes: [
        '三个 agent 抢同一个按钮：按钮被真实点击 3 次，恰好每次 1 次',
        `最大并发持有者 = ${maxActive}（必须为 1）`,
        `执行顺序 ${order.join(' → ')}：按编号加权，与入队顺序无关`
      ]
    })
    log(`[arbiter-exp] contention pass=${pass} clicks=${clicks} maxActive=${maxActive} order=${order.join(',')}`)
  }

  report.scenarios.push({
    name: 'environment',
    pass: viewport['hitAtCenter'] === 'probe-btn',
    metrics: { ...viewport, clickPath },
    notes: ['点击要能命中，页面必须已聚焦且按钮在视口内']
  })

  if (page.debugger.isAttached()) page.debugger.detach()

  return report
}
