import { describe, expect, it } from 'vitest'
import { applyPatch, emptyDocument } from '../src/shared/design/model'

const actor = { actor: 'user', step: 1, at: 1 }

describe('placement 清理（自由摆放 ↔ 流式布局）', () => {
  it('unset 能删除 x/y，让节点回到流式布局', () => {
    const doc = emptyDocument('t', 'd')
    doc.root.children = [{ id: 'a', type: 'box', style: { x: '100', y: '50', padding: '8px' } }]
    const freed = applyPatch(
      doc,
      [{ op: 'update', targetId: 'a', patch: { style: {} }, unset: ['x', 'y'] }],
      actor,
      { allowLocked: true }
    )
    expect(freed.applied).toBe(1)
    const node = freed.document.root.children![0]
    expect(node.style?.x).toBeUndefined()
    expect(node.style?.y).toBeUndefined()
    expect(node.style?.padding).toBe('8px')
  })

  it('清空最后一个样式键时 style 变成 undefined（不留空对象）', () => {
    const doc = emptyDocument('t', 'd')
    doc.root.children = [{ id: 'a', type: 'box', style: { x: '1' } }]
    const result = applyPatch(
      doc,
      [{ op: 'update', targetId: 'a', patch: { style: {} }, unset: ['x'] }],
      actor,
      { allowLocked: true }
    )
    expect(result.document.root.children![0].style).toBeUndefined()
  })
})
