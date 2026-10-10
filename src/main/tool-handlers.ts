import type { Tab, TabManager } from './tabs'
import * as cdp from './cdp'
import * as scripts from './page-scripts'
import { markAiActive, overlaySend, takeoverHint } from './overlay'
import { operationSignal } from './interrupt'
import { performPageAction } from './playwright-browser'
import { resolveAddress } from '../shared/url'
import { DEFAULT_ENGINE, SEARCH_ENGINES, searchUrl } from '../shared/search'

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
const PAGE_TOOLS = new Set(['click', 'dblclick', 'hover', 'type', 'drag', 'select_option', 'upload', 'press', 'scroll', 'evaluate', 'screenshot', 'wait'])

function json(obj: unknown): string {
  try {
    return JSON.stringify(obj, null, 1) ?? String(obj)
  } catch {
    return String(obj)
  }
}

const interruptedText = (): ToolResult =>
  text(`操作已被用户中断（用户触发「${takeoverHint()}」接管了浏览器）。请等待用户的下一步指示，不要重试。`)

export function createToolExecutor(
  tabs: TabManager,
  opts?: { getSearchEngine?: () => string | undefined }
): ToolExecutor {
  return async (name, args) => {
    try {
      return await dispatch(tabs, name, args ?? {}, opts?.getSearchEngine)
    } catch (e) {
      return errorText(`Error in ${name}: ${(e as Error)?.message ?? String(e)}`)
    }
  }
}

