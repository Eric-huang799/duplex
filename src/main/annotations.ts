/**
 * Human annotation pipeline (P1b):
 * overlay draws a box -> submit -> sample DOM (code-layer anchoring) ->
 * structured markdown -> injection queue (delivered to the AI session) +
 * side-panel card event.
 */
import type { Tab, TabManager } from './tabs'
import * as cdp from './cdp'
import * as scripts from './page-scripts'
import type { MirrorStore } from './mirror'
import type { AnnotationTool } from '../shared/protocol'

export const ANNOTATION_TOOL_LABELS: Record<AnnotationTool, string> = {
  rect: '矩形框选',
  circle: '圈选',
  arrow: '箭头指向',
  point: '点选元素'
}

export interface AnnotateElementInfo {
  tag: string
  id?: string
  classes?: string[]
  role?: string
  text?: string
  href?: string
  placeholder?: string
  value?: string
  interactive: boolean
  hits: number
  selector: string
}

export interface AnnotateInfo {
  url: string
  title: string
  scroll: { x: number; y: number }
  viewport: { w: number; h: number }
  elements: AnnotateElementInfo[]
  primary: AnnotateElementInfo[]
  anchor: { selector: string; tag: string; text?: string } | null
  text: string
  points: Array<{ tag: string; el: AnnotateElementInfo | null }>
  /** Total distinct elements hit inside the box (before the sampling cap). */
  elementCount: number
  /** True when the hit list was capped and the returned element list is partial. */
  truncated?: boolean
}

/** One submitted annotation, ready for whichever downstream channel delivers it. */
export interface AnnotationDelivery {
  text: string
  question?: string
  tool: AnnotationTool
  url: string
  summary: string
  elementCount: number
  annotationId: string
}

export interface AnnotationSubmitPayload {
  annotationId: string
  tool: AnnotationTool
  rect: { x: number; y: number; w: number; h: number }
  question?: string
  arrow?: { x1: number; y1: number; x2: number; y2: number }
}

function fmtElementLine(el: AnnotateElementInfo): string {
  const parts: string[] = []
  let tag = `<${el.tag}${el.id ? '#' + el.id : ''}`
  if (el.classes?.length) tag += '.' + el.classes.slice(0, 2).join('.')
  tag += '>'
  parts.push(tag)
  if (el.role) parts.push(`role=${el.role}`)
  if (el.href) parts.push(`href="${el.href.slice(0, 80)}"`)
  if (el.placeholder) parts.push(`placeholder="${el.placeholder.slice(0, 40)}"`)
  if (el.value) parts.push(`value="${el.value.slice(0, 40)}"`)
  if (el.text) parts.push(`"${el.text.slice(0, 80)}"`)
  return `- ${parts.join(' ')}  ➜ ${el.selector}`
}

