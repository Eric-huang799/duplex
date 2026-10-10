/// <reference lib="dom" />
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium, type Browser, type Page, type Locator } from 'playwright-core'
import type { Tab } from './tabs'
import * as cdp from './cdp'
import { interruptibleSleep, operationSignal } from './interrupt'
import { overlaySend } from './overlay'

let userDataDir = ''
let connection: Promise<Browser> | null = null
const pages = new Map<number, Page>()

export function configurePlaywright(directory: string): void { userDataDir = directory }

export async function closePlaywright(): Promise<void> {
  const current = connection
  connection = null
  pages.clear()
  if (current) await (await current).close().catch(() => undefined)
}

function checkCancelled(): void {
  if (operationSignal()?.aborted) throw new Error('操作已被用户中断，请等待下一步指示')
}

async function browser(): Promise<Browser> {
  checkCancelled()
  if (!connection) {
    connection = (async () => {
      if (!userDataDir) throw new Error('Playwright 页面连接尚未配置')
      const deadline = Date.now() + 5000
      let port = ''
      while (Date.now() < deadline) {
        checkCancelled()
        try { port = (await readFile(join(userDataDir, 'DevToolsActivePort'), 'utf8')).split(/\r?\n/)[0] } catch {}
        if (/^\d+$/.test(port)) break
        await interruptibleSleep(100)
      }
      if (!port) throw new Error('未找到 Chromium 调试端口，请重新启动 Duplex')
      const connected = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 5000 })
      connected.on('disconnected', () => { connection = null; pages.clear() })
      return connected
    })().catch(error => { connection = null; throw error })
  }
  return connection
}

export async function pageForTab(tab: Tab): Promise<Page> {
  checkCancelled()
  const cached = pages.get(tab.id)
  if (cached && !cached.isClosed()) return cached
  const connected = await browser()
  const expected = await cdp.cdp(tab, 'Target.getTargetInfo')
  for (const context of connected.contexts()) {
    for (const page of context.pages()) {
      checkCancelled()
      const session = await context.newCDPSession(page)
      try {
        const actual = await session.send('Target.getTargetInfo')
        if (actual.targetInfo.targetId === expected.targetInfo.targetId) {
          pages.set(tab.id, page)
          return page
        }
      } finally { await session.detach().catch(() => undefined) }
    }
  }
  throw new Error(`无法连接标签页 ${tab.id} 的 Chromium 页面`)
}

/** CSS pierces open shadow roots; `iframe-selector >>> inner-selector` enters frames. */
export async function locatorForTarget(page: Page, target: string): Promise<Locator> {
  checkCancelled()
  if (/^e\d+$/.test(target)) {
    const identity = await page.evaluate(ref => {
      const state = (window as any).__cobrowse
      const el = state?.refMap?.get(ref) as Element | undefined
      const meta = state?.refMeta?.get(ref)
      if (!el?.isConnected) throw new Error('元素引用已失效，请重新 snapshot')
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160)
      if (meta && (meta.tag !== el.tagName || meta.text !== text || meta.href !== el.getAttribute('href') || meta.type !== el.getAttribute('type'))) {
        throw new Error('元素内容已变化，请重新 snapshot 后选择目标')
      }
      el.setAttribute('data-duplex-ref', ref)
      return ref
    }, target)
    return page.locator(`[data-duplex-ref="${identity}"]`)
  }
  const parts = target.split(/\s+>>>\s+/)
  if (parts.length === 1) return page.locator(target).first()
  let frame = page.frameLocator(parts.shift()!)
  while (parts.length > 1) frame = frame.frameLocator(parts.shift()!)
  return frame.locator(parts[0]).first()
}

async function humanScrolling(page: Page): Promise<boolean> {
  checkCancelled()
  return page.evaluate(() => Number(document.documentElement.getAttribute('data-duplex-human-scroll-until')) > Date.now())
}

