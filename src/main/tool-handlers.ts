import type { Tab, TabManager } from './tabs'
import * as cdp from './cdp'
import * as scripts from './page-scripts'
import { markAiActive, overlaySend, TAKEOVER_HINT } from './overlay'
import { interruptibleSleep, operationSignal } from './interrupt'
import { resolveAddress } from '../shared/url'
import { searchUrl } from '../shared/search'

export type ToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }

export interface ToolResult {
  content: ToolContent[]
  isError?: boolean
}

export type ToolExecutor = (name: string, args: Record<string, unknown>) => Promise<ToolResult>

const text = (s: string): ToolResult => ({ content: [{ type: 'text', text: s }] })
const errorText = (s: string): ToolResult => ({
  content: [{ type: 'text', text: s }],
  isError: true
})

function json(obj: unknown): string {
  try {
    return JSON.stringify(obj, null, 1) ?? String(obj)
  } catch {
    return String(obj)
  }
}

const interruptedText = (): ToolResult =>
  text('操作已被用户中断（用户按下 Esc 接管了浏览器）。请等待用户的下一步指示。')

interface ResolveInfo {
  error?: string
  x: number
  y: number
  tag: string
  text: string
  visible: boolean
  rect: { x: number; y: number; w: number; h: number }
}

async function resolveTarget(tab: Tab, target: string): Promise<ResolveInfo> {
  return cdp.evalInPage<ResolveInfo>(tab, scripts.buildResolveScript(target))
}

/** Resolve a target, then show cursor + highlight + status (blueprint state C). */
async function visualizeTarget(
  tab: Tab,
  target: string,
  verb: string,
  opts?: { sleepMs?: number; activeMs?: number }
): Promise<{ r: ResolveInfo; label: string } | { error: string }> {
  const r = await resolveTarget(tab, target)
  if (r?.error) return { error: r.error }
  const label = r.text ? `「${r.text.slice(0, 16)}」` : `<${r.tag}>`
  markAiActive(opts?.activeMs ?? 6000)
  overlaySend(tab, { kind: 'showCursor', x: r.x, y: r.y })
  overlaySend(tab, { kind: 'highlight', rect: r.rect })
  overlaySend(tab, {
    kind: 'status',
    text: `AI 正在${verb} ${label}`,
    hint: TAKEOVER_HINT,
    tone: 'busy',
    ttl: 4200
  })
  await interruptibleSleep(opts?.sleepMs ?? 300)
  return { r, label }
}

export function createToolExecutor(tabs: TabManager): ToolExecutor {
  return async (name, args) => {
    try {
      return await dispatch(tabs, name, args ?? {})
    } catch (e) {
      return errorText(`Error in ${name}: ${(e as Error)?.message ?? String(e)}`)
    }
  }
}

