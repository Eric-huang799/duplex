import { describe, expect, it } from 'vitest'
import { cloneNodeForPaste, uniqueNodeId } from '../src/canvas/geometry'
import { pasteTargetFor } from '../src/canvas/shortcuts'
import { emptyDocument, type DesignNode } from '../src/shared/design/model'

const ids = (...list: string[]): Set<string> => new Set(list)

describe('画布剪贴板：id 与偏移', () => {
  it('未占用时保留原 id，占用时生成 -copy / -copy2', () => {
    expect(uniqueNodeId('hero', ids('hero'))).toBe('hero-copy')
    expect(uniqueNodeId('hero', ids('hero', 'hero-copy'))).toBe('hero-copy2')
    expect(uniqueNodeId('hero', ids('other'))).toBe('hero')
    // 复制品再复制不会叠成 hero-copy-copy
    expect(uniqueNodeId('hero-copy', ids('hero-copy'))).toBe('hero-copy2')
  })

  it('整棵子树重新编号，且绝对定位节点偏移 16px', () => {
    const node: DesignNode = {
      id: 'card',
      type: 'box',
      style: { x: '100', y: '200', background: '#fff' },
      children: [{ id: 'card-title', type: 'text', text: '标题' }]
    }
    const result = cloneNodeForPaste(node, ids('card', 'card-title'))
    expect(result.node.id).toBe('card-copy')
    expect(result.node.children?.[0].id).toBe('card-title-copy')
    expect(result.node.style?.x).toBe('116')
    expect(result.node.style?.y).toBe('216')
    // 非定位样式原样保留
    expect(result.node.style?.background).toBe('#fff')
    // 复制品不继承锁定
    expect(result.node.meta?.editedByUser).toBe(true)
  })

  it('没有 x/y 的节点不加偏移（避免凭空产生绝对定位）', () => {
    const node: DesignNode = { id: 'para', type: 'text', text: '正文' }
    const result = cloneNodeForPaste(node, ids())
    expect(result.node.style).toBeUndefined()
    expect(result.node.id).toBe('para')
  })
})

describe('粘贴落点', () => {
  const doc = emptyDocument('t', 'd1')

  it('没选中时贴到根', () => {
    expect(pasteTargetFor(doc, null)).toEqual({ parentId: 'root' })
  })

  it('选中容器时贴进容器', () => {
    doc.root.children = [{ id: 'section', type: 'stack', children: [] }]
    expect(pasteTargetFor(doc, 'section')).toEqual({ parentId: 'section' })
  })

  it('选中叶子时贴到它后面（同级）', () => {
    doc.root.children = [
      { id: 'a', type: 'text', text: 'A' },
      { id: 'b', type: 'text', text: 'B' }
    ]
    expect(pasteTargetFor(doc, 'a')).toEqual({ parentId: 'root', index: 1 })
  })
})
