/**
 * 右侧检视器：位置/尺寸（当前预览帧下的只读值 + 上下键微调）、
 * data-did、类型、文本、锁定开关、创建来源与相关约束。
 *
 * 所有修改都只发 `user-update` / `lock` 意图，**不改文档**——宿主负责转成约束/ patch。
 */

import {
  findNode,
  findParent,
  isLocked,
  type DesignDocument,
  type DesignNode,
  type Rect
} from '../shared/design/model'
import { el, on, setText } from './dom'
import { formatPx, nudgeNumber } from './geometry'
import type { OutboundMessage } from './host'

type FieldKey = 'x' | 'y' | 'width' | 'height'

const TYPE_LABELS: Record<DesignNode['type'], string> = {
  page: '页面',
  box: '区块',
  stack: '纵向堆叠',
  grid: '网格',
  text: '文本',
  heading: '标题',
  button: '按钮',
  input: '输入框',
  image: '图片',
  spacer: '间距'
}

const FIELD_LABELS: Record<FieldKey, string> = {
  x: 'X',
  y: 'Y',
  width: '宽',
  height: '高'
}

const CONSTRAINT_LABELS: Record<string, string> = {
  move: '移动',
  lock: '锁定',
  text: '文案',
  style: '样式',
  reflow: '重排'
}

export interface InspectorDeps {
  root: HTMLElement
  getDoc(): DesignDocument | null
  getSelectedId(): string | null
  getViewportWidth(): number
  measureLayoutRect(id: string): Rect | null
  send(message: OutboundMessage): void
  select(id: string | null): void
  toast(text: string): void
}

export interface InspectorHandle {
  refresh(): void
  destroy(): void
}

interface PendingNudge {
  id: string
  field: FieldKey
  value: number
  version: number
}