async function dispatch(
  tabs: TabManager,
  name: string,
  args: Record<string, unknown>
): Promise<ToolResult> {
  switch (name) {
    case 'list_tabs': {
      return text(json(tabs.list()))
    }

    case 'new_tab': {
      const raw = typeof args.url === 'string' && args.url ? args.url : null
      const addr = raw ? resolveAddress(raw) : null
      const url = addr ? (addr.kind === 'url' ? addr.url : searchUrl(addr.query)) : undefined
      const tab = tabs.createTab(url)
      if (url) await cdp.waitForLoad(tab)
      const wc = tab.view.webContents
      return text(json({ tabId: tab.id, url: wc.getURL(), title: wc.getTitle() }))
    }

    case 'close_tab': {
      const id = Number(args.tabId)
      const ok = tabs.closeTab(id)
      return ok ? text(`closed tab ${id}`) : errorText(`no tab with id ${id}`)
    }

    case 'switch_tab': {
      const id = Number(args.tabId)
      if (!tabs.getTab(id)) return errorText(`no tab with id ${id}`)
      tabs.setActive(id)
      return text(`tab ${id} is now active and visible to the human`)
    }

    case 'navigate': {
      const tab = tabs.requireTab(args.tabId as number | undefined)
      const raw = String(args.url)
      const addr = resolveAddress(raw)
      const url = addr.kind === 'url' ? addr.url : searchUrl(addr.query)
      markAiActive(10000)
      overlaySend(tab, {
        kind: 'status',
        text:
          addr.kind === 'search'
            ? `AI 正在搜索 "${addr.query.slice(0, 30)}"`
            : `AI 正在打开 ${url.slice(0, 60)}`,
        hint: TAKEOVER_HINT,
        tone: 'busy',
        ttl: 4000
      })
      await cdp.sleep(350)
      if (operationSignal()?.aborted) return interruptedText()
      await tab.view.webContents.loadURL(url)
      const lr = await cdp.waitForLoad(tab)
      if (lr === 'interrupted') return interruptedText()
      const wc = tab.view.webContents
      return text(
        json({
          url: wc.getURL(),
          title: wc.getTitle(),
          loading: wc.isLoading(),
          ...(addr.kind === 'search' ? { searched: addr.query } : {})
        })
      )
    }

    case 'search': {
      const tab = tabs.requireTab(args.tabId as number | undefined)
      const query = String(args.query)
      const engine = typeof args.engine === 'string' ? args.engine : undefined
      const url = searchUrl(query, engine)
      markAiActive(10000)
      overlaySend(tab, {
        kind: 'status',
        text: `AI 正在搜索 "${query.slice(0, 30)}"`,
        hint: TAKEOVER_HINT,
        tone: 'busy',
        ttl: 4000
      })
      await cdp.sleep(350)
      if (operationSignal()?.aborted) return interruptedText()
      await tab.view.webContents.loadURL(url)
      const lr = await cdp.waitForLoad(tab)
      if (lr === 'interrupted') return interruptedText()
      const wc = tab.view.webContents
      return text(json({ searched: query, engine: engine ?? 'baidu', url: wc.getURL(), title: wc.getTitle() }))
    }

    case 'history': {
      const tab = tabs.requireTab(args.tabId as number | undefined)
      const action = String(args.action)
      const navLabel = action === 'back' ? '后退' : action === 'forward' ? '前进' : '刷新'
      markAiActive(8000)
      overlaySend(tab, {
        kind: 'status',
        text: `AI 正在${navLabel}页面`,
        hint: TAKEOVER_HINT,
        tone: 'busy',
        ttl: 2500
      })
      const nav = tab.view.webContents.navigationHistory
      if (action === 'back') {
        if (!nav.canGoBack()) return text('cannot go back (no history)')
        nav.goBack()
      } else if (action === 'forward') {
        if (!nav.canGoForward()) return text('cannot go forward (no history)')
        nav.goForward()
      } else if (action === 'reload') {
        tab.view.webContents.reload()
      } else {
        return errorText(`unknown action: ${action}`)
      }
      const lr = await cdp.waitForLoad(tab)
      if (lr === 'interrupted') return interruptedText()
      return text(json({ url: tab.view.webContents.getURL(), title: tab.view.webContents.getTitle() }))
    }

    case 'snapshot': {
      const tab = tabs.requireTab(args.tabId as number | undefined)
      const outline = await cdp.evalInPage<string>(tab, scripts.buildSnapshotScript())
      if (typeof outline !== 'string' || !outline) {
        return errorText('snapshot failed (empty page or script error)')
      }
      return text(outline)
    }

    case 'get_html': {
      const tab = tabs.requireTab(args.tabId as number | undefined)
      const selector = typeof args.selector === 'string' ? args.selector : undefined
      const max = Math.min(Math.max(Number(args.maxChars) || 40000, 1000), 200000)
      let html: string
      if (selector) {
        const r = await cdp.evalInPage<{ html?: string; error?: string }>(
          tab,
          scripts.buildOuterHtmlScript(selector)
        )
        if (r?.error) return errorText(r.error)
        html = r.html ?? ''
      } else {
        html = await cdp.evalInPage<string>(tab, scripts.buildCleanBodyHtmlScript())
      }
      if (typeof html !== 'string') return errorText('failed to read HTML')
      const total = html.length
      if (total > max) {
        html = html.slice(0, max) + `\n…(truncated, ${total - max} more chars; use selector to narrow down)`
      }
      return text(html)
    }

    case 'query': {
      const tab = tabs.requireTab(args.tabId as number | undefined)
      const selector = String(args.selector)
      const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100)
      const r = await cdp.evalInPage<{ error?: string }>(tab, scripts.buildQueryScript(selector, limit))
      if (r && (r as { error?: string }).error) return errorText((r as { error: string }).error)
      return text(json(r))
    }

    case 'screenshot': {
      const tab = tabs.requireTab(args.tabId as number | undefined)
      const fullPage = args.fullPage === true
      const size = await cdp.evalInPage<{ w: number; h: number; ph: number }>(
        tab,
        '({ w: innerWidth, h: innerHeight, ph: Math.round(document.documentElement.scrollHeight) })'
      )
      const data = await cdp.captureScreenshot(tab, fullPage)
      const label = fullPage
        ? `full-page screenshot (${size.w}px wide, ${size.ph}px tall)`
        : `viewport screenshot (${size.w}x${size.h})`
      return {
        content: [
          { type: 'text', text: label },
          { type: 'image', data, mimeType: 'image/png' }
        ]
      }
    }

    case 'click': {
      const tab = tabs.requireTab(args.tabId as number | undefined)
      const target = String(args.target)
      const v = await visualizeTarget(tab, target, '点击')
      if ('error' in v) return errorText(v.error)
      if (operationSignal()?.aborted) return interruptedText()
      await cdp.clickAt(tab, v.r.x, v.r.y)
      overlaySend(tab, { kind: 'clickFx', x: v.r.x, y: v.r.y })
      // refresh the status bar as a completion state so it stays visible even
      // when a slow machine makes the click itself take several seconds
      overlaySend(tab, { kind: 'status', text: `AI 已点击 ${v.label}`, tone: 'info', ttl: 2400 })
      return text(
        json({ clicked: true, target, element: `${v.r.tag} "${v.r.text}"`, at: { x: v.r.x, y: v.r.y }, wasVisible: v.r.visible })
      )
    }

    case 'hover': {
      const tab = tabs.requireTab(args.tabId as number | undefined)
      const target = String(args.target)
      const v = await visualizeTarget(tab, target, '悬停')
      if ('error' in v) return errorText(v.error)
      await cdp.hoverAt(tab, v.r.x, v.r.y)
      return text(
        json({ hovered: true, target, element: `${v.r.tag} "${v.r.text}"`, at: { x: v.r.x, y: v.r.y } })
      )
    }

    case 'dblclick': {
      const tab = tabs.requireTab(args.tabId as number | undefined)
      const target = String(args.target)
      const v = await visualizeTarget(tab, target, '双击')
      if ('error' in v) return errorText(v.error)
      if (operationSignal()?.aborted) return interruptedText()
      await cdp.dblclickAt(tab, v.r.x, v.r.y)
      overlaySend(tab, { kind: 'clickFx', x: v.r.x, y: v.r.y })
      overlaySend(tab, { kind: 'status', text: `AI 已双击 ${v.label}`, tone: 'info', ttl: 2400 })
      return text(
        json({ doubleClicked: true, target, element: `${v.r.tag} "${v.r.text}"`, at: { x: v.r.x, y: v.r.y } })
      )
    }

    case 'drag': {
      const tab = tabs.requireTab(args.tabId as number | undefined)
      const from = String(args.from)
      const to = String(args.to)
      const r = await cdp.evalInPage<{
        error?: string
        from: {
          x: number
          y: number
          rect: { x: number; y: number; w: number; h: number }
          visible?: boolean
          tag: string
          text: string
        }
        to: {
          x: number
          y: number
          rect: { x: number; y: number; w: number; h: number }
          tag: string
          text: string
        }
      }>(tab, scripts.buildDragResolveScript(from, to))
      if (r?.error) return errorText(r.error)
      markAiActive(10000)
      overlaySend(tab, { kind: 'showCursor', x: r.from.x, y: r.from.y })
      overlaySend(tab, { kind: 'highlight', rect: r.from.rect })
      overlaySend(tab, {
        kind: 'status',
        text: `AI 正在拖拽 ${r.from.tag} → ${r.to.tag}`,
        hint: TAKEOVER_HINT,
        tone: 'busy',
        ttl: 3000
      })
      await interruptibleSleep(300)
      overlaySend(tab, { kind: 'highlight', rect: r.to.rect })
      await cdp.dragFromTo(tab, r.from.x, r.from.y, r.to.x, r.to.y)
      overlaySend(tab, { kind: 'clickFx', x: r.to.x, y: r.to.y })
      return text(
        json({
          dragged: true,
          from: { target: from, element: `${r.from.tag} "${r.from.text}"`, inViewport: r.from.visible !== false },
          to: { target: to, element: `${r.to.tag} "${r.to.text}"` },
          at: { x: r.to.x, y: r.to.y }
        })
      )
    }

    case 'select_option': {
      const tab = tabs.requireTab(args.tabId as number | undefined)
      const target = String(args.target)
      const option = String(args.option)
      const r = await cdp.evalInPage<{
        error?: string
        options?: string[]
        ok?: boolean
        selected?: { text: string; value: string; index: number }
        valueNow?: string
      }>(tab, scripts.buildSelectScript(target, option))
      if (r?.error) {
        return errorText(r.error + (r.options ? ' | available options: ' + r.options.join(' / ') : ''))
      }
      return text(json(r))
    }

    case 'upload': {
      const tab = tabs.requireTab(args.tabId as number | undefined)
      const target = String(args.target)
      const files = Array.isArray(args.files) ? args.files.map(String) : []
      if (files.length === 0) return errorText('files must be a non-empty array of absolute paths')
      const res = await cdp.setFileInputFiles(tab, target, files)
      if (!res.ok) return errorText(res.error ?? 'upload failed')
      return text(json({ uploaded: files.length, files, target }))
    }

    case 'type': {
      const tab = tabs.requireTab(args.tabId as number | undefined)
      const target = String(args.target)
      const value = String(args.text ?? '')
      const clear = args.clear !== false
      const submit = args.submit === true
      const f = await cdp.evalInPage<{
        error?: string
        field?: boolean
        tag: string
        text?: string
        rect?: { x: number; y: number; w: number; h: number }
        cx?: number
        cy?: number
      }>(tab, scripts.buildFocusScript(target, clear))
      if (f?.error) return errorText(f.error)
      const label = f.text ? `「${f.text.slice(0, 16)}」` : `<${f.tag}>`
      markAiActive(8000)
      if (f.cx != null && f.cy != null && f.rect) {
        overlaySend(tab, { kind: 'showCursor', x: f.cx, y: f.cy })
        overlaySend(tab, { kind: 'highlight', rect: f.rect })
      }
      overlaySend(tab, {
        kind: 'status',
        text: `AI 正在输入到 ${label}`,
        hint: TAKEOVER_HINT,
        tone: 'busy',
        ttl: 2200
      })
      await cdp.sleep(280)
      await cdp.insertText(tab, value)
      if (submit) await cdp.pressKey(tab, 'Enter')
      const read = await cdp.evalInPage<{ value?: string; length?: number; error?: string }>(
        tab,
        scripts.buildReadValueScript(target)
      )
      const actual = read?.value ?? ''
      const filled = f.field ? actual === value : actual.includes(value)
      return text(
        json({
          filled,
          target,
          length: value.length,
          actualNow: actual.slice(0, 120),
          submitted: submit,
          note: filled ? undefined : 'value read back differs from what was typed; the field may reject the input'
        })
      )
    }

    case 'press': {
      const tab = tabs.requireTab(args.tabId as number | undefined)
      const key = String(args.key)
      await cdp.pressKey(tab, key)
      return text(`pressed ${key}`)
    }

    case 'scroll': {
      const tab = tabs.requireTab(args.tabId as number | undefined)
      const selector = typeof args.selector === 'string' && args.selector ? args.selector : null
      const hasDx = args.dx != null
      const dy = Number(args.dy ?? (hasDx ? 0 : 600))
      const dx = Number(args.dx ?? 0)
      const dirText =
        dy > 0 ? '向下' : dy < 0 ? '向上' : dx > 0 ? '向右' : dx < 0 ? '向左' : '向下'
      markAiActive(5000)
      overlaySend(tab, {
        kind: 'status',
        text: selector ? `AI 正在滚动到 ${selector.slice(0, 40)}` : `AI 正在${dirText}滚动`,
        hint: TAKEOVER_HINT,
        tone: 'busy',
        ttl: 1600
      })
      const r = await cdp.evalInPage<{ error?: string }>(
        tab,
        scripts.buildScrollScript(selector, dy, dx)
      )
      if (r && (r as { error?: string }).error) return errorText((r as { error: string }).error)
      return text(json(r))
    }

    case 'annotation_mode': {
      const tab = tabs.requireTab(args.tabId as number | undefined)
      const active = args.active === true
      overlaySend(tab, { kind: 'annotationMode', active })
      overlaySend(tab, {
        kind: 'status',
        text: active ? '标注模式已开启：在页面上画框并提问（Esc 退出）' : '标注模式已关闭',
        tone: 'info',
        ttl: 2800
      })
      return text(json({ annotationMode: active }))
    }

    case 'evaluate': {
      const tab = tabs.requireTab(args.tabId as number | undefined)
      const script = String(args.script)
      const r = await cdp.evalInPage<unknown>(tab, `(async () => { ${script}\n })()`)
      if (r === undefined) {
        return text('returned undefined (write `return value` inside the script to get a result)')
      }
      return text(json(r))
    }

    case 'wait': {
      const tab = tabs.requireTab(args.tabId as number | undefined)
      const selector = typeof args.selector === 'string' && args.selector ? args.selector : null
      const wantedText = typeof args.text === 'string' && args.text ? args.text : null
      const timeout = Math.min(Math.max(Number(args.timeout) || 10000, 500), 30000)

      if (selector || wantedText) {
        const t0 = Date.now()
        const deadline = t0 + timeout
        while (Date.now() < deadline) {
          if (operationSignal()?.aborted) {
            return text(json({ found: false, interrupted: true, note: '等待被用户中断（Esc）' }))
          }
          const check = await cdp.evalInPage<boolean>(
            tab,
            selector
              ? `!!document.querySelector(${JSON.stringify(selector)})`
              : `!!document.body && document.body.innerText.includes(${JSON.stringify(wantedText)})`
          )
          if (check) {
            return text(
              json({ found: true, kind: selector ? 'selector' : 'text', value: selector ?? wantedText, waitedMs: Date.now() - t0 })
            )
          }
          await interruptibleSleep(300)
        }
        return text(json({ found: false, timeoutMs: timeout, note: 'timed out; page state did not change' }))
      }

      const ms = Math.min(Math.max(Number(args.ms) || 1000, 1), 30000)
      const t0 = Date.now()
      await interruptibleSleep(ms)
      return text(json({ waitedMs: Date.now() - t0, interrupted: operationSignal()?.aborted ?? false }))
    }

    case 'get_console': {
      const tab = tabs.requireTab(args.tabId as number | undefined)
      const limit = Math.min(Math.max(Number(args.limit) || 50, 1), 300)
      const clear = args.clear === true
      const logs = tab.logs.slice(-limit)
      if (clear) tab.logs.length = 0
      return text(
        json({
          count: logs.length,
          messages: logs.map((l) => ({
            level: l.level,
            text: l.message,
            ago: `${Math.round((Date.now() - l.ts) / 1000)}s ago`
          }))
        })
      )
    }

    default:
      return errorText(`unknown tool: ${name}`)
  }
}
