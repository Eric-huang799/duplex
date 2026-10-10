/**
 * Duplex overlay preload — injected into every web page (WebContentsView).
 *
 * Two duties:
 * 1. AI action visualization (cursor, target highlight, status bar) and
 *    user takeover reporting (Esc / status-bar click).
 * 2. Human annotation mode (P1b): draw boxes/circles/arrows, pick elements,
 *    continuous annotation with per-box undo (×), inline question card.
 *    Submitted annotations carry a code-layer anchor element so coordinates
 *    survive page scrolling.
 *
 * Blueprint: docs/blueprints/2026-09-27-p1-interaction-layer.md
 */
import { ipcRenderer } from 'electron'
import { matchesBinding, parseBinding } from '../shared/hotkeys'

const HOST_ID = '__cobrowse_overlay_host'
const FONT =
  "-apple-system, 'Segoe UI', 'Microsoft YaHei', system-ui, sans-serif"

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

type ToolKind = 'rect' | 'circle' | 'arrow' | 'point'

type OverlayCommand =
  | { kind: 'showCursor'; x: number; y: number; ttl?: number }
  | { kind: 'hideCursor' }
  | { kind: 'clickFx'; x: number; y: number }
  | { kind: 'highlight'; rect: Rect; label?: string; ttl?: number }
  | { kind: 'clearHighlight' }
  | { kind: 'status'; text: string; hint?: string; tone?: 'info' | 'busy' | 'error'; ttl?: number }
  | { kind: 'clearStatus' }
  | { kind: 'annotationMode'; active?: boolean }
  | {
      kind: 'annotationResult'
      annotationId: string
      ok: boolean
      error?: string
      warning?: string
      elementCount?: number
    }
  | { kind: 'hideAll' }

interface Nodes {
  host: HTMLElement
  root: ShadowRoot
  cursor: HTMLElement
  highlight: HTMLElement
  status: HTMLElement
  statusText: HTMLElement
  statusHint: HTMLElement
  statusSep: HTMLElement
  annotLayer: HTMLElement
  markersBox: HTMLElement
  draftBox: HTMLElement
  tools: HTMLElement
  card: HTMLElement
  cardInput: HTMLTextAreaElement
  pointHint: HTMLElement
}

interface MarkerState {
  id: string
  tool: ToolKind
  /** Document coordinates (clientX + scrollX); screen position = doc - current scroll. */
  rect: Rect
  el: HTMLElement
  submitted: boolean
  /** Arrow endpoints in document coordinates. */
  arrow?: { x1: number; y1: number; x2: number; y2: number }
  anchorEl: Element | null
  anchorDx: number
  anchorDy: number
  /** Question text kept when an unsubmitted card is dismissed (marker stays dashed). */
  pendingQuestion?: string
}

