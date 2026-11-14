import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  documentFingerprint,
  findNode,
  findParent,
  type DesignNode
} from '../src/shared/design/model'
import { DesignService, type DesignServiceEvent } from '../src/main/design/service'
import { isGitAvailable } from '../src/main/design/git'
import { loadDocument, roundsLogPath } from '../src/main/design/store'

let root: string
let clock: number
let service: DesignService

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'design-service-'))
  clock = 1_700_000_000_000
  service = new DesignService({ root, now: () => clock })
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function insertNode(node: DesignNode, parentId = 'root') {
  return { op: 'insert' as const, parentId, node }
}

/**
 * 比较树形结构时忽略"空 children 数组"这种实现细节：
 * applyPatch 往容器里插过节点后会留下 `children: []`，反向 patch 无法删除这个空属性，
 * 但它不影响渲染/内容语义。
 */
function treeSnapshot(doc: { root: DesignNode }): unknown {
  const walk = (node: DesignNode): unknown => {
    const out: Record<string, unknown> = {
      id: node.id,
      type: node.type,
      text: node.text,
      tag: node.tag,
      style: node.style,
      meta: node.meta
    }
    if (node.children && node.children.length > 0) out['children'] = node.children.map(walk)
    for (const key of Object.keys(out)) if (out[key] === undefined) delete out[key]
    return out
  }
  return walk(doc.root)
}

describe('DesignService：打开与内存文档', () => {
  it('open 空项目返回空文档；重复 open 同一项目不重置状态', () => {
    const doc = service.open('site-1')
    expect(doc.id).toBe('site-1')
    expect(doc.name).toBe('site-1')
    expect(doc.version).toBe(0)
    expect(service.current()).toBe(doc)
    expect(service.isDirty()).toBe(false)
    expect(service.state()).toMatchObject({ projectId: 'site-1', dirty: false, version: 0 })
  })

  it('applyOps 只改内存不写盘；dirty / canUndo 正确', () => {
    service.open('site-1')
    const result = service.applyOps('agent-1', [insertNode({ id: 'hero', type: 'box' })])
    expect(result.applied).toBe(1)
    expect(result.rejected).toEqual([])
    expect(findNode(result.doc.root, 'hero')).not.toBeNull()
    expect(result.doc.version).toBe(1)
    expect(service.isDirty()).toBe(true)
    expect(service.canUndo()).toBe(true)
    expect(service.canRedo()).toBe(false)

    // 还没 commit：磁盘上不存在这个节点
    expect(findNode(loadDocument('site-1', root).root, 'hero')).toBeNull()
  })

  it('全部被拒绝时不改文档、不置 dirty（applyPatch 仍会改 updatedAt，服务不采纳）', () => {
    service.open('site-1')
    const beforeVersion = service.current().version
    const beforeUpdatedAt = service.current().updatedAt
    const result = service.applyOps('agent-1', [{ op: 'remove', targetId: 'missing' }])
    expect(result.applied).toBe(0)
    expect(result.rejected).toHaveLength(1)
    expect(service.current().version).toBe(beforeVersion)
    expect(service.current().updatedAt).toBe(beforeUpdatedAt)
    expect(service.isDirty()).toBe(false)
    expect(service.canUndo()).toBe(false)
  })
})

