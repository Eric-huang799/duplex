/**
 * 画布快捷键：Ctrl+C / X / V / D / Z / Y、Delete、Esc、方向键微调。
 *
 * 设计原则：
 *  - 只发**意图**（`user-ops` / `undo` / `redo` / `select`），文档由主进程改；
 *  - 在输入框/可编辑区里打字时不拦截任何键（除了 Esc）；
 *  - 粘贴的节点 id 全部重新生成，绝对定位的节点加 16px 偏移，避免"看起来没反应"。
 */
import {
  collectIds,
  findNode,
  findParent,
  isContainer,
  type DesignDocument,
  type DesignNode,
  type PatchOp
} from '../shared/design/model'
import { cloneNodeForPaste } from './geometry'
import type { OutboundMessage } from './host'

export interface ShortcutDeps {
  getDoc(): DesignDocument | null
  getSelectedId(): string | null
  select(id: string | null): void
  send(message: OutboundMessage): void
  toast(text: string): void
}

export interface ShortcutHandle {
  dispose(): void
  /** 当前剪贴板里有没有内容（UI 可用它置灰按钮）。 */
  hasClipboard(): boolean
}

const PASTE_OFFSET = 16

function isTypingTarget(target: EventTarget | null): boolean {
  const element = target instanceof Element ? target : null
  if (!element) return false
  if (element.closest('input, textarea, select')) return true
  return (element as HTMLElement).isContentEditable === true
}

/** 决定粘贴落到哪个父节点/位置：容器内 → 追加；叶子 → 插到它后面；否则根。 */
export function pasteTargetFor(
  doc: DesignDocument,
  selectedId: string | null
): { parentId: string; index?: number } {
  const selected = selectedId ? findNode(doc.root, selectedId) : null
  if (!selected) return { parentId: doc.root.id }
  if (isContainer(selected)) return { parentId: selected.id }
  const parent = findParent(doc.root, selected.id)
  if (!parent) return { parentId: doc.root.id }
  return { parentId: parent.parent.id, index: parent.index + 1 }
}

/** 去掉选中节点里可能存在的锁定标记（复制品不该继承锁定）。 */
function unlock(node: DesignNode): DesignNode {
  return {
    ...node,
    meta: { ...(node.meta ?? {}), locked: false, editedByUser: true },
    ...(node.children ? { children: node.children.map(unlock) } : {})
  }
}

export function installShortcuts(deps: ShortcutDeps): ShortcutHandle {
  let clipboard: DesignNode | null = null

  const handle = (event: KeyboardEvent): void => {
    const doc = deps.getDoc()
    if (!doc) return
    const mod = event.ctrlKey || event.metaKey
    const selectedId = deps.getSelectedId()

    if (event.key === 'Escape') {
      if (isTypingTarget(event.target)) return
      deps.select(null)
      return
    }
    if (isTypingTarget(event.target)) return

    const destroy = (ops: PatchOp[], note: string): void => {
      deps.send({ type: 'user-ops', ops })
      deps.toast(note)
    }

    // 方向键微调：只有选中节点、且没有输入焦点时生效（帧坐标，1px / Shift 10px）
    if (event.key.startsWith('Arrow') && selectedId) {
      const node = findNode(doc.root, selectedId)
      if (!node || node.meta?.locked) return
      const step = event.shiftKey ? 10 : 1
      const axis = event.key === 'ArrowLeft' || event.key === 'ArrowRight' ? 'x' : 'y'
      const sign = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1
      const current = Number(node.style?.[axis] ?? 0)
      event.preventDefault()
      destroy(
        [
          {
            op: 'update',
            targetId: selectedId,
            patch: { style: { ...(node.style ?? {}), [axis]: String(Math.round(current + step * sign)) } }
          }
        ],
        `${axis.toUpperCase()} ${Math.round(current + step * sign)}px`
      )
      return
    }

    if (!mod) {
      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (!selectedId) return
        event.preventDefault()
        destroy([{ op: 'remove', targetId: selectedId }], '已删除选中节点')
      }
      return
    }

    const key = event.key.toLowerCase()
    if (key === 'c' || key === 'x') {
      if (!selectedId) return
      const node = findNode(doc.root, selectedId)
      if (!node) return
      event.preventDefault()
      clipboard = structuredClone(node)
      if (key === 'x') destroy([{ op: 'remove', targetId: selectedId }], '已剪切（Ctrl+V 粘贴）')
      else deps.toast('已复制（Ctrl+V 粘贴）')
      return
    }
    if (key === 'v') {
      if (!clipboard) return
      event.preventDefault()
      const target = pasteTargetFor(doc, selectedId)
      const existing = collectIds(doc.root)
      const cloned = cloneNodeForPaste(unlock(clipboard), existing, PASTE_OFFSET)
      deps.send({
        type: 'user-ops',
        ops: [{ op: 'insert', parentId: target.parentId, ...(target.index !== undefined ? { index: target.index } : {}), node: cloned.node }]
      })
      deps.select(cloned.node.id)
      deps.toast(`已粘贴 ${cloned.node.id}`)
      return
    }
    if (key === 'd') {
      if (!selectedId) return
      const node = findNode(doc.root, selectedId)
      if (!node) return
      event.preventDefault()
      const target = pasteTargetFor(doc, selectedId)
      const cloned = cloneNodeForPaste(unlock(node), collectIds(doc.root), PASTE_OFFSET)
      deps.send({
        type: 'user-ops',
        ops: [{ op: 'insert', parentId: target.parentId, ...(target.index !== undefined ? { index: target.index } : {}), node: cloned.node }]
      })
      deps.select(cloned.node.id)
      deps.toast(`已复制一份 ${cloned.node.id}`)
      return
    }
    if (key === 'l' && event.shiftKey) {
      // 取消帧内绝对定位，回到流式布局（与拖拽交换相反的意图）
      if (!selectedId) return
      const node = findNode(doc.root, selectedId)
      if (!node) return
      event.preventDefault()
      destroy(
        [{ op: 'update', targetId: selectedId, patch: { style: {} }, unset: ['x', 'y', 'w', 'h', 'position'] }],
        '已回到流式布局'
      )
      return
    }
    if (key === 'z') {
      event.preventDefault()
      deps.send({ type: event.shiftKey ? 'redo' : 'undo' })
      deps.toast(event.shiftKey ? '重做' : '撤销')
      return
    }
    if (key === 'y') {
      event.preventDefault()
      deps.send({ type: 'redo' })
      deps.toast('重做')
      return
    }
  }

  window.addEventListener('keydown', handle, true)
  return {
    dispose: () => window.removeEventListener('keydown', handle, true),
    hasClipboard: () => clipboard !== null
  }
}