const TEMPLATE = `
<style>
  :host { all: initial; }
  * { box-sizing: border-box; }
  .cb-highlight {
    position: fixed;
    border-radius: 7px;
    border: 2px solid rgba(77, 163, 255, 0.9);
    background: rgba(77, 163, 255, 0.12);
    box-shadow: 0 0 0 4px rgba(77, 163, 255, 0.10), 0 0 26px 3px rgba(77, 163, 255, 0.22);
    opacity: 0;
    transition: opacity 200ms ease;
    pointer-events: none;
    z-index: 3;
  }
  .cb-highlight.visible { opacity: 1; }

  .cb-cursor {
    position: fixed;
    left: 0; top: 0;
    width: 22px; height: 22px;
    margin: -11px 0 0 -11px;
    border-radius: 50%;
    background: radial-gradient(circle, rgba(77,163,255,0.95) 0%, rgba(77,163,255,0.4) 55%, rgba(77,163,255,0) 72%);
    box-shadow: 0 0 18px 5px rgba(77,163,255,0.30);
    transform: translate(-100px, -100px);
    opacity: 0;
    transition: transform 280ms cubic-bezier(0.22, 0.61, 0.36, 1), opacity 180ms ease;
    will-change: transform, opacity;
    pointer-events: none;
    z-index: 4;
  }
  .cb-cursor.visible { opacity: 1; }
  .cb-cursor.clicking::after {
    content: '';
    position: absolute;
    inset: -7px;
    border-radius: 50%;
    border: 2px solid rgba(77, 163, 255, 0.85);
    animation: cb-ripple 520ms cubic-bezier(0.2, 0.6, 0.35, 1) forwards;
  }
  @keyframes cb-ripple {
    from { transform: scale(0.45); opacity: 1; }
    to   { transform: scale(2.1); opacity: 0; }
  }
  @keyframes cb-spin { to { transform: rotate(360deg); } }

  .cb-status {
    position: fixed;
    bottom: 26px;
    left: 50%;
    transform: translateX(-50%) translateY(10px);
    display: flex;
    align-items: center;
    gap: 9px;
    max-width: min(640px, calc(100vw - 48px));
    padding: 8px 16px;
    background: rgba(18, 24, 31, 0.86);
    border: 1px solid rgba(77, 163, 255, 0.22);
    border-radius: 999px;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
    color: #d7dde5;
    font: 12.5px/1.45 ${FONT};
    opacity: 0;
    pointer-events: none;
    transition: opacity 220ms ease, transform 220ms ease, bottom 220ms ease;
    white-space: nowrap;
    overflow: hidden;
    z-index: 5;
  }
  .cb-status.visible { opacity: 1; transform: translateX(-50%) translateY(0); pointer-events: auto; cursor: pointer; }
  .cb-status.shifted { bottom: 64px; }
  .cb-status.error { border-color: rgba(224, 108, 108, 0.55); }
  .cb-status.error .text { color: #f0a6a6; }
  .cb-status.success { border-color: rgba(84, 200, 120, 0.55); }
  .cb-status.success .text { color: #c9efd3; }
  .cb-status .spin {
    display: none;
    width: 11px; height: 11px;
    border: 2px solid rgba(232, 184, 75, 0.9);
    border-top-color: transparent;
    border-radius: 50%;
    animation: cb-spin 0.9s linear infinite;
    flex-shrink: 0;
  }
  .cb-status.busy .spin { display: inline-block; }
  .cb-status .text { overflow: hidden; text-overflow: ellipsis; }
  .cb-status .sep { color: #4a5560; }
  .cb-status .hint { color: #8a97a5; flex-shrink: 0; }

  /* ---- annotation layer ---- */
  .cb-annot-layer {
    position: fixed;
    inset: 0;
    display: none;
    pointer-events: none;
    cursor: crosshair;
    z-index: 6;
  }
  .cb-annot-layer.active { display: block; pointer-events: auto; }
  .cb-markers, .cb-draft { position: absolute; inset: 0; pointer-events: none; }

  .cb-marker, .cb-draft {
    position: fixed;
    pointer-events: none;
  }
  .cb-marker .shape, .cb-draft .shape {
    position: absolute;
    inset: 0;
    border: 2px solid rgba(77, 163, 255, 0.9);
    background: rgba(77, 163, 255, 0.10);
    border-radius: 6px;
  }
  .cb-marker.circle .shape, .cb-draft.circle .shape { border-radius: 50%; }
  .cb-marker.arrow .shape, .cb-draft.arrow .shape { border: none; background: none; }
  .cb-marker.arrow .shape svg, .cb-draft.arrow .shape svg { position: absolute; inset: 0; overflow: visible; }
  .cb-marker.submitted .shape {
    border-style: dashed;
    border-color: rgba(77, 163, 255, 0.45);
    background: rgba(77, 163, 255, 0.05);
  }
  /* unsubmitted marker left behind by a dismissed card: dashed, click to edit */
  .cb-marker.unsubmitted .shape {
    border-style: dashed;
    border-color: rgba(232, 184, 75, 0.60);
    background: rgba(232, 184, 75, 0.07);
  }
  .cb-marker.unsubmitted { pointer-events: auto; cursor: pointer; }
  .cb-marker .remove {
    position: absolute;
    left: -11px; top: -11px;
    width: 20px; height: 20px;
    border-radius: 50%;
    border: 1px solid rgba(255, 255, 255, 0.28);
    background: rgba(18, 24, 31, 0.92);
    color: #d7dde5;
    font: 13px/1 ${FONT};
    cursor: pointer;
    pointer-events: auto;
    padding: 0;
    display: flex; align-items: center; justify-content: center;
  }
  .cb-marker .remove:hover { background: #e06c6c; color: #fff; border-color: transparent; }

  .cb-point-hint {
    position: fixed;
    display: none;
    border: 2px solid rgba(77, 163, 255, 0.8);
    background: rgba(77, 163, 255, 0.08);
    border-radius: 4px;
    pointer-events: none;
    z-index: 6;
  }

  /* ---- tool picker: a small draggable option bar, not a panel ---- */
  .cb-annot-tools {
    position: fixed;
    bottom: 26px;
    left: 50%;
    transform: translateX(-50%);
    display: none;
    align-items: center;
    gap: 2px;
    padding: 4px;
    background: rgba(18, 24, 31, 0.86);
    border: 1px solid rgba(255, 255, 255, 0.10);
    border-radius: 10px;
    box-shadow: 0 8px 22px rgba(0, 0, 0, 0.30);
    z-index: 7;
    pointer-events: auto;
    cursor: grab;
  }
  .cb-annot-tools.visible { display: flex; }
  .cb-annot-tools.dragging { cursor: grabbing; }
  .cb-annot-tools.dragging .cb-tool { pointer-events: none; }
  .cb-tool {
    width: 28px;
    height: 28px;
    border: none;
    border-radius: 7px;
    background: transparent;
    color: #c4ced8;
    font: 13px/1 ${FONT};
    cursor: pointer;
    padding: 0;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .cb-tool:hover { background: rgba(255, 255, 255, 0.08); }
  .cb-tool.on { background: rgba(77, 163, 255, 0.30); color: #fff; }
  .cb-sep { width: 1px; height: 16px; background: rgba(255, 255, 255, 0.12); margin: 0 3px; }

  /* ---- question card ---- */
  .cb-annot-card {
    position: fixed;
    display: none;
    flex-direction: column;
    gap: 8px;
    padding: 10px;
    background: rgba(18, 24, 31, 0.96);
    border: 1px solid rgba(77, 163, 255, 0.30);
    border-radius: 12px;
    box-shadow: 0 14px 40px rgba(0, 0, 0, 0.5);
    z-index: 8;
    pointer-events: auto;
  }
  .cb-annot-card.visible { display: flex; }
  .cb-card-input {
    resize: none;
    border: 1px solid rgba(255, 255, 255, 0.14);
    border-radius: 8px;
    background: rgba(10, 14, 18, 0.85);
    color: #e8eef5;
    font: 13px/1.5 ${FONT};
    padding: 8px 10px;
    outline: none;
    min-height: 52px;
  }
  .cb-card-input:focus { border-color: rgba(77, 163, 255, 0.6); }
  .cb-card-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .cb-card-hint { color: #7d8b99; font: 11px/1.4 ${FONT}; }
  .cb-send {
    border: none;
    border-radius: 7px;
    background: #2b5c8f;
    color: #eaf2fb;
    font: 12.5px/1 ${FONT};
    padding: 7px 16px;
    cursor: pointer;
  }
  .cb-send:hover { background: #35699f; }
</style>
<div class="cb-highlight"></div>
<div class="cb-cursor"></div>
<div class="cb-status" role="status">
  <span class="spin"></span>
  <span class="text"></span>
  <span class="sep">·</span>
  <span class="hint"></span>
</div>
<div class="cb-annot-layer">
  <div class="cb-markers"></div>
  <div class="cb-draft"></div>
</div>
<div class="cb-point-hint"></div>
<div class="cb-annot-tools" title="工具选择（可拖动）">
  <button class="cb-tool on" data-tool="rect" title="框选 (1)">◻</button>
  <button class="cb-tool" data-tool="circle" title="圈选 (2)">◯</button>
  <button class="cb-tool" data-tool="arrow" title="箭头 (3)">↗</button>
  <button class="cb-tool" data-tool="point" title="点选 (4)">⌖</button>
  <span class="cb-sep"></span>
  <button class="cb-tool" data-act="clear" title="清空全部标注">🗑</button>
  <button class="cb-tool" data-act="exit" title="退出标注模式 (Esc)">✕</button>
</div>
<div class="cb-annot-card">
  <textarea class="cb-card-input" rows="2" placeholder="对这块提问…（可留空，Enter 发送）"></textarea>
  <div class="cb-card-row">
    <span class="cb-card-hint">Enter 发送 · Esc 收起卡片（标注保留）</span>
    <button class="cb-send">发送</button>
  </div>
</div>
`