type InputMarker = { kind: string; target?: string; x?: number; y?: number; key?: string; keys?: string[]; text?: string }

export function chordEventKeys(chord: string): string[] {
  const aliases: Record<string, string> = { Ctrl: 'Control', ControlOrMeta: process.platform === 'darwin' ? 'Meta' : 'Control', Cmd: 'Meta', Command: 'Meta', Space: ' ', Esc: 'Escape' }
  return [...new Set(chord.split('+').flatMap(token => {
    const key = aliases[token] ?? (/^Key[A-Z]$/.test(token) ? token.slice(3) : /^Digit\d$/.test(token) ? token.slice(5) : token)
    return key.length === 1 ? [key, key.toLowerCase(), key.toUpperCase()] : [key]
  }))]
}

/** Only the dispatch phase is marked; automatic waiting stays observable to humans. */
async function withAiInput<T>(page: Page, marker: InputMarker, action: () => Promise<T>): Promise<T> {
  checkCancelled()
  const marked = page.frames()
  for (const frame of marked) {
    let value = marker
    if (frame.parentFrame() && marker.x != null && marker.y != null) {
      const host = await frame.frameElement()
      const box = await host.boundingBox()
      const border = await host.evaluate(el => ({ x: (el as Element).clientLeft, y: (el as Element).clientTop }))
      if (box) value = { ...marker, x: marker.x - box.x - border.x, y: marker.y - box.y - border.y }
      await host.dispose()
    }
    await frame.evaluate(value => {
    const win = window as any
    win.__duplexAiInputDepth = (win.__duplexAiInputDepth || 0) + 1
    document.documentElement.setAttribute('data-duplex-ai-input', JSON.stringify(value))
    }, value).catch(() => undefined)
  }
  try { checkCancelled(); return await action() }
  finally {
    for (const frame of marked) await frame.evaluate(() => {
      const win = window as any
      win.__duplexAiInputDepth = Math.max(0, (win.__duplexAiInputDepth || 1) - 1)
      if (!win.__duplexAiInputDepth) document.documentElement.removeAttribute('data-duplex-ai-input')
    }).catch(() => undefined)
  }
}

async function waitReady(locator: Locator, page: Page, kind: 'click' | 'hover'): Promise<boolean> {
  const deadline = Date.now() + 5000
  let lastError: Error | undefined
  while (Date.now() < deadline) {
    checkCancelled()
    if (await humanScrolling(page)) return false
    try {
      // Playwright trial pointer actions still dispatch events before its hit
      // interceptor consumes them. Use visibility waiting here, so preload
      // capture listeners never mistake trial input for a person taking over.
      await locator.waitFor({ state: 'visible', timeout: 200 })
      if (kind === 'click' && !(await locator.isEnabled({ timeout: 200 }))) {
        await interruptibleSleep(100)
        continue
      }
      checkCancelled()
      return !(await humanScrolling(page))
    } catch (error) {
      checkCancelled()
      if (!(error instanceof Error) || !/Timeout/.test(error.name)) throw error
      lastError = error
    }
  }
  throw new Error('目标尚不可操作或被遮挡，请重新观察页面' + (lastError ? ': ' + lastError.message : ''))
}

async function domClick(locator: Locator): Promise<unknown> {
  checkCancelled()
  return locator.evaluate(el => {
    if (!el.isConnected || ('disabled' in el && el.disabled)) throw new Error('目标已不可操作，请重新观察')
    if (el instanceof HTMLElement) el.click()
    else el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    return { clicked: true, mode: 'dom', note: '人工正在滚动，已保留焦点和页面位置' }
  }, undefined, { timeout: 200 })
}