async function dispatch(
  tabs: TabManager,
  name: string,
  args: Record<string, unknown>,
  getEngine?: () => string | undefined
): Promise<ToolResult> {
  if (PAGE_TOOLS.has(name)) {
    const tab = tabs.requireTab(args.tabId as number | undefined)
    markAiActive(5000)
    if (!['wait', 'screenshot', 'evaluate'].includes(name)) {
      overlaySend(tab, { kind: 'status', text: `AI 正在执行 ${name}`, hint: takeoverHint(), tone: 'busy', ttl: 2400 })
    }
    const result = await performPageAction(tab, name, args)
    if (name === 'screenshot') {
      return { content: [{ type: 'image', data: (result as { png: string }).png, mimeType: 'image/png' }] }
    }
    return text(result === undefined ? 'returned undefined' : json(result))
  }
  switch (name) {
    case 'list_tabs': {
      return text(json(tabs.list()))
    }

    case 'new_tab': {
      const raw = typeof args.url === 'string' && args.url ? args.url : null
      const addr = raw ? resolveAddress(raw) : null
      const url = addr
        ? addr.kind === 'url'
          ? addr.url
          : searchUrl(addr.query, getEngine?.())
        : undefined
      const tab = tabs.createTab(url, { background: true })
      let loadTimedOut = false
      if (url) loadTimedOut = (await cdp.waitForLoad(tab)) === 'timeout'
      const wc = tab.view.webContents
      return text(
        json({
          tabId: tab.id,
          url: wc.getURL(),
          title: wc.getTitle(),
          ...(loadTimedOut ? { note: '加载超时（15 秒），页面可能未加载完' } : {})
        })
      )
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
      const url = addr.kind === 'url' ? addr.url : searchUrl(addr.query, getEngine?.())
      markAiActive(10000)
      overlaySend(tab, {
        kind: 'status',
        text:
          addr.kind === 'search'
            ? `AI 正在搜索 "${addr.query.slice(0, 30)}"`
            : `AI 正在打开 ${url.slice(0, 60)}`,
        hint: takeoverHint(),
        tone: 'busy',
        ttl: 4000
      })
      await cdp.sleep(350)
      if (operationSignal()?.aborted) return interruptedText()
      const start = await cdp.loadUrlInterruptible(tab, url)
      if (start.kind === 'interrupted') return interruptedText()
      if (start.kind === 'error') return errorText(`navigation failed: ${start.message}`)
      const lr = await cdp.waitForLoad(tab)
      if (lr === 'interrupted') return interruptedText()
      const wc = tab.view.webContents
      return text(
        json({
          url: wc.getURL(),
          title: wc.getTitle(),
          loading: wc.isLoading(),
          ...(lr === 'timeout' ? { note: '加载超时（15 秒），页面可能未加载完' } : {}),
          ...(addr.kind === 'search' ? { searched: addr.query } : {})
        })
      )
    }

    case 'search': {
      const tab = tabs.requireTab(args.tabId as number | undefined)
      const query = String(args.query)
      const requested = typeof args.engine === 'string' ? args.engine : undefined
      const engine = (requested && requested in SEARCH_ENGINES ? requested : getEngine?.()) ?? DEFAULT_ENGINE
      const realEngine = engine in SEARCH_ENGINES ? engine : DEFAULT_ENGINE
      const url = searchUrl(query, realEngine)
      markAiActive(10000)
      overlaySend(tab, {
        kind: 'status',
        text: `AI 正在搜索 "${query.slice(0, 30)}"`,
        hint: takeoverHint(),
        tone: 'busy',
        ttl: 4000
      })
      await cdp.sleep(350)
      if (operationSignal()?.aborted) return interruptedText()
      const start = await cdp.loadUrlInterruptible(tab, url)
      if (start.kind === 'interrupted') return interruptedText()
      if (start.kind === 'error') return errorText(`navigation failed: ${start.message}`)
      const lr = await cdp.waitForLoad(tab)
      if (lr === 'interrupted') return interruptedText()
      const wc = tab.view.webContents
      return text(
        json({
          searched: query,
          engine: realEngine,
          url: wc.getURL(),
          title: wc.getTitle(),
          ...(lr === 'timeout' ? { note: '加载超时（15 秒），页面可能未加载完' } : {})
        })
      )
    }

    case 'history': {
      const tab = tabs.requireTab(args.tabId as number | undefined)
      const action = String(args.action)
      const navLabel = action === 'back' ? '后退' : action === 'forward' ? '前进' : '刷新'
      markAiActive(8000)
      overlaySend(tab, {
        kind: 'status',
        text: `AI 正在${navLabel}页面`,
        hint: takeoverHint(),
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
      return text(
        json({
          url: tab.view.webContents.getURL(),
          title: tab.view.webContents.getTitle(),
          ...(lr === 'timeout' ? { note: '加载超时（15 秒），页面可能未加载完' } : {})
        })
      )
    }

    case 'snapshot': {
      const tab = tabs.requireTab(args.tabId as number | undefined)
      let outline: string | null = null
      let evalError: string | null = null
      try {
        const r = await cdp.evalInPage<string>(tab, scripts.buildSnapshotScript())
        if (typeof r === 'string' && r) outline = r
      } catch (e) {
        evalError = (e as Error)?.message ?? String(e)
      }
      if (outline) return text(outline)
      // Distinguish the usual causes as far as possible: page script blocked
      // (CSP / cross-origin frame) vs. simply no document body yet.
      const page = await cdp
        .evalInPage<{ hasBody?: boolean; url?: string; readyState?: string }>(
          tab,
          '({ hasBody: !!document.body, url: location.href, readyState: document.readyState })'
        )
        .catch(() => null)
      if (evalError) {
        const bodyHint =
          page?.hasBody === false
            ? '当前页面还没有文档内容（body 不存在），'
            : ''
        return errorText(
          `snapshot 失败：${bodyHint}页面脚本执行被拒绝（可能是 CSP 限制、页面尚未就绪或位于跨域 iframe）。底层错误：${evalError}`
        )
      }
      if (page?.hasBody === false) {
        return errorText(
          `snapshot 失败：页面为空（${page.url ?? ''}，readyState=${page.readyState ?? '?'}），没有可读取的文档结构。请先 navigate 打开页面或用 wait 等待加载。`
        )
      }
      return errorText(
        'snapshot 失败：未取得页面结构（页面可能仍在加载或内容全部不可见）。可先用 wait 等待元素出现，再重试 snapshot。'
      )
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
