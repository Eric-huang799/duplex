import { describe, expect, it } from 'vitest'
import { runInNewContext } from 'node:vm'
import type { Page } from 'playwright-core'
import { buildRefProbeScript, buildSnapshotScript } from '../src/main/page-scripts'
import { locatorForTarget } from '../src/main/playwright-browser'
import {
  RefRegistry,
  compareFingerprints,
  parseSnapshotEnvelope,
  type RefFingerprint,
  type SnapshotRefEntry
} from '../src/main/ref-registry'

function fp(overrides: Partial<RefFingerprint> = {}): RefFingerprint {
  return { tag: 'button', text: '保存', x: 10, y: 20, w: 80, h: 30, href: '', type: '', ...overrides }
}

function entry(ref: string, overrides: Partial<RefFingerprint> = {}): SnapshotRefEntry {
  return { ref, fingerprint: fp(overrides) }
}

/** 页面脚本的 vm 夹具：一个可见按钮 + 一份可变的文本/位置。 */
function snapshotFixture() {
  const button = {
    tagName: 'BUTTON',
    id: '',
    className: '',
    children: [] as unknown[],
    childNodes: [] as unknown[],
    textContent: '保存',
    isConnected: true,
    disabled: false,
    shadowRoot: null,
    getBoundingClientRect: () => ({ x: 10, y: 20, width: 80, height: 30 }),
    getAttribute: () => null
  }
  const body = {
    ...button,
    tagName: 'BODY',
    textContent: '',
    children: [button],
    childNodes: [] as unknown[],
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 1000, height: 500 })
  }
  const documentElement = { scrollHeight: 500, getAttribute: () => null }
  const ctx = {
    window: {} as { __cobrowse?: { refMap: Map<string, unknown> }; scrollX?: number; scrollY?: number },
    document: { body, title: 'Fixture', documentElement },
    location: { href: 'https://example.test' },
    innerWidth: 1000,
    innerHeight: 500,
    scrollY: 0,
    getComputedStyle: () => ({ visibility: 'visible', display: 'block', opacity: '1' })
  }
  return { ctx, button }
}

/** 假 Page：字符串表达式视为动作前只读探测，函数调用视为设置定位标记。 */
function fakePage(probe: () => unknown) {
  const probes: string[] = []
  let markerWrites = 0
  const page = {
    evaluate: async (expression: unknown) => {
      if (typeof expression === 'string') {
        probes.push(expression)
        return probe()
      }
      markerWrites++
      return true
    },
    locator: (selector: string) => ({ selector })
  }
  return { page: page as unknown as Page, probes, markerWrites: () => markerWrites }
}