let nodes: Nodes | null = null
let cursorShown = false
let hotkeys: string[] = []
const timers: Record<'cursor' | 'highlight' | 'status', ReturnType<typeof setTimeout> | null> = {
  cursor: null,
  highlight: null,
  status: null
}

// ---- annotation state ----
let annotActive = false
let annotTool: ToolKind = 'rect'
let annotSeq = 0
const markers = new Map<string, MarkerState>()
let draft: {
  tool: ToolKind
  x0: number
  y0: number
  x1: number
  y1: number
  el: HTMLElement
} | null = null
let cardFor: string | null = null
let pointStart: { x: number; y: number } | null = null
let pointRaf = 0
let pointLast: { x: number; y: number } | null = null

function clearTimer(key: 'cursor' | 'highlight' | 'status'): void {
  if (timers[key]) {
    clearTimeout(timers[key])
    timers[key] = null
  }
}

function armTimer(
  key: 'cursor' | 'highlight' | 'status',
  ttl: number | undefined,
  fn: () => void
): void {
  clearTimer(key)
  if (ttl && ttl > 0) timers[key] = setTimeout(fn, ttl)
}

/** True when the key event originates from a text editor (input/textarea/contenteditable). */
function isEditableEventTarget(e: Event): boolean {
  const path = typeof e.composedPath === 'function' ? e.composedPath() : []
  const t = (path[0] ?? e.target) as HTMLElement | null
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
}

/** True when the binding carries Ctrl/Alt/Shift/Meta (a combo, as opposed to a bare key). */
function bindingHasModifier(binding: string): boolean {
  const parsed = parseBinding(binding)
  return !!parsed && (parsed.ctrl || parsed.alt || parsed.shift || parsed.meta)
}

