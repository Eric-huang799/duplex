import type { Tab } from './tabs'
import { operationSignal } from './interrupt'

/**
 * 诊断日志出口。主进程在启动时注入 `logLine`，这样"读操作是否走进程内"
 * 这类事实能落到 app.log 里可被复查，而不是只出现在打不开的 stdout。
 */
let ioLog: (message: string) => void = (message) => console.log(message)

export function setIoLogger(logger: (message: string) => void): void {
  ioLog = logger
}

/** 供其它模块复用同一条诊断日志通道。 */
export function logIo(message: string): void {
  ioLog(message)
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function ensureAttached(tab: Tab): Promise<void> {
  const dbg = tab.view.webContents.debugger
  if (!dbg.isAttached()) {
    try {
      dbg.attach('1.3')
    } catch {
      /* already attached concurrently */
    }
  }
}

export async function cdp(
  tab: Tab,
  method: string,
  params?: Record<string, unknown>
): Promise<any> {
  if (operationSignal()?.aborted) throw new Error('操作已被用户中断');
  await ensureAttached(tab)
  if (operationSignal()?.aborted) throw new Error('操作已被用户中断');
  return tab.view.webContents.debugger.sendCommand(method, params)
}

/** 读操作走进程内执行时只记录一次，便于在日志里区分两条路径。 */
let inProcessEvalLogged = false
let cdpEvalLogged = false

/**
 * 在页面里执行一段表达式。
 *
 * 优先用 `webContents.executeJavaScript`（进程内，**不需要 debugger 附着**），
 * 失败才退回 DevTools 协议。这是"去掉 CDP 痕迹"的最后一块：
 * snapshot / query / get_html / 标注取样全靠它，原来每次都 `debugger.attach('1.3')`，
 * 而那正是站点侧最容易探测到的信号之一。
 */
export async function evalInPage<T = unknown>(tab: Tab, expression: string): Promise<T> {
  if (operationSignal()?.aborted) throw new Error('操作已被用户中断')
  const wc = tab.view.webContents
  try {
    const value = (await wc.executeJavaScript(expression, true)) as T
    if (!inProcessEvalLogged) {
      inProcessEvalLogged = true
      ioLog('[io] eval 走进程内执行（无 debugger 附着）')
    }
    return value
  } catch (error) {
    // 极少数情况（例如 CSP 或执行上下文已销毁）会失败，退回 CDP 保证功能不退化
    if (!cdpEvalLogged) {
      cdpEvalLogged = true
      ioLog(`[io] eval 回退 CDP：${(error as Error)?.message ?? error}`)
    }
  }
  const res = await cdp(tab, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true
  })
  if (res.exceptionDetails) {
    const desc =
      res.exceptionDetails.exception?.description ??
      res.exceptionDetails.text ??
      'evaluate failed'
    throw new Error(String(desc).split('\n')[0])
  }
  return res.result?.value as T
}

export async function clickAt(tab: Tab, x: number, y: number): Promise<void> {
  await cdp(tab, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' })
  await sleep(30)
  await cdp(tab, 'Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x,
    y,
    button: 'left',
    clickCount: 1
  })
  await sleep(45)
  await cdp(tab, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x,
    y,
    button: 'left',
    clickCount: 1
  })
  await sleep(250)
}

const KEY_CODES: Record<string, { code: string; vk: number }> = {
  Enter: { code: 'Enter', vk: 13 },
  Escape: { code: 'Escape', vk: 27 },
  Tab: { code: 'Tab', vk: 9 },
  Backspace: { code: 'Backspace', vk: 8 },
  Delete: { code: 'Delete', vk: 46 },
  Space: { code: 'Space', vk: 32 },
  PageDown: { code: 'PageDown', vk: 34 },
  PageUp: { code: 'PageUp', vk: 33 },
  End: { code: 'End', vk: 35 },
  Home: { code: 'Home', vk: 36 },
  ArrowLeft: { code: 'ArrowLeft', vk: 37 },
  ArrowUp: { code: 'ArrowUp', vk: 38 },
  ArrowRight: { code: 'ArrowRight', vk: 39 },
  ArrowDown: { code: 'ArrowDown', vk: 40 }
}

const MODIFIER_BITS: Record<string, number> = {
  alt: 1,
  ctrl: 2,
  control: 2,
  meta: 4,
  cmd: 4,
  win: 4,
  windows: 4,
  shift: 8
}

