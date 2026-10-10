import { describe, expect, it } from 'vitest'
import { runInNewContext } from 'node:vm'
import { buildSnapshotScript } from '../src/main/page-scripts'
import { cdp } from '../src/main/cdp'
import { beginOperation, endOperation, runInOperation } from '../src/main/interrupt'
import type { Tab } from '../src/main/tabs'
import { chordEventKeys } from '../src/main/playwright-browser'

function fixture() {
  const button = {
    tagName: 'BUTTON', id: '', className: '', children: [], childNodes: [],
    textContent: '保存', isConnected: true,
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 80, height: 30 }),
    getAttribute: () => null,
    setAttribute: () => undefined
  }
  const body = { ...button, tagName: 'BODY', textContent: '', children: [button] }
  const ctx = {
    window: {} as { __cobrowse?: { refMap: Map<string, unknown> } },
    document: { body, title: 'Fixture', documentElement: { scrollHeight: 500 } },
    location: { href: 'https://example.test' }, innerWidth: 1000, innerHeight: 500, scrollY: 0,
    getComputedStyle: () => ({ visibility: 'visible', display: 'block', opacity: '1' })
  }
  return { ctx, button }
}

describe('page collaboration', () => {
  it('marks modifier keys and normalizes printable keyboard aliases', () => {
    expect(chordEventKeys('Control+A')).toEqual(['Control', 'A', 'a'])
    expect(chordEventKeys('Shift+Tab')).toEqual(['Shift', 'Tab'])
    expect(chordEventKeys('Space')).toEqual([' '])
  })
  it('does not reuse an element reference after a new snapshot', () => {
    const { ctx } = fixture()
    const first = runInNewContext(buildSnapshotScript(), ctx) as string
    const second = runInNewContext(buildSnapshotScript(), ctx) as string
    expect(second.match(/\[(e\d+)\]/)?.[1]).not.toBe(first.match(/\[(e\d+)\]/)?.[1])
  })

  it('expires old references after three newer snapshots', () => {
    const { ctx } = fixture()
    const first = runInNewContext(buildSnapshotScript(), ctx) as string
    const ref = first.match(/\[(e\d+)\]/)![1]
    for (let i = 0; i < 3; i++) runInNewContext(buildSnapshotScript(), ctx)
    expect(ctx.window.__cobrowse?.refMap.has(ref)).toBe(false)
  })

  it('does not dispatch CDP commands after its operation was cancelled', async () => {
    const calls: string[] = []
    const tab = { view: { webContents: { debugger: {
      isAttached: () => true,
      sendCommand: async (method: string) => { calls.push(method); return {} }
    } } } } as unknown as Tab
    const operation = beginOperation()
    operation.abort()
    try {
      await expect(runInOperation(operation, () => cdp(tab, 'Input.insertText', { text: 'unsafe' }))).rejects.toThrow(/中断/)
      expect(calls).toEqual([])
    } finally { endOperation(operation) }
  })
})