describe('DesignService：撤销/重做（反向 patch）', () => {
  it('insert → undo 移除节点；redo 重新插入', () => {
    service.open('p')
    service.applyOps('user', [insertNode({ id: 'hero', type: 'box' })])
    expect(service.undo()).toBe(true)
    expect(findNode(service.current().root, 'hero')).toBeNull()
    expect(service.canUndo()).toBe(false)
    expect(service.canRedo()).toBe(true)

    expect(service.redo()).toBe(true)
    expect(findNode(service.current().root, 'hero')).not.toBeNull()
    expect(service.canRedo()).toBe(false)
    expect(service.redo()).toBe(false)
  })

  it('一批 insert 的 undo 按相反顺序撤销，文档恢复到批前结构', () => {
    service.open('p')
    // 先铺一次基线，让 createdBy 落到已有节点上
    service.applyOps('user', [insertNode({ id: 'base', type: 'box' })])
    const before = treeSnapshot(service.current())

    service.applyOps('agent', [
      insertNode({ id: 'a', type: 'text', text: 'A' }, 'base'),
      insertNode({ id: 'b', type: 'text', text: 'B' }, 'base')
    ])
    expect(findNode(service.current().root, 'a')).not.toBeNull()
    expect(service.undo()).toBe(true)
    expect(treeSnapshot(service.current())).toEqual(before)
    expect(service.undo()).toBe(true) // 基线那次也能撤
    expect(findNode(service.current().root, 'base')).toBeNull()
  })

  it('remove → undo 用原父节点/原索引恢复整棵子树', () => {
    service.open('p')
    service.applyOps('user', [
      {
        op: 'insert',
        parentId: 'root',
        node: {
          id: 'card',
          type: 'box',
          children: [{ id: 'title', type: 'text', text: '标题' }]
        }
      }
    ])
    const before = documentFingerprint(service.current())
    service.applyOps('agent', [{ op: 'remove', targetId: 'card' }])
    expect(findNode(service.current().root, 'card')).toBeNull()

    expect(service.undo()).toBe(true)
    expect(documentFingerprint(service.current())).toBe(before)
    const restored = findNode(service.current().root, 'title')
    expect(restored?.text).toBe('标题')
  })

  it('update → undo 回填旧值；原先不存在的样式键用整节点快照精确撤销', () => {
    service.open('p')
    service.applyOps('user', [
      insertNode({ id: 'n', type: 'box', text: '旧', style: { color: '#f00' } })
    ])
    const withStyle = documentFingerprint(service.current())
    service.applyOps('user', [
      { op: 'update', targetId: 'n', patch: { text: '新', style: { color: '#0f0' } } }
    ])
    expect(findNode(service.current().root, 'n')?.text).toBe('新')
    expect(service.undo()).toBe(true)
    expect(findNode(service.current().root, 'n')?.text).toBe('旧')
    expect(documentFingerprint(service.current())).toBe(withStyle)

    // 加一个原本不存在的 style 键：撤销必须把它删掉（update 合并不了，退化为 replace）
    service.applyOps('user', [
      { op: 'update', targetId: 'n', patch: { style: { 'font-size': '20px' } } }
    ])
    expect(findNode(service.current().root, 'n')?.style).toMatchObject({ 'font-size': '20px' })
    expect(service.undo()).toBe(true)
    expect(findNode(service.current().root, 'n')?.style).toEqual({ color: '#f00' })
    expect(documentFingerprint(service.current())).toBe(withStyle)
  })

  it('move → undo 回到原父节点与索引', () => {
    service.open('p')
    service.applyOps('user', [
      insertNode({ id: 'box', type: 'box' }),
      insertNode({ id: 'a', type: 'text', text: 'A' }),
      insertNode({ id: 'b', type: 'text', text: 'B' })
    ])
    const before = treeSnapshot(service.current())
    service.applyOps('user', [{ op: 'move', targetId: 'a', parentId: 'box', index: 0 }])
    expect(findParent(service.current().root, 'a')?.parent.id).toBe('box')

    expect(service.undo()).toBe(true)
    expect(treeSnapshot(service.current())).toEqual(before)
    expect(findParent(service.current().root, 'a')?.parent.id).toBe('root')
    expect(service.current().root.children!.map((node) => node.id)).toEqual(['box', 'a', 'b'])
  })

  it('token → undo 恢复旧值', () => {
    service.open('p')
    const before = service.current().tokens.color['brand.primary']
    service.applyOps('user', [{ op: 'token', name: 'color', key: 'brand.primary', value: '#000000' }])
    expect(service.current().tokens.color['brand.primary']).toBe('#000000')
    expect(service.undo()).toBe(true)
    expect(service.current().tokens.color['brand.primary']).toBe(before)
  })

  it('没有可撤销时 undo 返回 false，不抛错', () => {
    service.open('p')
    expect(service.undo()).toBe(false)
    expect(service.redo()).toBe(false)
  })
})