/** Press a key or combo, e.g. "Enter", "PageDown", "Control+A", "Shift+Tab". */
export async function pressKey(tab: Tab, combo: string): Promise<void> {
  const parts = combo
    .split('+')
    .map((s) => s.trim())
    .filter(Boolean)
  const main = parts.length > 0 ? parts[parts.length - 1] : 'Enter'
  let modifiers = 0
  for (const p of parts.slice(0, -1)) {
    const bit = MODIFIER_BITS[p.toLowerCase()]
    if (bit) modifiers |= bit
  }
  const info = KEY_CODES[main]
  if (!info && main.length !== 1) {
    throw new Error(
      `不支持的按键：${main}。支持 Enter、Escape、Tab、Backspace、Delete、Space、PageDown、PageUp、End、Home、ArrowLeft、ArrowUp、ArrowRight、ArrowDown，或任意单字符键（可带 Ctrl/Alt/Shift 修饰，如 Ctrl+A）`
    )
  }
  const resolved = info ?? {
    code: `Key${main.toUpperCase()}`,
    vk: main.toUpperCase().charCodeAt(0)
  }
  const base: Record<string, unknown> = {
    key: main,
    code: resolved.code,
    windowsVirtualKeyCode: resolved.vk,
    nativeVirtualKeyCode: resolved.vk,
    modifiers
  }
  if (modifiers === 0) {
    if (main === 'Enter') base.text = '\r'
    else if (main.length === 1) base.text = main
  }
  await cdp(tab, 'Input.dispatchKeyEvent', { type: 'keyDown', ...base })
  await cdp(tab, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  await sleep(120)
}

export async function insertText(tab: Tab, text: string): Promise<void> {
  await cdp(tab, 'Input.insertText', { text })
}

export async function wheelScroll(tab: Tab, dy: number, dx = 0): Promise<void> {
  const metrics = await evalInPage<{ w: number; h: number }>(
    tab,
    '({ w: innerWidth, h: innerHeight })'
  )
  await cdp(tab, 'Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: Math.round(metrics.w / 2),
    y: Math.round(metrics.h / 2),
    deltaX: dx,
    deltaY: dy,
    pointerType: 'mouse'
  })
  await sleep(200)
}

export async function dblclickAt(tab: Tab, x: number, y: number): Promise<void> {
  await cdp(tab, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' })
  await sleep(30)
  await cdp(tab, 'Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x,
    y,
    button: 'left',
    clickCount: 1
  })
  await cdp(tab, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x,
    y,
    button: 'left',
    clickCount: 1
  })
  await sleep(40)
  await cdp(tab, 'Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x,
    y,
    button: 'left',
    clickCount: 2
  })
  await cdp(tab, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x,
    y,
    button: 'left',
    clickCount: 2
  })
  await sleep(250)
}

export async function hoverAt(tab: Tab, x: number, y: number): Promise<void> {
  await cdp(tab, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' })
  await sleep(280)
}

export async function dragFromTo(
  tab: Tab,
  x1: number,
  y1: number,
  x2: number,
  y2: number
): Promise<void> {
  await cdp(tab, 'Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: x1,
    y: y1,
    button: 'none',
    buttons: 0
  })
  await sleep(60)
  await cdp(tab, 'Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: x1,
    y: y1,
    button: 'left',
    buttons: 1,
    clickCount: 1
  })
  await sleep(90)
  const steps = 10
  for (let i = 1; i <= steps; i++) {
    const x = Math.round(x1 + ((x2 - x1) * i) / steps)
    const y = Math.round(y1 + ((y2 - y1) * i) / steps)
    await cdp(tab, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y,
      button: 'left',
      buttons: 1
    })
    await sleep(28)
  }
  await cdp(tab, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: x2,
    y: y2,
    button: 'left',
    buttons: 0,
    clickCount: 1
  })
  await sleep(250)
}

