import { describe, expect, it } from 'vitest'
import {
  addConstraint,
  anchorPoint,
  applyPatch,
  collectIds,
  documentFingerprint,
  emptyDocument,
  findNode,
  gridCandidates,
  isLocked,
  moveDelta,
  resolveConstraint,
  snapPoint,
  type DesignNode
} from '../src/shared/design/model'

const actor = { actor: 'agent-1', step: 1, at: 1_700_000_000_000 }

function seeded(): { doc: ReturnType<typeof emptyDocument>; card: DesignNode } {
  const doc = emptyDocument('demo', 'd1')
  const card: DesignNode = {
    id: 'card-1',
    type: 'box',
    children: [{ id: 'title-1', type: 'heading', text: '你好' }]
  }
  doc.root.children = [card]
  return { doc, card }
}

describe('patch：唯一的修改入口', () => {
  it('insert 到容器并记录来源；原文档不变（不可变）', () => {
    const { doc } = seeded()
    const before = JSON.stringify(doc)
    const result = applyPatch(
      doc,
      [{ op: 'insert', parentId: 'root', index: 0, node: { id: 'hero-1', type: 'box' } }],
      actor
    )
    expect(result.applied).toBe(1)
    expect(result.rejected).toEqual([])
    expect(result.document.root.children![0].id).toBe('hero-1')
    expect(result.document.root.children![0].meta?.createdBy?.actor).toBe('agent-1')
    expect(JSON.stringify(doc)).toBe(before)
    expect(result.document.version).toBe(doc.version + 1)
  })

  it('insert 到非容器被拒', () => {
    const { doc } = seeded()
    const result = applyPatch(
      doc,
      [{ op: 'insert', parentId: 'title-1', node: { id: 'x', type: 'box' } }],
      actor
    )
    expect(result.applied).toBe(0)
    expect(result.rejected[0].reason).toMatch(/不是容器/)
  })

  it('重复 id 被拒（否则定位会指向两个节点）', () => {
    const { doc } = seeded()
    const result = applyPatch(
      doc,
      [{ op: 'insert', parentId: 'root', node: { id: 'card-1', type: 'box' } }],
      actor
    )
    expect(result.applied).toBe(0)
    expect(result.rejected[0].reason).toMatch(/id 重复/)
  })

  it('锁定区拒绝 agent 的修改，但用户直接编辑可以（allowLocked）', () => {
    const { doc } = seeded()
    doc.root.children![0].meta = { locked: true }
    const ops = [{ op: 'update' as const, targetId: 'card-1', patch: { text: 'changed' } }]
    const agentResult = applyPatch(doc, ops, actor)
    expect(agentResult.applied).toBe(0)
    expect(agentResult.rejected[0].reason).toMatch(/锁定/)
    const userResult = applyPatch(doc, ops, { actor: 'user', step: 0, at: 1 }, { allowLocked: true })
    expect(userResult.applied).toBe(1)
  })

  it('锁定祖先会保护子孙', () => {
    const { doc } = seeded()
    doc.root.children![0].meta = { locked: true }
    expect(isLocked(doc.root, 'title-1')).toBe(true)
    const result = applyPatch(
      doc,
      [{ op: 'update', targetId: 'title-1', patch: { text: 'x' } }],
      actor
    )
    expect(result.applied).toBe(0)
  })

  it('remove / move / update / token 各自生效', () => {
    const { doc } = seeded()
    let result = applyPatch(
      doc,
      [
        { op: 'insert', parentId: 'root', node: { id: 'a', type: 'box' } },
        { op: 'move', targetId: 'card-1', parentId: 'root', index: 0 },
        { op: 'update', targetId: 'title-1', patch: { text: '改了' } },
        { op: 'token', name: 'color', key: 'brand.primary', value: '#f00' },
        { op: 'remove', targetId: 'a' }
      ],
      actor
    )
    expect(result.rejected).toEqual([])
    expect(result.applied).toBe(5)
    expect(result.document.root.children!.map((n) => n.id)).toEqual(['card-1'])
    expect(findNode(result.document.root, 'title-1')?.text).toBe('改了')
    expect(result.document.tokens.color['brand.primary']).toBe('#f00')
  })

  it('单个 op 失败不影响同批其它 op（partial apply）', () => {
    const { doc } = seeded()
    const result = applyPatch(
      doc,
      [
        { op: 'update', targetId: 'nope', patch: { text: 'x' } },
        { op: 'insert', parentId: 'root', node: { id: 'ok', type: 'box' } }
      ],
      actor
    )
    expect(result.applied).toBe(1)
    expect(result.rejected).toHaveLength(1)
    expect(findNode(result.document.root, 'ok')).not.toBeNull()
  })
})