function setup(): void {
  if (!document.body || document.getElementById(HOST_ID)) return
  document.documentElement.setAttribute('data-duplex-document', globalThis.crypto.randomUUID())
  const host = document.createElement('div')
  host.id = HOST_ID
  host.style.cssText =
    'position:fixed;inset:0;pointer-events:none;z-index:2147483647;contain:layout style;'
  document.body.appendChild(host)

  const root = host.attachShadow({ mode: 'open' })
  root.innerHTML = TEMPLATE

  const cursor = root.querySelector('.cb-cursor') as HTMLElement
  const highlight = root.querySelector('.cb-highlight') as HTMLElement
  const status = root.querySelector('.cb-status') as HTMLElement
  const statusText = status.querySelector('.text') as HTMLElement
  const statusHint = status.querySelector('.hint') as HTMLElement
  const statusSep = status.querySelector('.sep') as HTMLElement
  const annotLayer = root.querySelector('.cb-annot-layer') as HTMLElement
  const markersBox = root.querySelector('.cb-markers') as HTMLElement
  const draftBox = root.querySelector('.cb-draft') as HTMLElement
  const tools = root.querySelector('.cb-annot-tools') as HTMLElement
  const card = root.querySelector('.cb-annot-card') as HTMLElement
  const cardInput = root.querySelector('.cb-card-input') as HTMLTextAreaElement
  const pointHint = root.querySelector('.cb-point-hint') as HTMLElement

  nodes = {
    host,
    root,
    cursor,
    highlight,
    status,
    statusText,
    statusHint,
    statusSep,
    annotLayer,
    markersBox,
    draftBox,
    tools,
    card,
    cardInput,
    pointHint
  }

  status.addEventListener('click', () => {
    ipcRenderer.send('overlay:event', { kind: 'takeover', via: 'statusClick' })
  })

  tools.querySelectorAll('button[data-tool]').forEach((b) => {
    b.addEventListener('click', () => {
      setAnnotTool((b.getAttribute('data-tool') ?? 'rect') as ToolKind)
    })
  })
  tools.querySelector('button[data-act="clear"]')?.addEventListener('click', () => {
    clearMarkers()
  })
  tools.querySelector('button[data-act="exit"]')?.addEventListener('click', () => {
    setAnnotationActive(false)
  })

  // ---- draggable tool picker ----
  // The whole bar is draggable: a move > 5px starts a drag, a simple click
  // still selects a tool. While dragging, buttons become click-transparent so
  // no stray click fires on mouse-up. It is also its own hit layer, so clicks
  // never fall through to the drawing layer below.
  tools.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return
    e.preventDefault()
    const rect = tools.getBoundingClientRect()
    const startX = e.clientX
    const startY = e.clientY
    let dragging = false
    let grabDx = 0
    let grabDy = 0
    const onMove = (ev: MouseEvent): void => {
      if (!dragging) {
        if (Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) <= 5) return
        dragging = true
        tools.classList.add('dragging')
        tools.style.transform = 'none'
        tools.style.left = `${rect.left}px`
        tools.style.top = `${rect.top}px`
        grabDx = startX - rect.left
        grabDy = startY - rect.top
      }
      const x = Math.min(
        Math.max(ev.clientX - grabDx, 8),
        window.innerWidth - tools.offsetWidth - 8
      )
      const y = Math.min(
        Math.max(ev.clientY - grabDy, 8),
        window.innerHeight - tools.offsetHeight - 8
      )
      tools.style.left = `${x}px`
      tools.style.top = `${y}px`
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      if (dragging) {
        tools.classList.remove('dragging')
        saveToolsPos()
      }
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  })
  restoreToolsPos()

  window.addEventListener('resize', () => {
    if (!nodes) return
    const t = nodes.tools
    if (t.style.transform === 'none' && t.style.left) {
      const r = t.getBoundingClientRect()
      if (r.right > window.innerWidth) {
        t.style.left = `${Math.max(8, window.innerWidth - r.width - 8)}px`
      }
      if (r.bottom > window.innerHeight) {
        t.style.top = `${Math.max(8, window.innerHeight - r.height - 8)}px`
      }
    }
  })

  card.querySelector('.cb-send')?.addEventListener('click', () => submitCard())
  cardInput.addEventListener('keydown', (e) => {
    // Chinese IME: Enter confirms the candidate list — never submit on that
    if ((e as KeyboardEvent).isComposing || e.keyCode === 229) return
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submitCard()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      closeCard(true)
    }
  })

  annotLayer.addEventListener('mousedown', onAnnotDown)
  window.addEventListener('mousemove', onAnnotMove)
  window.addEventListener('mouseup', onAnnotUp)
  window.addEventListener('scroll', onWindowScroll, { passive: true })
  window.addEventListener('blur', onWindowBlur)
  installHumanActivity()

  window.addEventListener(
    'keydown',
    (e) => {
      // Esc only resolves the local annotation flow; emergency stop is driven
      // exclusively by the configured hotkeys below.
      if (e.key === 'Escape') {
        if (cardFor) {
          e.preventDefault()
          e.stopPropagation()
          closeCard(true)
          return
        }
        if (annotActive) {
          e.preventDefault()
          e.stopPropagation()
          setAnnotationActive(false)
          return
        }
      }
      // configurable emergency-stop hotkeys (single keys and combos): a bare
      // key is ignored while the page editor has focus so keys like F2 keep
      // working there; modifier combos always fire.
      if (hotkeys.length > 0) {
        const binding = hotkeys.find((b) => matchesBinding(b, e))
        if (binding && (!isEditableEventTarget(e) || bindingHasModifier(binding))) {
          e.preventDefault()
          e.stopPropagation()
          ipcRenderer.send('overlay:event', { kind: 'takeover', via: 'hotkey' })
          return
        }
      }
      // tool hotkeys 1-4 while annotating (not while typing, no ctrl/alt/meta)
      if (
        annotActive &&
        !cardFor &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.metaKey &&
        e.key >= '1' &&
        e.key <= '4'
      ) {
        if (!isEditableEventTarget(e)) {
          e.preventDefault()
          const map: ToolKind[] = ['rect', 'circle', 'arrow', 'point']
          setAnnotTool(map[Number(e.key) - 1])
        }
      }
    },
    true
  )

  ipcRenderer.on('overlay:cmd', (_e, cmd: OverlayCommand | { kind: 'hotkeys'; keys: string[] }) => {
    try {
      if ((cmd as { kind?: string })?.kind === 'hotkeys') {
        const keys = (cmd as { keys?: unknown }).keys
        hotkeys = Array.isArray(keys)
          ? keys.filter((k): k is string => typeof k === 'string' && k.length > 0)
          : []
        return
      }
      apply(cmd as OverlayCommand)
    } catch {
      /* visualization must never break the page */
    }
  })
}

// ============================ AI visualization ============================

function showCursor(x: number, y: number, ttl?: number): void {
  if (!nodes) return
  const { cursor } = nodes
  if (!cursorShown) {
    cursorShown = true
    cursor.style.transition = 'opacity 180ms ease'
    cursor.style.transform = `translate(${x}px, ${y}px)`
    void cursor.offsetWidth
    cursor.style.transition = ''
    requestAnimationFrame(() => cursor.classList.add('visible'))
  } else {
    cursor.classList.add('visible')
    cursor.style.transform = `translate(${x}px, ${y}px)`
  }
  armTimer('cursor', ttl ?? 3200, () => {
    cursor.classList.remove('visible')
    cursorShown = false
  })
}