describe('ref 命名空间', () => {
  it('不同 actor 的同号 ref 互不干扰', () => {
    const registry = new RefRegistry()
    registry.recordSnapshot(7, 'agent-a', 'doc-1', [entry('e12', { text: 'A 的按钮' })])
    registry.recordSnapshot(7, 'agent-b', 'doc-1', [entry('e12', { text: 'B 的按钮', x: 200 })])
    expect(registry.hasOtherActor(7, 'agent-a')).toBe(true)
    expect(registry.hasOtherActor(7, 'agent-b')).toBe(true)

    const claimA = registry.claim(7, 'agent-a', 'e12')
    const claimB = registry.claim(7, 'agent-b', 'e12')
    expect(claimA.snapshot.refs.get('e12')?.text).toBe('A 的按钮')
    expect(claimB.snapshot.refs.get('e12')?.text).toBe('B 的按钮')

    // 各自用自己的指纹校验通过；拿对方的页面读数校验则失败。
    expect(() => registry.validate(claimA, 'doc-1', fp({ text: 'A 的按钮' }))).not.toThrow()
    expect(() => registry.validate(claimB, 'doc-1', fp({ text: 'B 的按钮', x: 200 }))).not.toThrow()
    expect(() => registry.validate(claimA, 'doc-1', fp({ text: 'B 的按钮', x: 200 }))).toThrow(
      /元素已被改动/
    )
  })

  it('前缀不属于当前 caller 时明确报错，而不是当成别的 agent 的元素', () => {
    const registry = new RefRegistry()
    registry.recordSnapshot(1, 'agent-a', 'doc-1', [entry('e12')])

    expect(() => registry.claim(1, 'agent-b', 'aagent-a:e12')).toThrow(
      /属于 agent "agent-a" 的命名空间/
    )
    expect(() => registry.claim(1, 'agent-b', 'aagent-a:e12')).toThrow(/当前调用者是 "agent-b"/)
    // 未知命名空间同样是明确失败，不回退到页面查找。
    expect(() => registry.claim(1, 'agent-b', 'aghost:e12')).toThrow(/命名空间/)
    // 自己的命名空间写法可解析成同一个 base ref。
    expect(registry.claim(1, 'agent-a', registry.formatRef('agent-a', 'e12')).baseRef).toBe('e12')

    // 真实 MCP caller id 含冒号（bridge:<hash>）；命名空间里冒号被替换成短横线，
    // 保证 ref 语法 `a<tag>:e12` 只有唯一的分隔冒号。
    registry.recordSnapshot(1, 'bridge:abc123', 'doc-1', [entry('e7')])
    expect(registry.formatRef('bridge:abc123', 'e7')).toBe('abridge-abc123:e7')
    expect(registry.claim(1, 'bridge:abc123', 'abridge-abc123:e7').baseRef).toBe('e7')
    expect(() => registry.claim(1, 'agent-b', 'abridge-abc123:e7')).toThrow(/命名空间/)
  })

  it('单 agent 的旧写法 e12 仍然可用，快照也不加前缀', () => {
    const registry = new RefRegistry()
    registry.recordSnapshot(3, 'builtin', 'doc-1', [entry('e12')])
    expect(registry.claim(3, 'builtin', 'e12').baseRef).toBe('e12')

    const { ctx } = snapshotFixture()
    const outline = runInNewContext(buildSnapshotScript(), ctx) as string
    expect(outline).toMatch(/\[e\d+\]/)
    expect(outline).not.toMatch(/\[a[\w:.-]+:e\d+\]/)
    expect(parseSnapshotEnvelope('没有内部指纹尾部的旧格式')).toBeNull()
  })

  it('多 agent 会话的快照输出带 a<actor>:eN 前缀', () => {
    const { ctx } = snapshotFixture()
    const outline = runInNewContext(buildSnapshotScript('agent-a'), ctx) as string
    expect(outline).toMatch(/refs: \[aagent-a:eN\]/)
    expect(outline).toMatch(/\[aagent-a:e\d+\]/)
  })
})

