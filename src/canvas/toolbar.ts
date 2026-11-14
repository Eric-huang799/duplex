/**
 * 顶部工具栏：断点/宽度滑杆、模式按钮、撤销重做、提交本轮、导出、状态区。
 *
 * 工具栏只发意图（undo/redo/commit-round/export/viewport），文档由宿主改。
 */

import { el, on } from './dom'
import { activeBreakpoint, BREAKPOINTS, clampViewportWidth, formatPercent } from './geometry'
import type { OutboundMessage } from './host'
import type { CanvasMode } from './interact'

export interface ToolbarState {
  round: number | null
  dirty: boolean
  actor: string | null
}

export interface ToolbarDeps {
  root: HTMLElement
  send(message: OutboundMessage): void
  getViewportWidth(): number
  getZoom(): number
  getScale(): number
  onViewport(width: number, commit: boolean): void
  onLocateToggle(): void
  onMeasureToggle(): void
  onLoupeToggle(): void
  onZoomCycle(): void
  toast(text: string): void
}

export interface ToolbarHandle {
  setViewport(width: number, zoom: number, scale: number): void
  setState(state: ToolbarState | null): void
  setMode(mode: CanvasMode): void
  setLoupe(on: boolean): void
  setDemo(demo: boolean): void
  closeCommit(): boolean
  destroy(): void
}