function apply(cmd: OverlayCommand): void {
  if (!nodes) return
  const { cursor, highlight, status, statusText, statusHint, statusSep } = nodes

  switch (cmd.kind) {
    case 'showCursor': {
      showCursor(cmd.x, cmd.y, cmd.ttl)
      break
    }
    case 'hideCursor': {
      clearTimer('cursor')
      cursor.classList.remove('visible')
      cursorShown = false
      break
    }
    case 'clickFx': {
      showCursor(cmd.x, cmd.y)
      cursor.classList.remove('clicking')
      void cursor.offsetWidth
      cursor.classList.add('clicking')
      setTimeout(() => cursor.classList.remove('clicking'), 560)
      break
    }
    case 'highlight': {
      const { rect } = cmd
      highlight.style.left = `${rect.x}px`
      highlight.style.top = `${rect.y}px`
      highlight.style.width = `${rect.w}px`
      highlight.style.height = `${rect.h}px`
      highlight.classList.add('visible')
      armTimer('highlight', cmd.ttl ?? 1600, () => highlight.classList.remove('visible'))
      break
    }
    case 'clearHighlight': {
      clearTimer('highlight')
      highlight.classList.remove('visible')
      break
    }
    case 'status': {
      statusText.textContent = cmd.text
      statusHint.textContent = cmd.hint ?? ''
      statusSep.style.display = cmd.hint ? '' : 'none'
      status.classList.remove('busy', 'error', 'success', 'warn')
      status.style.borderColor = ''
      statusText.style.color = ''
      if (cmd.tone === 'busy') status.classList.add('busy')
      if (cmd.tone === 'error') status.classList.add('error')
      status.classList.add('visible')
      armTimer('status', cmd.ttl ?? 2000, () => status.classList.remove('visible'))
      break
    }
    case 'clearStatus': {
      clearTimer('status')
      status.classList.remove('visible')
      break
    }
    case 'annotationMode': {
      setAnnotationActive(cmd.active === undefined ? !annotActive : !!cmd.active)
      break
    }
    case 'annotationResult': {
      const warning = (cmd.warning ?? '').trim()
      if (cmd.ok) {
        const count = typeof cmd.elementCount === 'number' ? cmd.elementCount : null
        if (warning) {
          flashStatus(warning, {
            tone: 'warn',
            ttl: 4500,
            hint: count == null ? undefined : `${count} 个元素`
          })
        } else {
          flashStatus(count == null ? '已发送给 AI' : `已发送给 AI（${count} 个元素）`, {
            tone: 'success',
            ttl: 2500
          })
        }
      } else {
        const reason = (cmd.error ?? '').trim() || '发送失败'
        flashStatus(warning ? `${reason}（${warning}）` : reason, { tone: 'error', ttl: 4000 })
      }
      break
    }
    case 'hideAll': {
      clearTimer('cursor')
      clearTimer('highlight')
      clearTimer('status')
      cursor.classList.remove('visible')
      cursorShown = false
      highlight.classList.remove('visible')
      status.classList.remove('visible')
      break
    }
  }
}

// ============================ annotation mode ============================

/** The document attributes are shared with the main world despite context isolation. */
function installHumanActivity(): void {
  let lastScrollReport = 0
  const isOverlay = (event: Event): boolean => event.composedPath().some(node => node === nodes?.host)
  const report = (activity: 'scroll' | 'pointer' | 'key' | 'input'): void => {
    ipcRenderer.send('overlay:event', { kind: 'humanActivity', activity })
  }
  const scrolling = (event: Event): void => {
    if (!event.isTrusted || isOverlay(event)) return
    const until = Date.now() + 900
    ;(window as unknown as { __duplexHumanScrollingUntil: number }).__duplexHumanScrollingUntil = until
    document.documentElement.setAttribute('data-duplex-human-scroll-until', String(until))
    if (Date.now() - lastScrollReport >= 100) { lastScrollReport = Date.now(); report('scroll') }
  }
  window.addEventListener('wheel', scrolling, { capture: true, passive: true })
  window.addEventListener('touchmove', scrolling, { capture: true, passive: true })
  const aiEvent = (event: Event): boolean => {
    const raw = document.documentElement.getAttribute('data-duplex-ai-input')
    if (!raw) return false
    try {
        const marker = JSON.parse(raw) as { kind: string; target?: string; x?: number; y?: number; key?: string; keys?: string[]; text?: string }
      if (event instanceof PointerEvent && ['pointer', 'drag'].includes(marker.kind)) {
        if (marker.target) return event.composedPath().some(node => node instanceof Element && node.getAttribute('data-duplex-ai-target') === marker.target)
        return marker.x != null && marker.y != null && Math.abs(event.clientX - marker.x) < 4 && Math.abs(event.clientY - marker.y) < 4
      }
        const keys = marker.keys ?? (marker.key ? [marker.key] : [])
        if (event instanceof KeyboardEvent && marker.kind === 'key') return keys.includes(event.key)
        if (event instanceof InputEvent && marker.kind === 'key') return (event.data != null && keys.includes(event.data))
          || (keys.includes('Enter') && ['insertLineBreak', 'insertParagraph'].includes(event.inputType))
          || (keys.includes('Backspace') && event.inputType === 'deleteContentBackward')
          || (keys.includes('Delete') && event.inputType === 'deleteContentForward')
      if (event instanceof InputEvent && marker.kind === 'type') return event.data === marker.text
    } catch {}
    return false
  }
    const touches = new Map<number, { x: number; y: number; moved: boolean }>()
    window.addEventListener('pointerdown', event => {
      if (!event.isTrusted || isOverlay(event) || aiEvent(event)) return
      if (event.pointerType === 'touch') {
        touches.set(event.pointerId, { x: event.clientX, y: event.clientY, moved: false })
        scrolling(event)
      } else report('pointer')
  }, true)
    window.addEventListener('pointermove', event => {
      const start = touches.get(event.pointerId)
      if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8) start.moved = true
    }, true)
    window.addEventListener('pointerup', event => {
      const start = touches.get(event.pointerId)
      touches.delete(event.pointerId)
      if (start && !start.moved && !isOverlay(event)) report('pointer')
    }, true)
    window.addEventListener('pointercancel', event => touches.delete(event.pointerId), true)
  window.addEventListener('keydown', event => {
    if (event.isTrusted && !isOverlay(event) && !aiEvent(event)) report('key')
  }, true)
  window.addEventListener('input', event => {
    if (event.isTrusted && !isOverlay(event) && !aiEvent(event)) report('input')
  }, true)
}