describe('DesignService：锁定、约束与变体', () => {
  it('agent 默认不能动锁定节点；用户 allowLocked 可以', () => {
    service.open('p')
    service.applyOps('user', [
      insertNode({ id: 'locked', type: 'box', meta: { locked: true } })
    ])
    const rejected = service.applyOps('agent', [
      { op: 'update', targetId: 'locked', patch: { text: 'agent 改' } }
    ])
    expect(rejected.applied).toBe(0)
    expect(rejected.rejected[0].reason).toMatch(/锁定/)

    const allowed = service.applyOps(
      'user',
      [{ op: 'update', targetId: 'locked', patch: { text: '用户改' } }],
      { allowLocked: true }
    )
    expect(allowed.applied).toBe(1)
    expect(findNode(service.current().root, 'locked')?.text).toBe('用户改')
  })

  it('约束：新增（目标必须存在）/ 标记满足或冲突 / 未知 id 报错', () => {
    service.open('p')
    const withConstraint = service.addConstraint({
      kind: 'lock',
      targetId: 'root',
      createdBy: 'user'
    })
    expect(withConstraint.constraints).toHaveLength(1)
    const id = withConstraint.constraints[0].id
    expect(service.isDirty()).toBe(true)

    const resolved = service.resolveConstraint(id, 'satisfied', '已按用户要求处理')
    expect(resolved.constraints[0]).toMatchObject({ status: 'satisfied', note: '已按用户要求处理' })

    expect(() => service.resolveConstraint('missing', 'conflict')).toThrow(/约束不存在/)
    expect(() =>
      service.addConstraint({ kind: 'lock', targetId: 'missing', createdBy: 'user' })
    ).toThrow(/目标节点不存在/)
  })

  it('变体：设置候选清空旧选择；选择越界/未知块报错', () => {
    service.open('p')
    service.setVariants('hero', [
      { id: 'v1', type: 'box' },
      { id: 'v2', type: 'box' }
    ])
    let variant = service.current().variants.find((entry) => entry.blockId === 'hero')!
    expect(variant.options).toHaveLength(2)
    expect(variant.chosenIndex).toBeUndefined()

    const chosen = service.chooseVariant('hero', 1)
    expect(chosen.variants.find((entry) => entry.blockId === 'hero')?.chosenIndex).toBe(1)

    service.setVariants('hero', [{ id: 'v3', type: 'box' }])
    variant = service.current().variants.find((entry) => entry.blockId === 'hero')!
    expect(variant.chosenIndex).toBeUndefined()

    expect(() => service.chooseVariant('hero', 5)).toThrow(/越界/)
    expect(() => service.chooseVariant('nope', 0)).toThrow(/变体不存在/)
  })
})

