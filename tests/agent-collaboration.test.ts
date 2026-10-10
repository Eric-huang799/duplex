import { describe, expect, it } from 'vitest'
import { AgentRuntime, type AgentDeps } from '../src/main/agent/runtime'

const config = () => ({ baseUrl: 'http://x/v1', apiKey: '', model: 'm', protocol: 'openai-chat' as const, authType: 'key' as const, providerName: 'test' })

describe('built-in task context', () => {
  it('waits for the canceled tool to settle before starting a replacement instruction', async () => {
    let settleTool!: (result: { content: [] }) => void
    let ready!: () => void
    const started = new Promise<void>(r => { ready = r })
    let turns = 0
    const rt = new AgentRuntime(async () => new Promise(resolve => { settleTool = resolve; ready() }), config, () => undefined,
      (async () => ++turns === 1 ? { text: '', toolCalls: [{ id: 'a', type: 'function', function: { name: 'click', arguments: '{}' } }] } : { text: 'new instruction done', toolCalls: [] }) as never,
      { load: () => [], save: () => undefined, cancelTools: () => undefined })
    const first = rt.send('old instruction')
    await started
    const second = rt.send('replacement', { interrupt: true })
    await Promise.resolve(); await Promise.resolve()
    expect(rt.isRunning).toBe(true)
    expect(turns).toBe(1)
    settleTool({ content: [] })
    await Promise.all([first, second])
    expect(turns).toBe(2)
  })
  it('ordinary stop cancels the tools as well as the model', async () => {
    let cancel = 0
    let settleTool!: (result: { content: [] }) => void
    let started!: () => void
    const ready = new Promise<void>(r => { started = r })
    const rt = new AgentRuntime(async () => { started(); return new Promise(resolve => { settleTool = resolve }) }, config, () => undefined,
      (async () => ({ text: '', toolCalls: [{ id: 'a', type: 'function', function: { name: 'wait', arguments: '{}' } }] })) as never,
      { load: () => [], save: () => undefined, cancelTools: () => { cancel++; settleTool({ content: [] }) } } as AgentDeps)
    const running = rt.send('wait')
    await ready
    rt.abort()
    await running
    expect(cancel).toBe(1)
  })

  it('captures the tab when a message is queued rather than at later execution', async () => {
    let active = 1
    const targets: Array<number | undefined> = []
    const origins: Array<boolean | undefined> = []
    let release!: () => void
    const wait = new Promise<void>(r => { release = r })
    let calls = 0
    let secondStarted!: () => void
    const second = new Promise<void>(r => { secondStarted = r })
    const rt = new AgentRuntime(async () => ({ content: [] }), config, () => undefined,
      (async () => { if (++calls === 1) await wait; else secondStarted(); return { text: 'done', toolCalls: [] } }) as never,
      { load: () => [], save: () => undefined, getActiveTabId: () => active, onRunStart: (id?: number, opts?: { fromQueue?: boolean }) => { targets.push(id); origins.push(opts?.fromQueue) } } as AgentDeps)
    const first = rt.send('one')
    active = 2
    await rt.send('two')
    active = 3
    release()
    await first; await second
    expect(targets).toEqual([1, 2])
    expect(origins).toEqual([undefined, true])
  })

  it('drops a pending automatic send when the conversation changes', async () => {
    let release!: () => void
    const wait = new Promise<void>(r => { release = r })
    let calls = 0
    const rt = new AgentRuntime(async () => ({ content: [] }), config, () => undefined,
      (async () => { calls++; await wait; return { text: 'done', toolCalls: [] } }) as never,
      { load: () => [], save: () => undefined })
    const first = rt.send('one')
    await rt.send('queued in old conversation')
    release(); await first
    expect(rt.newSession()).toEqual({ ok: true })
    await new Promise(r => setTimeout(r, 100))
    expect(calls).toBe(1)
  })

  it('adds an annotation at a turn boundary without mutating the in-flight model request', async () => {
    let release!: () => void
    const wait = new Promise<void>(r => { release = r })
    let packet!: { messages: Array<{ content: unknown }> }
    const rt = new AgentRuntime(async () => ({ content: [] }), config, () => undefined,
      (async (request: typeof packet) => { packet = request; await wait; return { text: 'done', toolCalls: [] } }) as never,
      { load: () => [], save: () => undefined })
    const first = rt.send('one')
    rt.injectAnnotation('annotation on tab 1', { summary: 'selection', url: 'https://fixture', annotationId: 'a', tool: 'point', elementCount: 1, tabId: 1 })
    expect(packet.messages.some(m => m.content === 'annotation on tab 1')).toBe(false)
    release(); await first
    expect(packet.messages.some(m => m.content === 'annotation on tab 1')).toBe(true)
  })
})