describe('快照指纹', () => {
  it('元素文本/位置变化后旧 ref 失效，容差内视为未变', () => {
    const registry = new RefRegistry()
    registry.recordSnapshot(1, 'agent-a', 'doc-1', [entry('e12')])
    const claim = registry.claim(1, 'agent-a', 'e12')

    expect(() => registry.validate(claim, 'doc-1', fp())).not.toThrow()
    expect(() => registry.validate(claim, 'doc-1', fp({ x: 12 }))).not.toThrow()
    expect(() => registry.validate(claim, 'doc-1', fp({ text: '删除' }))).toThrow(
      /元素已被改动，请重新 snapshot/
    )
    expect(() => registry.validate(claim, 'doc-1', fp({ x: 40 }))).toThrow(/位置/)
    expect(() => registry.validate(claim, 'doc-1', fp({ w: 120 }))).toThrow(/尺寸/)
  })

  it('页面导航（document token 变化）后旧 ref 失效', () => {
    const registry = new RefRegistry()
    registry.recordSnapshot(1, 'agent-a', 'doc-1', [entry('e12')])
    const claim = registry.claim(1, 'agent-a', 'e12')
    expect(() => registry.validate(claim, 'doc-2', fp())).toThrow(/页面已导航或重新加载/)
    // 早期文档两侧都可能读不到 token（unmarked），此时只靠指纹判定。
    const early = new RefRegistry()
    early.recordSnapshot(1, 'agent-a', 'unmarked', [entry('e12')])
    expect(() => early.validate(early.claim(1, 'agent-a', 'e12'), 'unmarked', fp())).not.toThrow()
  })

  it('快照记录的指纹与动作前探测使用同一套读数', () => {
    const { ctx, button } = snapshotFixture()
    const outline = runInNewContext(buildSnapshotScript(), ctx) as string
    const envelope = parseSnapshotEnvelope(outline)
    expect(envelope).not.toBeNull()
    expect(envelope!.outline).not.toContain('CobrowseRefs')
    const first = envelope!.refs[0]

    const before = runInNewContext(buildRefProbeScript(first.ref), ctx) as {
      error?: string
      documentToken?: string
      fingerprint?: RefFingerprint
    }
    expect(before.error).toBeUndefined()
    expect(before.fingerprint).toEqual(first.fingerprint)

    button.textContent = '删除'
    const after = runInNewContext(buildRefProbeScript(first.ref), ctx) as {
      fingerprint?: RefFingerprint
    }
    expect(compareFingerprints(first.fingerprint, after.fingerprint!).match).toBe(false)
  })

  it('动作解析在探测页面前就拒绝别人的命名空间', async () => {
    const registry = new RefRegistry()
    registry.recordSnapshot(1, 'agent-a', 'doc-1', [entry('e12')])
    const { page, probes, markerWrites } = fakePage(() => ({ error: 'should-not-be-probed' }))
    await expect(
      locatorForTarget(page, 'aagent-a:e12', { tabId: 1, actorId: 'agent-b', registry })
    ).rejects.toThrow(/属于 agent "agent-a" 的命名空间/)
    expect(probes).toHaveLength(0)
    expect(markerWrites()).toBe(0)
  })

  it('动作前探测到改动时失败，未改动时正常返回 locator', async () => {
    const registry = new RefRegistry()
    registry.recordSnapshot(1, 'agent-a', 'doc-1', [entry('e12')])

    const stale = fakePage(() => ({ documentToken: 'doc-1', fingerprint: fp({ text: '删除' }) }))
    await expect(
      locatorForTarget(stale.page, 'e12', { tabId: 1, actorId: 'agent-a', registry })
    ).rejects.toThrow(/元素已被改动，请重新 snapshot/)

    const fresh = fakePage(() => ({ documentToken: 'doc-1', fingerprint: fp() }))
    const locator = await locatorForTarget(fresh.page, 'e12', {
      tabId: 1,
      actorId: 'agent-a',
      registry
    })
    expect(locator).toBeTruthy()
    // 一次只读探测 + 一次设置现有定位标记（没有新增 DOM 属性）。
    expect(fresh.probes).toHaveLength(1)
    expect(fresh.markerWrites()).toBe(1)
  })
})

describe('清理', () => {
  it('按 (标签, actor) 清理，每个 actor 最多保留三代快照', () => {
    const registry = new RefRegistry()
    for (let i = 1; i <= 4; i++) registry.recordSnapshot(1, 'agent-a', 'doc-1', [entry(`e${i}`)])
    expect(registry.snapshotCount(1, 'agent-a')).toBe(3)
    expect(() => registry.claim(1, 'agent-a', 'e1')).toThrow(/不在你最近的 snapshot/)
    expect(registry.claim(1, 'agent-a', 'e4').baseRef).toBe('e4')

    registry.recordSnapshot(2, 'agent-a', 'doc-2', [entry('e1')])
    registry.recordSnapshot(1, 'agent-b', 'doc-1', [entry('e2')])
    registry.forgetActor(1, 'agent-a')
    expect(registry.hasActor(1, 'agent-a')).toBe(false)
    expect(registry.hasActor(1, 'agent-b')).toBe(true)
    expect(registry.hasActor(2, 'agent-a')).toBe(true)

    // caller 断开：清掉它在所有标签上的数据。
    registry.forgetActorEverywhere('agent-a')
    expect(registry.hasActor(2, 'agent-a')).toBe(false)

    // 关标签：清掉该标签上所有人的数据。
    registry.forgetTab(1)
    expect(registry.hasActor(1, 'agent-b')).toBe(false)
  })

  it('空闲 actor 会被清理，避免标签长期存活时无限增长', () => {
    let clock = 1000
    const registry = new RefRegistry({ now: () => clock, idleTtlMs: 500 })
    registry.recordSnapshot(1, 'agent-a', 'doc-1', [entry('e1')])
    clock = 1400
    registry.recordSnapshot(1, 'agent-b', 'doc-1', [entry('e2')])
    expect(registry.hasActor(1, 'agent-a')).toBe(true)

    clock = 1800
    registry.pruneIdle()
    expect(registry.hasActor(1, 'agent-a')).toBe(false)
    expect(registry.hasActor(1, 'agent-b')).toBe(true)
  })
})