describe('锚点与吸附（定位器的基础）', () => {
  const rect = { x: 100, y: 50, width: 200, height: 80 }

  it('九点锚点位置正确', () => {
    expect(anchorPoint(rect, 'center')).toEqual({ x: 200, y: 90 })
    expect(anchorPoint(rect, 'top-left')).toEqual({ x: 100, y: 50 })
    expect(anchorPoint(rect, 'top-right')).toEqual({ x: 300, y: 50 })
    expect(anchorPoint(rect, 'bottom')).toEqual({ x: 200, y: 130 })
    expect(anchorPoint(rect, 'left')).toEqual({ x: 100, y: 90 })
  })

  it('moveDelta 让锚点与目标点重合', () => {
    const delta = moveDelta(rect, 'center', { x: 500, y: 300 })
    expect(delta).toEqual({ x: 300, y: 210 })
    // 应用位移后，锚点正好落在目标点
    const moved = { ...rect, x: rect.x + delta.x, y: rect.y + delta.y }
    expect(anchorPoint(moved, 'center')).toEqual({ x: 500, y: 300 })
  })

  it('吸附：阈值内吸到最近候选，阈值外保持原位', () => {
    const candidates = [{ point: { x: 104, y: 96 }, from: 'card-1' }]
    const near = snapPoint({ x: 100, y: 100 }, candidates, 8)
    expect(near.snapped?.from).toBe('card-1')
    expect(near.point).toEqual({ x: 104, y: 96 })
    const far = snapPoint({ x: 200, y: 200 }, candidates, 8)
    expect(far.snapped).toBeNull()
    expect(far.point).toEqual({ x: 200, y: 200 })
  })

  it('网格候选点在步长上', () => {
    const grid = gridCandidates(32, 8)
    const xs = grid.filter((c) => c.from === 'grid-x').map((c) => c.point.x)
    expect(xs).toContain(0)
    expect(xs).toContain(16)
    expect(xs).toContain(32)
  })
})

describe('约束与文档', () => {
  it('约束进入文档、可标记满足/冲突', () => {
    const { doc } = seeded()
    const withConstraint = addConstraint(doc, {
      kind: 'lock',
      targetId: 'card-1',
      createdBy: 'user'
    })
    expect(withConstraint.constraints).toHaveLength(1)
    const satisfied = resolveConstraint(withConstraint, withConstraint.constraints[0].id, 'satisfied')
    expect(satisfied.constraints[0].status).toBe('satisfied')
  })

  it('指纹随内容变化（用于 git 提交去重）', () => {
    const { doc } = seeded()
    const a = documentFingerprint(doc)
    const changed = applyPatch(
      doc,
      [{ op: 'update', targetId: 'title-1', patch: { text: '变了' } }],
      actor
    ).document
    expect(documentFingerprint(changed)).not.toBe(a)
  })

  it('collectIds 覆盖整棵树', () => {
    const { doc } = seeded()
    expect([...collectIds(doc.root)].sort()).toEqual(['card-1', 'root', 'title-1'])
  })
})