function setAnnotationActive(active: boolean): void {
  const changed = annotActive !== active
  annotActive = active
  if (changed) ipcRenderer.send('overlay:event', { kind: 'annotationState', active })
  if (!nodes) return
  nodes.annotLayer.classList.toggle('active', active)
  nodes.tools.classList.toggle('visible', active)
  nodes.status.classList.toggle('shifted', active)
  if (active) {
    setAnnotTool(annotTool)
  } else {
    if (cardFor) closeCard(true)
    cancelPointFrame()
    if (draft) {
      draft.el.remove()
      draft = null
    }
    nodes.pointHint.style.display = 'none'
    pointStart = null
    let unsubmitted = 0
    for (const m of markers.values()) if (!m.submitted) unsubmitted++
    clearMarkers()
    if (unsubmitted > 0) {
      flashStatus(`已退出标注，${unsubmitted} 个未提交标注已清除`, { ttl: 3200 })
    }
  }
}

/** Local status message (not routed through the main-process command channel). */
function flashStatus(
  text: string,
  opts: { tone?: 'error' | 'success' | 'warn'; hint?: string; ttl: number }
): void {
  if (!nodes) return
  const { status, statusText, statusHint, statusSep } = nodes
  statusText.textContent = text
  statusHint.textContent = opts.hint ?? ''
  statusSep.style.display = opts.hint ? '' : 'none'
  status.classList.remove('busy', 'error', 'success', 'warn')
  status.style.borderColor = ''
  statusText.style.color = ''
  if (opts.tone) status.classList.add(opts.tone)
  if (opts.tone === 'warn') {
    status.style.borderColor = 'rgba(232, 184, 75, 0.55)'
    statusText.style.color = '#e8c97f'
  }
  status.classList.add('visible')
  armTimer('status', opts.ttl, () => status.classList.remove('visible'))
}

/** Remove every annotation marker (local Map + DOM). */
function clearMarkers(): void {
  if (!nodes) return
  cardFor = null
  nodes.card.classList.remove('visible')
  for (const m of markers.values()) m.el.remove()
  markers.clear()
}

function cancelPointFrame(): void {
  if (pointRaf) {
    cancelAnimationFrame(pointRaf)
    pointRaf = 0
  }
  pointLast = null
}

function setAnnotTool(t: ToolKind): void {
  annotTool = t
  if (!nodes) return
  nodes.tools.querySelectorAll('button[data-tool]').forEach((b) => {
    b.classList.toggle('on', b.getAttribute('data-tool') === t)
  })
  if (t !== 'point') nodes.pointHint.style.display = 'none'
}

function normRect(x0: number, y0: number, x1: number, y1: number): Rect {
  return {
    x: Math.round(Math.min(x0, x1)),
    y: Math.round(Math.min(y0, y1)),
    w: Math.round(Math.abs(x1 - x0)),
    h: Math.round(Math.abs(y1 - y0))
  }
}

/** Document-coordinate rect from client (viewport) corners. */
function docRect(x0: number, y0: number, x1: number, y1: number): Rect {
  const sx = window.scrollX
  const sy = window.scrollY
  return normRect(x0 + sx, y0 + sy, x1 + sx, y1 + sy)
}

/** Screen (viewport) rect of a marker, recomputed for the current scroll. */
function markerScreenRect(m: MarkerState): Rect {
  return {
    x: m.rect.x - window.scrollX,
    y: m.rect.y - window.scrollY,
    w: m.rect.w,
    h: m.rect.h
  }
}

function positionMarker(m: MarkerState): void {
  positionShape(m.el, markerScreenRect(m))
}

function onWindowScroll(): void {
  if (!nodes) return
  for (const m of markers.values()) positionMarker(m)
  if (cardFor) {
    const m = markers.get(cardFor)
    if (m) positionCard(m)
  }
}

/** Blur is the safety net for drafts that never saw their mouseup (released
 *  outside the window). */
function onWindowBlur(): void {
  if (draft) {
    draft.el.remove()
    draft = null
  }
  pointStart = null
  cancelPointFrame()
  if (nodes) nodes.pointHint.style.display = 'none'
}

/** Hit-test below the annotation layer (layer is temporarily click-transparent). */
function elementBelow(x: number, y: number): Element | null {
  if (!nodes) return null
  const layer = nodes.annotLayer
  const prev = layer.style.pointerEvents
  layer.style.pointerEvents = 'none'
  try {
    const list = document
      .elementsFromPoint(x, y)
      .filter(
        (el) => el && el !== nodes?.host && !nodes?.host.contains(el) && el !== document.documentElement
      )
    return list.length ? list[0] : null
  } finally {
    layer.style.pointerEvents = prev
  }
}

function positionShape(el: HTMLElement, rect: Rect): void {
  el.style.left = `${rect.x}px`
  el.style.top = `${rect.y}px`
  el.style.width = `${rect.w}px`
  el.style.height = `${rect.h}px`
}

