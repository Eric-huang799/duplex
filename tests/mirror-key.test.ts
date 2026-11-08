import { describe, expect, it } from 'vitest'
import { mirrorKey } from '../src/shared/mirror-key'

describe('流式卡片 key（issue #4 回归）', () => {
  it('同一 partID 的连续快照得到同一个 key（id 变了也不重建）', () => {
    const first = mirrorKey({ kind: 'text', id: 'ev-1', partID: 'a3' })
    const second = mirrorKey({ kind: 'text', id: 'ev-2', partID: 'a3' })
    const third = mirrorKey({ kind: 'text', id: 'ev-99', partID: 'a3' })
    expect(first).toBe('text:a3')
    expect(second).toBe(first)
    expect(third).toBe(first)
  })

  it('不同 partID 是不同卡片', () => {
    expect(mirrorKey({ kind: 'text', id: 'ev-1', partID: 'a3' })).not.toBe(
      mirrorKey({ kind: 'text', id: 'ev-1', partID: 'a4' })
    )
  })

  it('工具卡在执行中更新状态时 key 不变（展开状态得以保留）', () => {
    const running = mirrorKey({ kind: 'tool', id: 'r1', partID: 't7' })
    const done = mirrorKey({ kind: 'tool', id: 'r2', partID: 't7' })
    expect(running).toBe(done)
  })

  it('没有 partID 时退回 id（会话事件、错误行等）', () => {
    expect(mirrorKey({ kind: 'session', id: 's1' })).toBe('session:s1')
    expect(mirrorKey({ kind: 'session', id: 's1', partID: '' })).toBe('session:s1')
  })

  it('kind 参与 key：同 partID 的不同类型不会串卡', () => {
    expect(mirrorKey({ kind: 'text', id: 'x', partID: 'p1' })).not.toBe(
      mirrorKey({ kind: 'tool', id: 'x', partID: 'p1' })
    )
  })
})