/** Set files on an <input type=file> by ref or CSS selector (absolute local paths). */
export async function setFileInputFiles(
  tab: Tab,
  target: string,
  files: string[]
): Promise<{ ok: boolean; error?: string }> {
  const t = JSON.stringify(target)
  const res = await cdp(tab, 'Runtime.evaluate', {
    expression: `(() => {
  const target = ${t};
  let el = null;
  if (/^e\\d+$/.test(target)) {
    el = (window.__cobrowse && window.__cobrowse.refMap && window.__cobrowse.refMap.get(target)) || null;
  } else {
    try { el = document.querySelector(target); } catch (e) { throw new Error('invalid selector: ' + target); }
  }
  if (!el) throw new Error('element not found: ' + target);
  if (el.tagName !== 'INPUT' || (el.type || '').toLowerCase() !== 'file') {
    throw new Error('target is not a file input (tag=' + el.tagName + ', type=' + (el.type || '') + ')');
  }
  return el;
})()`,
    returnByValue: false
  })
  if (res.exceptionDetails) {
    const desc =
      res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? 'resolve failed'
    return { ok: false, error: String(desc).split('\n')[0] }
  }
  const objectId = res.result?.objectId as string | undefined
  if (!objectId) return { ok: false, error: 'failed to resolve element object' }
  await cdp(tab, 'DOM.enable').catch(() => undefined)
  const { nodeId } = await cdp(tab, 'DOM.requestNode', { objectId })
  if (!nodeId) return { ok: false, error: 'failed to get DOM node for file input' }
  await cdp(tab, 'DOM.setFileInputFiles', { files, nodeId })
  await sleep(250)
  return { ok: true }
}

let inProcessShotLogged = false

export async function captureScreenshot(tab: Tab, fullPage: boolean): Promise<string> {
  // 视口截图用进程内的 capturePage（不需要 debugger）；
  // 整页截图仍走 CDP 的 captureBeyondViewport，进程内没有等价能力。
  if (!fullPage) {
    try {
      const image = await tab.view.webContents.capturePage()
      const png = image.toPNG()
      if (png.length < 100) throw new Error(`capturePage 返回空图（${png.length} 字节）`)
      if (!inProcessShotLogged) {
        inProcessShotLogged = true
        ioLog(`[io] 截图走进程内 capturePage（${png.length} 字节）`)
      }
      return png.toString('base64')
    } catch (error) {
      ioLog(`[io] 截图回退 CDP：${(error as Error)?.message ?? error}`)
    }
  }
  const res = await cdp(tab, 'Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: fullPage
  })
  return res.data as string
}

export type LoadWaitResult = 'loaded' | 'timeout' | 'interrupted'/** Wait for a page load; ends early when the user triggers the emergency stop. */
export async function waitForLoad(tab: Tab, timeoutMs = 15000): Promise<LoadWaitResult> {
  const wc = tab.view.webContents
  const signal = operationSignal()
  if (signal?.aborted) return 'interrupted'
  if (!wc.isLoading()) {
    await sleep(150)
    return signal?.aborted ? 'interrupted' : 'loaded'
  }
  return new Promise((resolve) => {
    let settled = false
    const finish = (r: LoadWaitResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      wc.off('did-stop-loading', onStop)
      wc.off('did-fail-load', onStop)
      signal?.removeEventListener('abort', onAbort)
      resolve(r)
    }
    const onStop = (): void => finish('loaded')
    const onAbort = (): void => finish('interrupted')
    const timer = setTimeout(() => finish('timeout'), timeoutMs)
    wc.once('did-stop-loading', onStop)
    wc.once('did-fail-load', onStop)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export type LoadStartResult =
  | { kind: 'loaded' }
  | { kind: 'interrupted' }
  | { kind: 'error'; message: string }

/**
 * Start a navigation and end the await immediately when the user takes over:
 * the abort handler stops the page load so nothing keeps running behind the
 * emergency stop.
 */
export async function loadUrlInterruptible(tab: Tab, url: string): Promise<LoadStartResult> {
  const wc = tab.view.webContents
  const signal = operationSignal()
  if (signal?.aborted) return { kind: 'interrupted' }
  return new Promise((resolve) => {
    let settled = false
    const finish = (r: LoadStartResult): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      resolve(r)
    }
    const onAbort = (): void => {
      try {
        wc.stop()
      } catch {
        /* ignore */
      }
      finish({ kind: 'interrupted' })
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    wc.loadURL(url)
      .then(() => finish({ kind: 'loaded' }))
      .catch((e: unknown) => {
        finish(
          signal?.aborted
            ? { kind: 'interrupted' }
            : { kind: 'error', message: String((e as Error)?.message ?? e) }
        )
      })
  })
}