function drawArrowSvg(
  container: HTMLElement,
  rect: Rect,
  arrow: { x1: number; y1: number; x2: number; y2: number }
): void {
  const ns = 'http://www.w3.org/2000/svg'
  const w = Math.max(1, rect.w)
  const h = Math.max(1, rect.h)
  const lx1 = arrow.x1 - rect.x
  const ly1 = arrow.y1 - rect.y
  const lx2 = arrow.x2 - rect.x
  const ly2 = arrow.y2 - rect.y
  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`)
  svg.setAttribute('width', String(w))
  svg.setAttribute('height', String(h))
  const line = document.createElementNS(ns, 'line')
  line.setAttribute('x1', String(lx1))
  line.setAttribute('y1', String(ly1))
  line.setAttribute('x2', String(lx2))
  line.setAttribute('y2', String(ly2))
  line.setAttribute('stroke', 'rgba(77,163,255,0.92)')
  line.setAttribute('stroke-width', '2.5')
  const ang = Math.atan2(ly2 - ly1, lx2 - lx1)
  const H = 13
  const hx1 = lx2 - H * Math.cos(ang - Math.PI / 6)
  const hy1 = ly2 - H * Math.sin(ang - Math.PI / 6)
  const hx2 = lx2 - H * Math.cos(ang + Math.PI / 6)
  const hy2 = ly2 - H * Math.sin(ang + Math.PI / 6)
  const head = document.createElementNS(ns, 'polygon')
  head.setAttribute(
    'points',
    [lx2, ly2, hx1, hy1, hx2, hy2]
      .map((n) => Math.round(n * 10) / 10)
      .join(' ')
  )
  head.setAttribute('fill', 'rgba(77,163,255,0.92)')
  svg.appendChild(line)
  svg.appendChild(head)
  container.appendChild(svg)
}

function createMarker(
  tool: ToolKind,
  rect: Rect,
  arrow?: { x1: number; y1: number; x2: number; y2: number }
): MarkerState {
  const id = `an${Date.now().toString(36)}-${++annotSeq}`
  const el = document.createElement('div')
  el.className = `cb-marker ${tool}`
  const shape = document.createElement('div')
  shape.className = 'shape'
  el.appendChild(shape)
  if (tool === 'arrow' && arrow) drawArrowSvg(shape, rect, arrow)

  const rm = document.createElement('button')
  rm.className = 'remove'
  rm.textContent = '×'
  rm.title = '撤销此标注'
  rm.addEventListener('mousedown', (ev) => ev.stopPropagation())
  rm.addEventListener('click', (ev) => {
    ev.stopPropagation()
    removeMarker(id, true)
  })
  el.appendChild(rm)

  // code-layer anchor: element under the rect center + offset from its box
  let anchorEl: Element | null = null
  try {
    anchorEl = elementBelow(
      rect.x - window.scrollX + rect.w / 2,
      rect.y - window.scrollY + rect.h / 2
    )
  } catch {
    anchorEl = null
  }
  const state: MarkerState = {
    id,
    tool,
    rect,
    el,
    submitted: false,
    arrow,
    anchorEl,
    anchorDx: 0,
    anchorDy: 0
  }
  if (anchorEl) {
    const ar = anchorEl.getBoundingClientRect()
    state.anchorDx = rect.x - (ar.x + window.scrollX)
    state.anchorDy = rect.y - (ar.y + window.scrollY)
  }
  el.addEventListener('mousedown', (ev) => ev.stopPropagation())
  el.addEventListener('click', (ev) => {
    ev.stopPropagation()
    if (!state.submitted) openCard(id)
  })
  nodes?.markersBox.appendChild(el)
  positionMarker(state)
  markers.set(id, state)
  return state
}

function removeMarker(id: string, notify: boolean): void {
  const m = markers.get(id)
  if (!m) return
  m.el.remove()
  markers.delete(id)
  if (cardFor === id) {
    cardFor = null
    nodes?.card.classList.remove('visible')
  }
  if (notify) ipcRenderer.send('overlay:event', { kind: 'annotationDismiss', annotationId: id })
}

function onAnnotDown(e: MouseEvent): void {
  if (!annotActive || e.button !== 0 || !nodes) return
  if (annotTool === 'point') {
    pointStart = { x: e.clientX, y: e.clientY }
    return
  }
  e.preventDefault()
  const el = document.createElement('div')
  el.className = `cb-draft ${annotTool}`
  el.innerHTML = '<div class="shape"></div>'
  nodes.draftBox.appendChild(el)
  draft = { tool: annotTool, x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY, el }
  updateDraft()
}

function updateDraft(): void {
  if (!draft) return
  const rect = normRect(draft.x0, draft.y0, draft.x1, draft.y1)
  positionShape(draft.el, rect)
  const shape = draft.el.querySelector('.shape') as HTMLElement | null
  if (draft.tool === 'arrow' && shape) {
    shape.innerHTML = ''
    drawArrowSvg(shape, rect, { x1: draft.x0, y1: draft.y0, x2: draft.x1, y2: draft.y1 })
  }
}

function onAnnotMove(e: MouseEvent): void {
  if (!annotActive || !nodes) return
  if (draft) {
    draft.x1 = e.clientX
    draft.y1 = e.clientY
    updateDraft()
    return
  }
  if (annotTool === 'point' && !cardFor) {
    pointLast = { x: e.clientX, y: e.clientY }
    if (pointRaf) return
    pointRaf = requestAnimationFrame(() => {
      pointRaf = 0
      const p = pointLast
      if (!p || !nodes || !annotActive || annotTool !== 'point' || cardFor) return
      const el = elementBelow(p.x, p.y)
      if (!el) {
        nodes.pointHint.style.display = 'none'
        return
      }
      const r = el.getBoundingClientRect()
      const hint = nodes.pointHint
      hint.style.display = 'block'
      hint.style.left = `${Math.round(r.x)}px`
      hint.style.top = `${Math.round(r.y)}px`
      hint.style.width = `${Math.round(r.width)}px`
      hint.style.height = `${Math.round(r.height)}px`
    })
  }
}

function onAnnotUp(e: MouseEvent): void {
  if (!annotActive || !nodes) return
  if (draft) {
    const d = draft
    draft = null
    d.el.remove()
    if (d.tool === 'arrow') {
      // An arrow is valid on endpoint distance alone: a vertical arrow's
      // bounding box can be narrower than 8px.
      if (Math.hypot(d.x1 - d.x0, d.y1 - d.y0) < 8) {
        flashStatus('框选太小，请拖大一点', { ttl: 2200 })
        return
      }
    } else {
      const viewport = normRect(d.x0, d.y0, d.x1, d.y1)
      if (viewport.w < 8 || viewport.h < 8) {
        flashStatus('框选太小，请拖大一点', { ttl: 2200 })
        return
      }
    }
    const rect = docRect(d.x0, d.y0, d.x1, d.y1)
    const arrow =
      d.tool === 'arrow'
        ? {
            x1: d.x0 + window.scrollX,
            y1: d.y0 + window.scrollY,
            x2: d.x1 + window.scrollX,
            y2: d.y1 + window.scrollY
          }
        : undefined
    const m = createMarker(d.tool, rect, arrow)
    openCard(m.id)
    return
  }
  if (annotTool === 'point' && pointStart) {
    const moved = Math.abs(e.clientX - pointStart.x) + Math.abs(e.clientY - pointStart.y)
    pointStart = null
    if (moved > 6) return
    const el = elementBelow(e.clientX, e.clientY)
    if (!el) return
    const r = el.getBoundingClientRect()
    if (r.width < 2 || r.height < 2) return
    const rect = {
      x: Math.round(r.x + window.scrollX),
      y: Math.round(r.y + window.scrollY),
      w: Math.round(r.width),
      h: Math.round(r.height)
    }
    const m = createMarker('point', rect)
    openCard(m.id)
  }
}

function positionCard(m: MarkerState): void {
  if (!nodes) return
  const card = nodes.card
  const width = Math.min(Math.max(m.rect.w, 300), 420)
  card.style.width = `${width}px`
  const screen = markerScreenRect(m)
  const left = Math.min(Math.max(screen.x, 12), window.innerWidth - width - 12)
  let top = screen.y + screen.h + 16
  const h = card.offsetHeight
  if (top + h > window.innerHeight - 12) top = Math.max(12, screen.y - h - 16)
  card.style.left = `${Math.max(12, left)}px`
  card.style.top = `${top}px`
}

function openCard(markerId: string): void {
  if (!nodes) return
  if (cardFor) closeCard(true)
  const m = markers.get(markerId)
  if (!m) return
  cardFor = markerId
  m.el.classList.remove('unsubmitted')
  nodes.cardInput.value = m.pendingQuestion ?? ''
  nodes.card.classList.add('visible')
  positionCard(m)
  setTimeout(() => nodes?.cardInput.focus(), 30)
}

function closeCard(cancel: boolean): void {
  if (!nodes) return
  if (cancel && cardFor) {
    const m = markers.get(cardFor)
    if (m && !m.submitted) {
      // Keep the dismissed annotation around (dashed) with its text: clicking
      // the marker reopens the card instead of silently dropping the work.
      m.pendingQuestion = nodes.cardInput.value.trim()
      m.el.classList.add('unsubmitted')
    }
  }
  cardFor = null
  nodes.card.classList.remove('visible')
}

function submitCard(): void {
  if (!nodes || !cardFor) return
  const id = cardFor
  const m = markers.get(id)
  if (!m) {
    closeCard(false)
    return
  }
  const question = nodes.cardInput.value.trim()
  // Sampling runs in viewport coordinates; markers live in document
  // coordinates, so convert back for the current scroll.
  const base = markerScreenRect(m)
  let rect: Rect = {
    x: Math.round(base.x),
    y: Math.round(base.y),
    w: m.rect.w,
    h: m.rect.h
  }
  let dx = 0
  let dy = 0
  // Anchor-corrected rect if the page scrolled since drawing.
  if (m.anchorEl && m.anchorEl.isConnected) {
    try {
      const ar = m.anchorEl.getBoundingClientRect()
      if (ar.width > 0 && ar.height > 0) {
        rect = {
          x: Math.round(ar.x + m.anchorDx),
          y: Math.round(ar.y + m.anchorDy),
          w: m.rect.w,
          h: m.rect.h
        }
        dx = rect.x - base.x
        dy = rect.y - base.y
      }
    } catch {
      /* keep original rect */
    }
  }
  const arrow = m.arrow
    ? {
        x1: Math.round(m.arrow.x1 - window.scrollX + dx),
        y1: Math.round(m.arrow.y1 - window.scrollY + dy),
        x2: Math.round(m.arrow.x2 - window.scrollX + dx),
        y2: Math.round(m.arrow.y2 - window.scrollY + dy)
      }
    : undefined
  ipcRenderer.send('overlay:event', {
    kind: 'annotationSubmit',
    documentURL: location.href,
    documentToken: document.documentElement.getAttribute('data-duplex-document'),
    annotationId: id,
    tool: m.tool,
    rect,
    question,
    arrow
  })
  m.submitted = true
  m.pendingQuestion = undefined
  m.el.classList.remove('unsubmitted')
  m.el.classList.add('submitted')
  cardFor = null
  nodes.card.classList.remove('visible')
}

// ============================== bootstrap ==============================

const TOOLS_POS_KEY = 'cobrowse-annot-tools-pos'

function saveToolsPos(): void {
  if (!nodes) return
  try {
    localStorage.setItem(
      TOOLS_POS_KEY,
      JSON.stringify({ left: nodes.tools.style.left, top: nodes.tools.style.top })
    )
  } catch {
    /* storage may be unavailable */
  }
}

function restoreToolsPos(): void {
  if (!nodes) return
  try {
    const raw = localStorage.getItem(TOOLS_POS_KEY)
    if (!raw) return
    const p = JSON.parse(raw) as { left?: string; top?: string }
    if (p && typeof p.left === 'string' && typeof p.top === 'string' && p.left && p.top) {
      nodes.tools.style.transform = 'none'
      nodes.tools.style.left = p.left
      nodes.tools.style.top = p.top
    }
  } catch {
    /* ignore */
  }
}

if (
  location.protocol === 'http:' ||
  location.protocol === 'https:' ||
  location.protocol === 'file:'
) {
  const boot = (): void => {
    setup()
    // send ready only after setup registered the overlay:cmd listener, otherwise
    // the hotkey-config reply from the main process is lost
    ipcRenderer.send('overlay:event', { kind: 'ready', url: location.href, documentURL: location.href, documentToken: document.documentElement.getAttribute('data-duplex-document') })
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true })
  } else {
    boot()
  }
}