async function showTarget(tab: Tab, locator: Locator, action: string): Promise<void> {
  if (operationSignal()?.aborted) return
  try {
    const rect = await locator.boundingBox({ timeout: 200 })
    if (!rect || operationSignal()?.aborted) return
    overlaySend(tab, { kind: 'highlight', rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height }, label: `AI ${action}`, ttl: 800 })
    if (action === 'click' || action === 'dblclick' || action === 'hover') {
      const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2
      overlaySend(tab, { kind: 'showCursor', x, y, ttl: 900 })
      if (action !== 'hover') overlaySend(tab, { kind: 'clickFx', x, y })
    }
  } catch { /* a disappeared target does not change the completed action */ }
}

export async function performPageAction(tab: Tab, name: string, args: Record<string, unknown>): Promise<unknown> {
  checkCancelled()
  const page = await pageForTab(tab)
  const target = String(args.target ?? '')
  const locator = target ? await locatorForTarget(page, target) : null
  switch (name) {
    case 'click':
    case 'dblclick':
    case 'hover': {
      const ready = await waitReady(locator!, page, name === 'hover' ? 'hover' : 'click')
      if (!ready) {
        if (name === 'click') { const result = await domClick(locator!); await showTarget(tab, locator!, name); return result }
        throw new Error('用户正在滚动；此动作需要鼠标位置协调。请继续读取或等待用户指示，不要反复重试')
      }
      if (/^e\d+$/.test(target)) await locatorForTarget(page, target)
      const box = await locator!.boundingBox({ timeout: 200 })
      const inputTarget = `${Date.now()}-${Math.random()}`
      await locator!.evaluate((el, id) => el.setAttribute('data-duplex-ai-target', id), inputTarget, { timeout: 200 })
      const marker = { kind: 'pointer', target: inputTarget, x: box ? box.x + box.width / 2 : undefined, y: box ? box.y + box.height / 2 : undefined }
      await withAiInput(page, marker, async () => {
        if (name === 'click') await locator!.click({ timeout: 200, noWaitAfter: true })
        else if (name === 'dblclick') await locator!.dblclick({ timeout: 200, noWaitAfter: true })
        else await locator!.hover({ timeout: 200 })
      })
      checkCancelled()
      await showTarget(tab, locator!, name)
      return { [name === 'click' ? 'clicked' : name === 'dblclick' ? 'doubleClicked' : 'hovered']: true, target, mode: 'playwright' }
    }
    case 'type': {
      const value = String(args.text ?? '')
      const clear = args.clear !== false
      if (await humanScrolling(page)) {
        if (args.submit) throw new Error('用户正在滚动；输入后按 Enter 需要焦点协调。请将填写和提交分开')
        return locator!.evaluate((el, opts) => {
          if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) throw new Error('人工滚动期间仅支持标准 input/textarea 的 DOM 输入，请协调后操作此编辑器')
          if (el.disabled || el.readOnly) throw new Error('输入框不可编辑')
          const next = opts.clear ? opts.value : el.value + opts.value
          const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype
          Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, next)
          el.dispatchEvent(new Event('input', { bubbles: true }))
          el.dispatchEvent(new Event('change', { bubbles: true }))
          return { filled: el.value === next, length: next.length, mode: 'dom', note: '人工正在滚动，已保留焦点和页面位置' }
        }, { value, clear }, { timeout: 200 })
      }
      // Wait without focusing, then fill once; a cancelled fill is never retried.
      const deadline = Date.now() + 5000
      while (!(await locator!.isEditable({ timeout: 200 }))) {
        checkCancelled()
        if (Date.now() >= deadline) throw new Error('目标输入框尚不可编辑')
        await interruptibleSleep(100)
      }
      let next = value
      if (/^e\d+$/.test(target)) await locatorForTarget(page, target)
      if (!clear) next = (await locator!.inputValue({ timeout: 200 })) + value
      await withAiInput(page, { kind: 'type', text: next }, () => locator!.fill(next, { timeout: 200 }))
      checkCancelled()
      if (args.submit) await withAiInput(page, { kind: 'key', key: 'Enter' }, () => locator!.press('Enter', { timeout: 200, noWaitAfter: true }))
      return { filled: true, target, length: next.length, submitted: args.submit === true, mode: 'playwright' }
    }
    case 'drag': {
      if (await humanScrolling(page)) throw new Error('用户正在滚动；拖拽需要鼠标位置协调。请继续读取，不要反复重试')
      const from = await locatorForTarget(page, String(args.from))
      const to = await locatorForTarget(page, String(args.to))
      if (!(await waitReady(from, page, 'click'))) throw new Error('用户正在滚动；拖拽需要鼠标位置协调')
      checkCancelled()
      const fromBox = await from.boundingBox({ timeout: 200 })
      const inputTarget = `${Date.now()}-${Math.random()}`
      await from.evaluate((el, id) => el.setAttribute('data-duplex-ai-target', id), inputTarget, { timeout: 200 })
      await withAiInput(page, { kind: 'drag', target: inputTarget, x: fromBox ? fromBox.x + fromBox.width / 2 : undefined, y: fromBox ? fromBox.y + fromBox.height / 2 : undefined }, () => from.dragTo(to, { timeout: 250, noWaitAfter: true }))
      checkCancelled()
      return { dragged: true, from: args.from, to: args.to }
    }
    case 'select_option': {
      const wanted = String(args.option)
      const option = await locator!.evaluate((el, text) => {
        if (!(el instanceof HTMLSelectElement)) throw new Error('目标不是原生 select')
        const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase()
        const w = norm(text)
        const all = Array.from(el.options)
        const tiers = [all.filter(x => norm(x.text) === w), all.filter(x => norm(x.value) === w), all.filter(x => norm(x.text).includes(w)), all.filter(x => norm(x.value).includes(w))]
        const tier = tiers.find(x => x.length)
        if (!tier?.length || tier.length !== 1) throw new Error('选项不存在或匹配多个选项，请使用精确 value')
        return tier[0].value
      }, wanted, { timeout: 200 })
      checkCancelled()
      const selected = await locator!.selectOption({ value: option }, { timeout: 200 })
      return { selected }
    }
    case 'upload': {
      const files = Array.isArray(args.files) ? args.files.map(String) : []
      if (!files.length) throw new Error('files 必须包含文件路径')
      await locator!.setInputFiles(files, { timeout: 250, noWaitAfter: true })
      checkCancelled()
      return { uploaded: files.length, target }
    }
    case 'press': {
      if (await humanScrolling(page)) throw new Error('用户正在滚动；按键需要焦点协调，请使用元素点击或标准输入')
      await withAiInput(page, { kind: 'key', keys: chordEventKeys(String(args.key)) }, () => page.keyboard.press(String(args.key)))
      checkCancelled()
      return { pressed: args.key }
    }
    case 'scroll': {
      if (await humanScrolling(page)) return { scrolled: false, note: '用户正在阅读滚动，已保留用户位置；请用 snapshot/query/get_html 继续读取' }
      if (args.selector) {
        const selected = await locatorForTarget(page, String(args.selector))
        await selected.scrollIntoViewIfNeeded({ timeout: 200 })
      } else await page.evaluate(({ dx, dy }) => window.scrollBy(dx, dy), { dx: Number(args.dx ?? 0), dy: Number(args.dy ?? (args.dx != null ? 0 : 600)) })
      checkCancelled()
      return page.evaluate(() => ({ scrollX: window.scrollX, scrollY: window.scrollY }))
    }
    case 'evaluate': {
      const session = await page.context().newCDPSession(page)
      const signal = operationSignal()
      const id = `${Date.now()}-${Math.random()}`
      const cancel = () => {
        void session.send('Runtime.terminateExecution').catch(() => undefined).then(() =>
          page.evaluate(operationId => (window as any).__duplexEvaluations?.get(operationId)?.(), id).catch(() => undefined)
        )
      }
      signal?.addEventListener('abort', cancel, { once: true })
      try {
        checkCancelled()
        // Scoped timers and fetch are stopped before the cancellation result is
        // returned. A pending script cannot resume through an abandoned timer.
        const result = await page.evaluate(`(async () => {
          const root = window;
          const controller = new AbortController();
          const timers = new Set(), intervals = new Set(), frames = new Set();
          let rejectAbort;
          const aborted = new Promise((_, reject) => { rejectAbort = reject; });
          const stop = () => {
            controller.abort();
            timers.forEach(id => root.clearTimeout(id));
            intervals.forEach(id => root.clearInterval(id));
            frames.forEach(id => root.cancelAnimationFrame(id));
          };
          const cancel = () => { stop(); rejectAbort(new Error('操作已被用户中断')); };
          const state = root.__duplexEvaluations = root.__duplexEvaluations || new Map();
          state.set(${JSON.stringify(id)}, cancel);
          const timeout = (fn, ms, ...args) => {
            if (controller.signal.aborted) throw new Error('操作已被用户中断');
            if (typeof fn !== 'function') throw new Error('evaluate 定时器必须使用函数');
            const id = root.setTimeout(() => { timers.delete(id); if (!controller.signal.aborted) fn(...args); }, ms);
            timers.add(id); return id;
          };
          const interval = (fn, ms, ...args) => {
            if (controller.signal.aborted) throw new Error('操作已被用户中断');
            if (typeof fn !== 'function') throw new Error('evaluate 定时器必须使用函数');
            const id = root.setInterval(() => { if (!controller.signal.aborted) fn(...args); }, ms);
            intervals.add(id); return id;
          };
          const raf = fn => { const id = root.requestAnimationFrame(ts => { frames.delete(id); if (!controller.signal.aborted) fn(ts); }); frames.add(id); return id; };
          const fetchScoped = (url, options = {}) => root.fetch(url, { ...options, signal: options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal });
          const proxy = new Proxy(root, { get(target, key) {
            if (key === 'setTimeout') return timeout;
            if (key === 'setInterval') return interval;
            if (key === 'requestAnimationFrame') return raf;
            if (key === 'fetch') return fetchScoped;
            const value = Reflect.get(target, key, target);
            return typeof value === 'function' && !/^[A-Z]/.test(String(key)) ? value.bind(target) : value;
          }, set(target, key, value) { return Reflect.set(target, key, value, target); } });
          try {
            return await Promise.race([aborted, (async (window, globalThis, setTimeout, setInterval, requestAnimationFrame, fetch, signal) => {
              ${String(args.script)}\n
            })(proxy, proxy, timeout, interval, raf, fetchScoped, controller.signal)]);
          } finally { stop(); state.delete(${JSON.stringify(id)}); }
        })()`)
        checkCancelled()
        return result
      } finally { signal?.removeEventListener('abort', cancel); await session.detach().catch(() => undefined) }
    }
    case 'screenshot': {
      const fullPage = args.fullPage === true
      if (fullPage && await page.evaluate(() => document.documentElement.scrollHeight) > 20000) throw new Error('页面过长，请使用视口截图')
      const png = await page.screenshot({ type: 'png', fullPage, timeout: 5000 })
      checkCancelled()
      return { png: png.toString('base64') }
    }
    case 'wait': {
      const started = Date.now()
      const timeout = Math.min(Math.max(Number(args.timeout) || 10000, 1), 30000)
      if (!args.selector && !args.text) {
        await interruptibleSleep(Math.min(Math.max(Number(args.ms) || 1000, 1), 30000))
        checkCancelled()
        return { waitedMs: Date.now() - started }
      }
      while (Date.now() - started < timeout) {
        checkCancelled()
        const found = args.selector ? await (await locatorForTarget(page, String(args.selector))).count() > 0 : await page.getByText(String(args.text), { exact: false }).count() > 0
        if (found) return { found: true, waitedMs: Date.now() - started }
        await interruptibleSleep(100)
      }
      return { found: false, timeoutMs: timeout }
    }
    default: throw new Error(`不支持的页面操作: ${name}`)
  }
}