/** Build the markdown text injected into the AI session for one annotation. */
export function buildAnnotationText(
  info: AnnotateInfo,
  opts: { tool: AnnotationTool; question?: string }
): string {
  const lines: string[] = []
  lines.push(`【用户页面标注】${ANNOTATION_TOOL_LABELS[opts.tool] ?? opts.tool}`)
  lines.push(`页面: ${info.url}`)
  lines.push(`视口: ${info.viewport.w}×${info.viewport.h}，页面滚动: Y=${info.scroll.y}`)
  if (opts.question) lines.push(`用户问题: ${opts.question}`)

  if (opts.tool === 'arrow' && info.points.length === 2) {
    const [s, e] = info.points
    const fmtPoint = (p: { tag: string; el: AnnotateElementInfo | null }): string =>
      p.el
        ? `<${p.el.tag}${p.el.id ? '#' + p.el.id : ''}> "${(p.el.text ?? '').slice(0, 40)}" (${p.el.selector})`
        : '（空白处）'
    lines.push('')
    lines.push(`指向关系: 起点 ${fmtPoint(s)}  →  终点 ${fmtPoint(e)}`)
  }

  lines.push('')
  if (info.anchor) lines.push(`区域锚点: ${info.anchor.selector} <${info.anchor.tag}>`)
  // The element lists below are capped (and the sampler caps its hit list),
  // so state the truncation explicitly once the count exceeds what is shown.
  const listedPrimary = info.primary.length
  const truncated =
    info.truncated === true ||
    info.elementCount > info.elements.length ||
    info.elementCount > listedPrimary
  lines.push(
    `框内元素数: ${info.elementCount}` + (truncated ? `（仅列出前 ${listedPrimary} 个）` : '')
  )
  lines.push('')
  lines.push('框内主要元素（按可交互性/命中密度排序）:')
  for (const el of info.primary) lines.push(fmtElementLine(el))

  if (info.text) {
    lines.push('')
    lines.push('框内可见文本:')
    lines.push(info.text)
  }

  const interactive = info.elements.filter((e) => e.interactive).slice(0, 8)
  lines.push('')
  lines.push('机器可用信息:')
  if (interactive.length) {
    lines.push('- 可交互元素: ' + interactive.map((e) => e.selector).join(', '))
  }
  if (info.anchor) lines.push(`- 框锚 selector: ${info.anchor.selector}`)
  lines.push('- 提示: 可用 query / get_html(selector) 复查框内内容，再决定下一步操作。')
  return lines.join('\n')
}

export type AnnotationSubmitHandler = (
  payload: AnnotationSubmitPayload
) => Promise<{ ok: boolean; error?: string }>

export function createAnnotationSubmitHandler(
  tabs: TabManager,
  mirror: MirrorStore,
  deliver?: (d: AnnotationDelivery) => void
): AnnotationSubmitHandler {
  // Default (single-channel) delivery: injection queue for the AI session plus
  // the side-panel annotation card. A caller-supplied deliver takes over both.
  const defaultDeliver = (d: AnnotationDelivery): void => {
    mirror.addInjection(d.text, 'annotation')
    mirror.add({
      kind: 'annotation',
      annotationId: d.annotationId,
      text: d.text,
      question: d.question,
      tool: d.tool,
      url: d.url,
      summary: d.summary,
      elementCount: d.elementCount
    })
  }
  const deliverAnnotation = deliver ?? defaultDeliver
  return async (payload) => {
    const tab: Tab | null = tabs.getActive()
    if (!tab) return { ok: false, error: '没有活动的标签页（请先切换到一个网页）' }
    let info: AnnotateInfo
    try {
      const points =
        payload.tool === 'arrow' && payload.arrow
          ? [
              { x: payload.arrow.x1, y: payload.arrow.y1, tag: 'start' },
              { x: payload.arrow.x2, y: payload.arrow.y2, tag: 'end' }
            ]
          : undefined
      info = await cdp.evalInPage<AnnotateInfo>(
        tab,
        scripts.buildAnnotateScript(payload.rect, points)
      )
    } catch (e) {
      return { ok: false, error: (e as Error)?.message ?? String(e) }
    }
    if (!info || typeof info.url !== 'string') {
      return { ok: false, error: '标注采样失败（页面内容无法读取，可能受保护）' }
    }

    try {
      const question = (payload.question ?? '').trim()
      const text = buildAnnotationText(info, {
        tool: payload.tool,
        question: question || undefined
      })
      const summary =
        `${ANNOTATION_TOOL_LABELS[payload.tool] ?? payload.tool} · ${info.elementCount} 个元素` +
        (question ? ` · 「${question.slice(0, 40)}」` : '')
      deliverAnnotation({
        text,
        question: question || undefined,
        tool: payload.tool,
        url: info.url,
        summary,
        elementCount: info.elementCount,
        annotationId: payload.annotationId
      })
    } catch (e) {
      return { ok: false, error: (e as Error)?.message ?? String(e) }
    }
    return { ok: true }
  }
}
