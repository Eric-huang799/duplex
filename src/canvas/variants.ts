/**
 * 变体对比：宿主送来 `{ blockId, options }` 后在画布上方弹出并排预览，
 * 点击（或按 1/2/3）选择 → 只发 `variant-choose`，由宿主决定怎么合入文档。
 */

import type { DesignDocument, DesignNode } from '../shared/design/model'
import { el, on, setVisible } from './dom'
import type { OutboundMessage } from './host'
import { renderNodeInto } from './render'

const MAX_OPTIONS = 3
const PREVIEW_WIDTH = 300
const PREVIEW_MAX_HEIGHT = 320
const PREVIEW_MIN_HEIGHT = 120

export interface VariantsDeps {
  root: HTMLElement
  getDoc(): DesignDocument | null
  send(message: OutboundMessage): void
  onOpenChange(open: boolean): void
  toast(text: string): void
}

export interface VariantsHandle {
  show(blockId: string, options: DesignNode[]): void
  hide(): void
  isOpen(): boolean
  /** 键盘 1/2/3 调用；index 从 0 开始。 */
  choose(index: number): boolean
  destroy(): void
}

const LETTERS = ['A', 'B', 'C']

export function createVariants(deps: VariantsDeps): VariantsHandle {
  const disposers: Array<() => void> = []
  let open = false
  let blockId = ''
  let options: DesignNode[] = []
  let totalOptions = 0

  const root = deps.root
  root.classList.add('variants')
  root.hidden = true

  function hide(): void {
    if (!open) return
    open = false
    root.hidden = true
    root.replaceChildren()
    blockId = ''
    options = []
    totalOptions = 0
    deps.onOpenChange(false)
  }

  function choose(index: number): boolean {
    if (!open) return false
    if (index < 0 || index >= options.length) return false
    deps.send({ type: 'variant-choose', blockId, index })
    deps.toast(`已选择方案 ${LETTERS[index] ?? String(index + 1)}`)
    hide()
    return true
  }

  function show(nextBlockId: string, nextOptions: DesignNode[]): void {
    const doc = deps.getDoc()
    if (!doc) return
    if (!Array.isArray(nextOptions) || nextOptions.length === 0) {
      deps.toast('收到的变体列表为空，已忽略')
      return
    }
    blockId = nextBlockId
    totalOptions = nextOptions.length
    options = nextOptions.slice(0, MAX_OPTIONS)
    open = true
    root.hidden = false
    render(doc)
    deps.onOpenChange(true)
  }

  function render(doc: DesignDocument): void {
    const head = el('div', { className: 'variants__head' })
    const titles = el('div', { className: 'variants__titles' })
    titles.append(
      el('h2', { className: 'variants__title', text: '变体对比' }),
      el('span', {
        className: 'variants__subtitle',
        text: `${blockId} · 点击选择一个方案（1 / 2 / 3，Esc 取消）`
      })
    )
    head.append(
      titles,
      el('button', {
        className: 'variants__close',
        text: '✕',
        attrs: { type: 'button', title: '关闭（Esc）', 'aria-label': '关闭变体对比', 'data-action': 'close' }
      })
    )

    const grid = el('div', { className: 'variants__grid' })
    const frameWidth = doc.frame.width > 0 ? doc.frame.width : 1440
    const scale = PREVIEW_WIDTH / frameWidth
    const stages: Array<{ stage: HTMLElement; surface: HTMLElement }> = []

    options.forEach((option, index) => {
      const card = el('div', {
        className: 'variants__card',
        attrs: {
          role: 'button',
          tabindex: '0',
          'data-index': String(index),
          'aria-label': `方案 ${LETTERS[index] ?? index + 1}`
        }
      })

      const stage = el('div', { className: 'variants__stage' })
      const surface = el('div', { className: 'variants__surface' })
      surface.style.width = `${frameWidth}px`
      surface.style.transform = `scale(${scale})`
      surface.style.transformOrigin = 'top left'
      stage.append(surface)
      stage.style.width = `${PREVIEW_WIDTH}px`
      stage.style.height = `${PREVIEW_MAX_HEIGHT}px`
      card.append(stage)

      const meta = el('div', { className: 'variants__meta' })
      meta.append(
        el('span', { className: 'variants__badge', text: LETTERS[index] ?? String(index + 1) }),
        el('span', { className: 'variants__meta-id', text: option.id }),
        el('span', { className: 'variants__meta-type', text: option.type })
      )
      card.append(meta)

      // 预览是真实渲染（同一套 token 与节点样式），只是不可交互
      renderNodeInto(option, doc, surface)
      stages.push({ stage, surface })
      grid.append(card)
    })

    root.replaceChildren(head, grid)
    if (totalOptions > options.length) {
      root.append(
        el('p', {
          className: 'variants__note',
          text: `共 ${totalOptions} 个方案，这里并排显示前 ${options.length} 个`
        })
      )
    }

    // 元素进入文档后再量高度（detached 元素的 offsetHeight 是 0）
    for (const { stage, surface } of stages) {
      const height = Math.min(
        PREVIEW_MAX_HEIGHT,
        Math.max(PREVIEW_MIN_HEIGHT, surface.offsetHeight * scale)
      )
      stage.style.height = `${height}px`
    }
  }

  function isOpen(): boolean {
    return open
  }

  // 事件委托：卡片/关闭按钮每次重建，监听只挂一次
  disposers.push(
    on<MouseEvent>(root, 'click', (event) => {
      const target = event.target as Element | null
      if (!target) return
      if (target.closest('[data-action="close"]')) {
        hide()
        return
      }
      const card = target.closest<HTMLElement>('[data-index]')
      if (card && root.contains(card)) choose(Number(card.dataset.index))
    }),
    on<KeyboardEvent>(root, 'keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      const card = (event.target as Element | null)?.closest<HTMLElement>('[data-index]')
      if (!card) return
      event.preventDefault()
      choose(Number(card.dataset.index))
    })
  )

  setVisible(root, false)

  function destroy(): void {
    for (const dispose of disposers) dispose()
    disposers.length = 0
    hide()
    root.replaceChildren()
  }

  return { show, hide, isOpen, choose, destroy }
}
