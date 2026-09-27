import type { Tab } from './tabs'
import { operationSignal } from './interrupt'

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
  await ensureAttached(tab)
  return tab.view.webContents.debugger.sendCommand(method, params)
}

export async function evalInPage<T = unknown>(tab: Tab, expression: string): Promise<T> {
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
  const info = KEY_CODES[main] ?? {
    code: main.length === 1 ? `Key${main.toUpperCase()}` : main,
    vk: main.length === 1 ? main.toUpperCase().charCodeAt(0) : 0
  }
  const base: Record<string, unknown> = {
    key: main,
    code: info.code,
    windowsVirtualKeyCode: info.vk,
    nativeVirtualKeyCode: info.vk,
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

export async function captureScreenshot(tab: Tab, fullPage: boolean): Promise<string> {
  const res = await cdp(tab, 'Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: fullPage
  })
  return res.data as string
}

export type LoadWaitResult = 'loaded' | 'timeout' | 'interrupted'

/** Wait for a page load; ends early when the user takes over (Esc). */
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