export function createToolbar(deps: ToolbarDeps): ToolbarHandle {
  const disposers: Array<() => void> = []
  const breakpointButtons = new Map<string, HTMLButtonElement>()

  const brand = el('div', { className: 'toolbar__brand' })
  brand.append(
    el('span', { className: 'toolbar__logo', text: 'DUPLEX' }),
    el('span', { className: 'toolbar__title', text: '设计画布' }),
    el('span', { className: 'toolbar__demo-badge', text: '演示模式' })
  )
  const demoBadge = brand.querySelector<HTMLElement>('.toolbar__demo-badge')!

  // ── 响应式预览 ────────────────────────────────────────────────────────
  const viewportGroup = el('div', { className: 'toolbar__group toolbar__group--viewport' })
  viewportGroup.append(el('span', { className: 'toolbar__label', text: '视口' }))

  for (const breakpoint of BREAKPOINTS) {
    const button = el('button', {
      className: 'toolbar__btn toolbar__btn--breakpoint',
      attrs: {
        type: 'button',
        title: `${breakpoint.label} ${breakpoint.width}px`,
        'aria-pressed': 'false'
      }
    })
    button.append(
      el('span', { className: 'toolbar__btn-label', text: breakpoint.label }),
      el('span', { className: 'toolbar__btn-meta', text: String(breakpoint.width) })
    )
    disposers.push(on<MouseEvent>(button, 'click', () => deps.onViewport(breakpoint.width, true)))
    breakpointButtons.set(breakpoint.id, button)
    viewportGroup.append(button)
  }

  const slider = el('input', {
    className: 'toolbar__slider',
    attrs: {
      type: 'range',
      min: '320',
      max: '1920',
      step: '1',
      'aria-label': '画布宽度',
      title: '拖动调整预览宽度'
    }
  })
  const ticks = el('div', { className: 'toolbar__ticks' })
  for (const breakpoint of BREAKPOINTS) {
    const ratio = (breakpoint.width - 320) / (1920 - 320)
    const tick = el('span', {
      className: 'toolbar__tick',
      attrs: {
        title: `${breakpoint.label} ${breakpoint.width}px`,
        style: `left:${(ratio * 100).toFixed(2)}%`
      }
    })
    ticks.append(tick)
  }
  const sliderWrap = el('div', { className: 'toolbar__slider-wrap' })
  sliderWrap.append(slider, ticks)

  const readout = el('span', { className: 'toolbar__readout', text: '—' })
  viewportGroup.append(sliderWrap, readout)

  disposers.push(
    on<Event>(slider, 'input', () => {
      const width = clampViewportWidth(Number(slider.value))
      deps.onViewport(width, false)
    }),
    on<Event>(slider, 'change', () => {
      const width = clampViewportWidth(Number(slider.value))
      deps.onViewport(width, true)
    })
  )

  // ── 模式与工具 ──────────────────────────────────────────────────────
  const toolsGroup = el('div', { className: 'toolbar__group toolbar__group--tools' })

  function toolButton(label: string, hint: string, className = ''): HTMLButtonElement {
    const button = el('button', {
      className: `toolbar__btn toolbar__btn--tool ${className}`.trim(),
      attrs: { type: 'button', title: hint, 'aria-pressed': 'false' }
    })
    button.textContent = label
    toolsGroup.append(button)
    return button
  }

  const locateButton = toolButton('定位', '定位模式：点击页面任意位置（Esc 退出）')
  const measureButton = toolButton('测量', '测量模式：点两下量距离（R / Esc）')
  const loupeButton = toolButton('放大镜', '放大镜：跟随鼠标显示局部放大（M）')
  const zoomButton = toolButton('缩放 100%', '整体视图缩放 1:1 → 50% → 25%（Z）')
  const undoButton = toolButton('撤销', '撤销（发送给宿主计算）')
  const redoButton = toolButton('重做', '重做（发送给宿主计算）')

  disposers.push(
    on<MouseEvent>(locateButton, 'click', () => deps.onLocateToggle()),
    on<MouseEvent>(measureButton, 'click', () => deps.onMeasureToggle()),
    on<MouseEvent>(loupeButton, 'click', () => deps.onLoupeToggle()),
    on<MouseEvent>(zoomButton, 'click', () => deps.onZoomCycle()),
    on<MouseEvent>(undoButton, 'click', () => {
      deps.send({ type: 'undo' })
      deps.toast('已请求撤销（由宿主计算）')
    }),
    on<MouseEvent>(redoButton, 'click', () => {
      deps.send({ type: 'redo' })
      deps.toast('已请求重做（由宿主计算）')
    })
  )

  // ── 提交 / 导出 / 状态 ──────────────────────────────────────────────
  const actionsGroup = el('div', { className: 'toolbar__group toolbar__group--actions' })
  const commitButton = el('button', {
    className: 'toolbar__btn toolbar__btn--primary',
    text: '提交本轮',
    attrs: { type: 'button', title: '提交这一轮的改动，并写一句话摘要', 'aria-expanded': 'false' }
  })
  const exportButton = el('button', {
    className: 'toolbar__btn',
    text: '导出',
    attrs: { type: 'button', title: '导出设计文档（由宿主处理）' }
  })
  actionsGroup.append(commitButton, exportButton)

  const status = el('div', { className: 'toolbar__status' })
  status.append(
    el('span', { className: 'toolbar__status-dot' }),
    el('span', { className: 'toolbar__status-text', text: '第 — 轮 · 状态未知' })
  )
  const statusDot = status.querySelector<HTMLElement>('.toolbar__status-dot')!
  const statusText = status.querySelector<HTMLElement>('.toolbar__status-text')!

  // 提交摘要浮层
  const commitInput = el('input', {
    className: 'toolbar__commit-input',
    attrs: {
      type: 'text',
      maxlength: '120',
      placeholder: '一句话说明这一轮改了什么（可留空）',
      'aria-label': '本轮摘要'
    }
  })
  const commitConfirm = el('button', {
    className: 'toolbar__btn toolbar__btn--primary',
    text: '提交',
    attrs: { type: 'button' }
  })
  const commitCancel = el('button', {
    className: 'toolbar__btn',
    text: '取消',
    attrs: { type: 'button' }
  })
  const commitPanel = el('div', { className: 'toolbar__commit', attrs: { hidden: '' } })
  commitPanel.append(
    el('span', { className: 'toolbar__commit-label', text: '本轮摘要' }),
    commitInput,
    commitConfirm,
    commitCancel
  )

  deps.root.replaceChildren(
    brand,
    viewportGroup,
    toolsGroup,
    actionsGroup,
    status,
    commitPanel
  )

  let commitOpen = false

  function closeCommit(): boolean {
    if (!commitOpen) return false
    commitOpen = false
    commitPanel.hidden = true
    commitButton.setAttribute('aria-expanded', 'false')
    return true
  }

  function openCommit(): void {
    commitOpen = true
    commitPanel.hidden = false
    commitButton.setAttribute('aria-expanded', 'true')
    commitInput.value = ''
    window.setTimeout(() => commitInput.focus(), 0)
  }

  function submitCommit(): void {
    const summary = commitInput.value.trim() || '手动调整'
    deps.send({ type: 'commit-round', summary })
    deps.toast(`已提交：${summary}`)
    closeCommit()
  }

  disposers.push(
    on<MouseEvent>(commitButton, 'click', () => {
      if (commitOpen) {
        closeCommit()
        return
      }
      openCommit()
    }),
    on<MouseEvent>(exportButton, 'click', () => {
      deps.send({ type: 'export' })
      deps.toast('已请求导出（由宿主处理）')
    }),
    on<MouseEvent>(commitConfirm, 'click', () => submitCommit()),
    on<MouseEvent>(commitCancel, 'click', () => closeCommit()),
    on<KeyboardEvent>(commitInput, 'keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        submitCommit()
      } else if (event.key === 'Escape') {
        event.preventDefault()
        closeCommit()
      }
    })
  )

  // ── 刷新接口 ────────────────────────────────────────────────────────
  function setViewport(width: number, zoom: number, scale: number): void {
    slider.value = String(width)
    const active = activeBreakpoint(width)
    for (const [id, button] of breakpointButtons) {
      const isActive = id === active
      button.classList.toggle('is-active', isActive)
      button.setAttribute('aria-pressed', isActive ? 'true' : 'false')
    }
    readout.textContent = `${width}px · ${formatPercent(scale)}`
    readout.title = `渲染宽度 ${width}px；适配缩放 ${formatPercent(scale)}（整体缩放 ${formatPercent(zoom)}）`
    zoomButton.textContent = `缩放 ${formatPercent(zoom)}`
  }

  function setState(state: ToolbarState | null): void {
    if (!state || state.round === null) {
      statusText.textContent = '第 — 轮 · 状态未知'
      statusDot.classList.remove('is-dirty')
      status.title = ''
      return
    }
    statusText.textContent = `第 ${state.round} 轮 · ${state.dirty ? '有未提交改动' : '已提交'}`
    statusDot.classList.toggle('is-dirty', state.dirty)
    status.title = state.actor ? `最近编辑：${state.actor}` : ''
  }

  function setMode(mode: CanvasMode): void {
    locateButton.classList.toggle('is-active', mode === 'locate')
    locateButton.setAttribute('aria-pressed', mode === 'locate' ? 'true' : 'false')
    measureButton.classList.toggle('is-active', mode === 'measure')
    measureButton.setAttribute('aria-pressed', mode === 'measure' ? 'true' : 'false')
  }

  function setLoupe(on: boolean): void {
    loupeButton.classList.toggle('is-active', on)
    loupeButton.setAttribute('aria-pressed', on ? 'true' : 'false')
  }

  function setDemo(demo: boolean): void {
    demoBadge.hidden = !demo
    demoBadge.title = demo
      ? '未检测到 window.canvasHost，使用内置演示宿主（按 V 触发变体对比）'
      : ''
  }

  function destroy(): void {
    for (const dispose of disposers) dispose()
    deps.root.replaceChildren()
  }

  // 初始状态
  setViewport(deps.getViewportWidth(), deps.getZoom(), deps.getScale())
  setMode('select')
  setLoupe(false)
  setDemo(false)
  setState(null)

  return { setViewport, setState, setMode, setLoupe, setDemo, closeCommit, destroy }
}
