import { describe, expect, it } from 'vitest'
import { CollaborationCoordinator, PAGE_READ_TOOLS } from '../src/main/collaboration'

describe('task tab coordination', () => {
  it('keeps the closed task binding until another tab is explicitly selected', () => {
    const c = new CollaborationCoordinator()
    c.resolveTab('a', undefined, 1)
    c.forget(1)
    expect(c.resolveTab('a', undefined, 2)).toBe(1)
    expect(c.resolveTab('a', 2, 2)).toBe(2)
  })
  it('keeps a caller on its task tab when the human switches tabs', () => {
    const c = new CollaborationCoordinator()
    expect(c.resolveTab('a', undefined, 1)).toBe(1)
    expect(c.resolveTab('a', undefined, 2)).toBe(1)
    expect(c.resolveTab('b', undefined, 2)).toBe(2)
    expect(c.resolveTab('a', 3, 2)).toBe(3)
  })

  it('continues task execution through continuous human scrolling', async () => {
    const c = new CollaborationCoordinator()
    for (let i = 0; i < 30; i++) c.humanActivity(1, 'scroll')
    expect(c.snapshot().tabs[0]).toMatchObject({ paused: false, scrolling: true })
    expect(await c.run(1, 'a', true, async () => 'clicked element')).toBe('clicked element')
  })

  it('lets reads continue after human input, and requires explicit resume for writes', async () => {
    const c = new CollaborationCoordinator()
    c.humanActivity(1, 'input')
    expect(await c.run(1, 'a', false, async () => 'read')).toBe('read')
    await expect(c.run(1, 'a', true, async () => 'write')).rejects.toThrow('人工')
    c.resume(1)
    expect(await c.run(1, 'a', true, async () => 'write')).toBe('write')
  })

  it('serializes one task on a tab while allowing a different tab to proceed', async () => {
    const c = new CollaborationCoordinator()
    const order: string[] = []
    let finish!: () => void
    const p = c.run(1, 'a', true, async () => { order.push('first'); await new Promise<void>(r => { finish = r }); order.push('done') })
    await Promise.resolve()
    await Promise.resolve()
    const next = c.run(1, 'a', true, async () => { order.push('second') })
    await c.run(2, 'b', true, async () => { order.push('other tab') })
    expect(order).toEqual(['first', 'other tab'])
    finish()
    await Promise.all([p, next])
    expect(order).toEqual(['first', 'other tab', 'done', 'second'])
  })

  it('locks the tab while a writer is running, then frees it automatically', async () => {
    const c = new CollaborationCoordinator()
    let finish!: () => void
    const running = c.run(1, 'a', true, () => new Promise<void>((r) => { finish = r }))
    await Promise.resolve()
    await Promise.resolve()
    await expect(c.run(1, 'b', true, async () => undefined)).rejects.toThrow('[LOCKED]')
    finish()
    await running
    // the owner is released when the run settles: no explicit release() needed
    await c.run(1, 'b', true, async () => undefined)
    expect(c.snapshot().tabs.find((t) => t.tabId === 1)?.owner ?? null).toBeNull()
  })

  it('marks human-taken tabs as [PAUSED] and keeps switch_tab read-only', async () => {
    const c = new CollaborationCoordinator()
    c.humanActivity(1, 'pointer')
    await expect(c.run(1, 'a', true, async () => undefined)).rejects.toThrow('[PAUSED]')
    c.resume(1)
    await c.run(1, 'a', true, async () => undefined)
    expect(PAGE_READ_TOOLS.has('switch_tab')).toBe(true)
  })

  it('does not execute a queued action cancelled while waiting', async () => {
    const c = new CollaborationCoordinator()
    let finish!: () => void
    const p = c.run(1, 'a', true, () => new Promise<void>(r => { finish = r }))
    await Promise.resolve(); await Promise.resolve()
    const ctl = new AbortController()
    let executed = false
    const q = c.run(1, 'a', true, async () => { executed = true }, ctl.signal)
    ctl.abort(); finish()
    await p
    await expect(q).rejects.toThrow('取消')
    expect(executed).toBe(false)
  })
})