describe('DesignService：事件、落盘时机与 close', () => {
  it('applyOps 发 document/state，被拒绝的 op 发 rejected', () => {
    const events: DesignServiceEvent[] = []
    const withEvents = new DesignService({ root, now: () => clock, emit: (event) => events.push(event) })
    withEvents.open('p')
    events.length = 0

    withEvents.applyOps('agent', [insertNode({ id: 'x', type: 'box' })])
    expect(events.some((event) => event.type === 'document')).toBe(true)
    expect(events.some((event) => event.type === 'state')).toBe(true)

    events.length = 0
    withEvents.applyOps('agent', [{ op: 'remove', targetId: 'missing' }])
    expect(events.some((event) => event.type === 'rejected')).toBe(true)
    expect(events.some((event) => event.type === 'document')).toBe(false)
  })

  it('切换项目与 close 时把脏文档落盘（open/close 写盘策略）', () => {
    service.open('project-a')
    service.applyOps('user', [insertNode({ id: 'a1', type: 'box' })])
    service.open('project-b')
    expect(findNode(loadDocument('project-a', root).root, 'a1')).not.toBeNull()
    expect(service.canUndo()).toBe(false)
    expect(service.isDirty()).toBe(false)

    service.applyOps('user', [insertNode({ id: 'b1', type: 'box' })])
    service.close()
    expect(findNode(loadDocument('project-b', root).root, 'b1')).not.toBeNull()
    expect(service.state().projectId).toBeNull()
    expect(service.isDirty()).toBe(false)
    expect(() => service.current()).toThrow(/尚未打开设计项目/)
  })
})

const hasGit = isGitAvailable()
const describeGit = hasGit ? describe : describe.skip

describeGit('DesignService：提交与导出（需要 git）', () => {
  it('commitRound：落盘 + sha + rounds.log + dirty=false + history 一条；再提交 skipped', () => {
    service.open('site-1')
    service.applyOps('agent', [insertNode({ id: 'hero', type: 'box' })])
    clock += 60_000
    const fingerprint = documentFingerprint(service.current())

    const committed = service.commitRound('第一轮：搭首页')
    expect(committed.ok).toBe(true)
    expect(committed.sha).toMatch(/^[0-9a-f]{40,64}$/i)
    expect(committed.skipped).toBeUndefined()
    expect(service.isDirty()).toBe(false)

    // 落盘内容与内存一致
    expect(loadDocument('site-1', root)).toEqual(service.current())

    const rounds = service.history()
    expect(rounds).toHaveLength(1)
    expect(rounds[0].subject).toBe('第一轮：搭首页')
    expect(rounds[0].sha).toBe(committed.sha)

    const log = fs.readFileSync(roundsLogPath(root, 'site-1'), 'utf8')
    expect(log).toContain('第一轮：搭首页')
    expect(log).toContain(committed.sha!)
    expect(log).toContain(fingerprint)

    // 没有改动：不造空提交
    const skipped = service.commitRound('没有改动')
    expect(skipped).toMatchObject({ ok: true, skipped: true })
    expect(service.history()).toHaveLength(1)
  }, 30_000)

  it('exportZip：未提交报错；提交后导出 HEAD 的 zip', () => {
    service.open('site-1')
    service.applyOps('user', [insertNode({ id: 'before-commit', type: 'box' })])
    const early = service.exportZip(path.join(root, 'exports', 'early.zip'))
    expect(early.ok).toBe(false)
    expect(early.error).toMatch(/尚未提交过任何轮次/)

    expect(service.commitRound('第一轮').ok).toBe(true)
    // 提交后再改但不提交：内存变了，磁盘与 HEAD 都没变（applyOps 不落盘）
    service.applyOps('user', [insertNode({ id: 'uncommitted', type: 'box' })])

    const target = path.join(root, 'exports', 'site.zip')
    const exported = service.exportZip(target)
    expect(exported.ok).toBe(true)
    expect(exported.path).toBe(path.resolve(target))
    const bytes = fs.readFileSync(target)
    expect(bytes.length).toBeGreaterThan(0)
    expect(bytes.subarray(0, 2).toString('ascii')).toBe('PK')
    // zip 的文件名表里能看到 design.json（导出的是已提交的一轮）
    expect(bytes.toString('latin1')).toContain('design.json')
    expect(service.history()).toHaveLength(1)
  }, 30_000)

  it('未打开项目时提交/导出/历史都给出明确错误或空结果', () => {
    expect(service.commitRound('x')).toMatchObject({ ok: false })
    expect(service.exportZip(path.join(root, 'x.zip'))).toMatchObject({ ok: false })
    expect(service.history()).toEqual([])
  })
})