export function createInspector(deps: InspectorDeps): InspectorHandle {
  const disposers: Array<() => void> = []
  let pendingNudge: PendingNudge | null = null
  let pendingText: { id: string; value: string; version: number } | null = null
  let pendingLock: { id: string; locked: boolean; version: number } | null = null

  const root = deps.root
  root.classList.add('inspector')

  // ── 空状态 ──────────────────────────────────────────────────────────
  const empty = el('div', { className: 'inspector__empty' })
  empty.append(
    el('h2', { className: 'inspector__empty-title', text: '选择画布里的元素' }),
    el('p', {
      className: 'inspector__empty-text',
      text: '点击任意节点查看位置与尺寸；按住 ↑ / ↓（Shift ×10）微调，拖动节点移动位置。'
    }),
    el('ul', {
      className: 'inspector__shortcuts',
      children: [
        el('li', { text: 'M — 放大镜（坐标 / data-did / 尺寸 / 颜色）' }),
        el('li', { text: 'Z — 整体缩放 1:1 / 50% / 25%' }),
        el('li', { text: 'R — 测量尺，Esc 退出' }),
        el('li', { text: '定位 — 点页面元素取锚点' })
      ]
    })
  )

  // ── 内容 ────────────────────────────────────────────────────────────
  const content = el('div', { className: 'inspector__content', attrs: { hidden: '' } })

  const typeBadge = el('span', { className: 'inspector__badge inspector__badge--type', text: '—' })
  const lockButton = el('button', {
    className: 'inspector__lock',
    attrs: { type: 'button', role: 'switch', 'aria-checked': 'false', title: '锁定后 agent 的 patch 不会改动该节点（含子树）' }
  })
  const lockIcon = el('span', { className: 'inspector__lock-icon', text: '🔓' })
  const lockLabel = el('span', { className: 'inspector__lock-label', text: '未锁定' })
  lockButton.append(lockIcon, lockLabel)

  const didValue = el('code', { className: 'inspector__id-value', text: '—' })
  const header = el('header', { className: 'inspector__head' })
  header.append(typeBadge, lockButton)

  const didRow = el('div', { className: 'inspector__row' })
  didRow.append(el('span', { className: 'inspector__label', text: 'data-did' }), didValue)

  const breadcrumb = el('div', { className: 'inspector__breadcrumb' })

  const metaRow = el('div', { className: 'inspector__meta' })
  const metaText = el('span', { className: 'inspector__meta-text', text: '' })
  metaRow.append(metaText)

  const lockNote = el('p', { className: 'inspector__note', attrs: { hidden: '' } })

  // 四个数值字段
  const fieldsWrap = el('section', { className: 'inspector__section' })
  const fieldsHead = el('div', { className: 'inspector__section-head' })
  const fieldsTitle = el('h3', { className: 'inspector__section-title', text: '位置与尺寸' })
  const fieldsHint = el('span', { className: 'inspector__section-hint', text: '' })
  fieldsHead.append(fieldsTitle, fieldsHint)

  const fieldsGrid = el('div', { className: 'inspector__fields' })
  const fieldButtons = new Map<FieldKey, HTMLButtonElement>()
  const fieldValues = new Map<FieldKey, HTMLElement>()

  for (const key of ['x', 'y', 'width', 'height'] as FieldKey[]) {
    const button = el('button', {
      className: 'inspector__num',
      attrs: {
        type: 'button',
        role: 'spinbutton',
        title: `${FIELD_LABELS[key]}：↑ / ↓ 微调（Shift ×10），发送 user-update`,
        'aria-valuenow': '0'
      }
    })
    button.append(el('span', { className: 'inspector__num-label', text: FIELD_LABELS[key] }))
    const value = el('span', { className: 'inspector__num-value', text: '—' })
    button.append(value)
    disposers.push(
      on<KeyboardEvent>(button, 'keydown', (event) => {
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
        event.preventDefault()
        event.stopPropagation()
        nudgeField(key, event.key === 'ArrowUp' ? 1 : -1, event.shiftKey)
      })
    )
    fieldButtons.set(key, button)
    fieldValues.set(key, value)
    fieldsGrid.append(button)
  }
  fieldsWrap.append(fieldsHead, fieldsGrid)

  // 文本
  const textSection = el('section', { className: 'inspector__section' })
  const textTitle = el('h3', { className: 'inspector__section-title', text: '文本' })
  const textInput = el('input', {
    className: 'inspector__text',
    attrs: { type: 'text', placeholder: '该节点没有文本', 'aria-label': '节点文本' }
  })
  textSection.append(textTitle, textInput)

  // 约束
  const constraintSection = el('section', { className: 'inspector__section' })
  const constraintTitle = el('h3', { className: 'inspector__section-title', text: '相关约束' })
  const constraintList = el('ul', { className: 'inspector__constraints' })
  constraintSection.append(constraintTitle, constraintList)

  content.append(
    header,
    didRow,
    breadcrumb,
    metaRow,
    lockNote,
    fieldsWrap,
    textSection,
    constraintSection
  )
  root.replaceChildren(empty, content)

  // ── 事件 ────────────────────────────────────────────────────────────
  disposers.push(
    on<MouseEvent>(lockButton, 'click', () => {
      const doc = deps.getDoc()
      const id = deps.getSelectedId()
      if (!doc || !id) return
      const node = findNode(doc.root, id)
      if (!node) return
      if (!node.meta?.locked && isLocked(doc.root, id)) {
        deps.toast('父级已锁定，需先解锁父级')
        return
      }
      const nextLocked = !(node.meta?.locked === true)
      pendingLock = { id, locked: nextLocked, version: doc.version }
      deps.send({ type: 'lock', id, locked: nextLocked })
      deps.toast(nextLocked ? '已请求锁定（由宿主写入 meta.locked）' : '已请求解锁')
      refresh()
    }),
    on<Event>(textInput, 'change', () => commitText()),
    on<KeyboardEvent>(textInput, 'keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        commitText()
      } else if (event.key === 'Escape') {
        event.preventDefault()
        textInput.blur()
        pendingText = null
        refresh()
      }
      event.stopPropagation()
    }),
    on<FocusEvent>(textInput, 'blur', () => commitText()),
    // 面包屑用事件委托：每次刷新重建 DOM，但监听只挂一次
    on<MouseEvent>(breadcrumb, 'click', (event) => {
      const target = (event.target as Element | null)?.closest<HTMLElement>('[data-id]')
      if (!target || !breadcrumb.contains(target)) return
      const nextId = target.dataset.id
      if (nextId) deps.select(nextId)
    })
  )

  function commitText(): void {
    const doc = deps.getDoc()
    const id = deps.getSelectedId()
    if (!doc || !id) return
    const node = findNode(doc.root, id)
    if (!node) return
    if (node.type === 'spacer') {
      deps.toast('间距节点没有文本')
      return
    }
    const value = textInput.value
    if (value === (node.text ?? '')) return
    if (pendingText && pendingText.id === id && pendingText.value === value) return
    pendingText = { id, value, version: doc.version }
    deps.send({
      type: 'user-update',
      id,
      patch: { text: value, frameWidth: deps.getViewportWidth() }
    })
    deps.toast('已发送文本修改（由宿主转换）')
  }

  function nudgeField(field: FieldKey, direction: 1 | -1, shift: boolean): void {
    const doc = deps.getDoc()
    const id = deps.getSelectedId()
    if (!doc || !id) return
    const rect = deps.measureLayoutRect(id)
    if (!rect) return
    const current = Math.round(rect[field])
    const min = field === 'width' || field === 'height' ? 1 : Number.NEGATIVE_INFINITY
    const next = Math.round(nudgeNumber(current, direction, shift ? 10 : 1, min))
    if (next === current) return
    pendingNudge = { id, field, value: next, version: doc.version }
    deps.send({
      type: 'user-update',
      id,
      patch: { [field]: next, frameWidth: deps.getViewportWidth() }
    })
    deps.toast(`${FIELD_LABELS[field]} ${next}px（已发送给宿主）`)
    refresh()
  }

  // ── 刷新 ────────────────────────────────────────────────────────────
  function refresh(): void {
    const doc = deps.getDoc()
    const id = deps.getSelectedId()
    const node = doc && id ? findNode(doc.root, id) : null

    if (!doc || !id || !node) {
      empty.hidden = false
      content.hidden = true
      pendingNudge = null
      pendingText = null
      pendingLock = null
      return
    }

    empty.hidden = true
    content.hidden = false

    // 过期乐观值：文档版本变了说明宿主已回应，清掉
    if (pendingNudge && (pendingNudge.id !== id || pendingNudge.version !== doc.version)) {
      pendingNudge = null
    }
    if (pendingText && (pendingText.id !== id || pendingText.version !== doc.version)) {
      pendingText = null
    }
    if (pendingLock && (pendingLock.id !== id || pendingLock.version !== doc.version)) {
      pendingLock = null
    }

    setText(typeBadge, TYPE_LABELS[node.type] ?? node.type)
    setText(didValue, node.id)

    const inheritedLock = !node.meta?.locked && isLocked(doc.root, id)
    const locked = pendingLock?.id === id ? pendingLock.locked : node.meta?.locked === true
    lockButton.classList.toggle('is-locked', locked)
    lockButton.setAttribute('aria-checked', locked ? 'true' : 'false')
    lockButton.setAttribute('aria-disabled', inheritedLock ? 'true' : 'false')
    lockButton.classList.toggle('is-inherited', inheritedLock)
    setText(lockIcon, locked ? '🔒' : '🔓')
    setText(lockLabel, locked ? '已锁定' : '未锁定')
    setText(lockNote, inheritedLock ? '父级容器已锁定：agent 的 patch 不会触碰该子树。' : '')
    lockNote.hidden = !inheritedLock

    // 面包屑
    const ancestors: DesignNode[] = []
    let cursor: DesignNode | null = node
    while (cursor && cursor.id !== doc.root.id) {
      const found = findParent(doc.root, cursor.id)
      if (!found) break
      ancestors.unshift(found.parent)
      cursor = found.parent
    }
    breadcrumb.replaceChildren()
    for (const ancestor of ancestors) {
      breadcrumb.append(
        el('button', {
          className: 'inspector__crumb',
          text: ancestor.id,
          attrs: { type: 'button', title: `选中 ${ancestor.id}`, 'data-id': ancestor.id }
        }),
        el('span', { className: 'inspector__crumb-sep', text: '/' })
      )
    }
    breadcrumb.append(el('span', { className: 'inspector__crumb inspector__crumb--current', text: node.id }))

    const createdBy = node.meta?.createdBy
    const metaParts: string[] = []
    if (createdBy) metaParts.push(`由 ${createdBy.actor} 创建（第 ${createdBy.step} 步）`)
    if (node.meta?.editedByUser) metaParts.push('你改过')
    if (node.meta?.locked) metaParts.push('已锁定')
    setText(metaText, metaParts.join(' · ') || '没有来源信息')
    metaRow.hidden = metaParts.length === 0

    // 数值字段
    const rect = deps.measureLayoutRect(id)
    setText(fieldsHint, `frame ${deps.getViewportWidth()}px`)
    for (const key of ['x', 'y', 'width', 'height'] as FieldKey[]) {
      const button = fieldButtons.get(key)!
      const valueEl = fieldValues.get(key)!
      if (!rect) {
        setText(valueEl, '—')
        button.disabled = true
        continue
      }
      button.disabled = false
      const raw = pendingNudge?.id === id && pendingNudge.field === key ? pendingNudge.value : rect[key]
      const rounded = Math.round(raw)
      setText(valueEl, formatPx(rounded))
      button.setAttribute('aria-valuenow', String(rounded))
      button.classList.toggle('is-pending', pendingNudge?.id === id && pendingNudge.field === key)
    }

    // 文本
    if (node.type === 'spacer') {
      textInput.disabled = true
      if (document.activeElement !== textInput) textInput.value = ''
      textInput.placeholder = '间距节点没有文本'
    } else {
      textInput.disabled = false
      textInput.placeholder = node.type === 'image' ? '图片占位说明' : '输入文本后回车'
      if (document.activeElement !== textInput) {
        textInput.value =
          pendingText?.id === id ? pendingText.value : (node.text ?? '')
      }
    }

    // 约束
    const constraints = doc.constraints.filter((constraint) => constraint.targetId === id)
    constraintList.replaceChildren()
    if (constraints.length === 0) {
      constraintList.append(el('li', { className: 'inspector__muted', text: '暂无' }))
    } else {
      for (const constraint of constraints) {
        const item = el('li', { className: `inspector__constraint is-${constraint.status}` })
        item.append(
          el('span', {
            className: 'inspector__constraint-kind',
            text: CONSTRAINT_LABELS[constraint.kind] ?? constraint.kind
          }),
          el('span', {
            className: 'inspector__constraint-status',
            text:
              constraint.status === 'active'
                ? '待满足'
                : constraint.status === 'satisfied'
                  ? '已满足'
                  : '冲突'
          })
        )
        if (constraint.note) {
          item.append(el('span', { className: 'inspector__constraint-note', text: constraint.note }))
        }
        constraintList.append(item)
      }
    }
  }

  refresh()

  return {
    refresh,
    destroy(): void {
      for (const dispose of disposers) dispose()
      root.replaceChildren()
    }
  }
}
