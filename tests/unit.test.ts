import { describe, expect, it } from 'vitest'
import { normalizeUrl, resolveAddress } from '../src/shared/url'
import { searchUrl } from '../src/shared/search'
import { buildAnnotationText, type AnnotateInfo } from '../src/main/annotations'
import { MirrorStore } from '../src/main/mirror'
import { SessionBus } from '../src/main/session-bus'
import { buildOpenAiTools } from '../src/main/agent/tools-schema'
import { chatStream, parseToolArguments } from '../src/main/agent/llm'
import { AgentRuntime } from '../src/main/agent/runtime'
import {
  mergeProviders,
  normalizeProviderState,
  providersFromOpencode
} from '../src/main/agent/providers'
import {
  normalizeRawSessions,
  trimSessionsForSave,
  type AgentSession
} from '../src/main/agent/store'

describe('normalizeUrl', () => {
  it('keeps absolute URLs untouched', () => {
    expect(normalizeUrl('https://example.com/a?b=1')).toBe('https://example.com/a?b=1')
    expect(normalizeUrl('about:blank')).toBe('about:blank')
  })

  it('adds https:// to bare domains', () => {
    expect(normalizeUrl('example.com')).toBe('https://example.com')
    expect(normalizeUrl('www.example.com/path')).toBe('https://www.example.com/path')
  })

  it('uses http:// for localhost and loopback', () => {
    expect(normalizeUrl('localhost:3000')).toBe('http://localhost:3000')
    expect(normalizeUrl('127.0.0.1:8080/x')).toBe('http://127.0.0.1:8080/x')
  })

  it('handles empty input', () => {
    expect(normalizeUrl('')).toBe('about:blank')
    expect(normalizeUrl('   ')).toBe('about:blank')
  })
})

describe('resolveAddress (URL vs search)', () => {
  it('treats domains as URLs', () => {
    expect(resolveAddress('example.com')).toEqual({ kind: 'url', url: 'https://example.com' })
    expect(resolveAddress('www.baidu.com/s?wd=x')).toEqual({
      kind: 'url',
      url: 'https://www.baidu.com/s?wd=x'
    })
    expect(resolveAddress('news.ycombinator.com')).toEqual({
      kind: 'url',
      url: 'https://news.ycombinator.com'
    })
  })

  it('treats free text as search queries', () => {
    expect(resolveAddress('python 教程')).toEqual({ kind: 'search', query: 'python 教程' })
    expect(resolveAddress('c++')).toEqual({ kind: 'search', query: 'c++' })
    expect(resolveAddress('python3.12')).toEqual({ kind: 'search', query: 'python3.12' })
    expect(resolveAddress('今天天气怎么样')).toEqual({ kind: 'search', query: '今天天气怎么样' })
  })

  it('keeps protocols, IPs, and localhost as URLs', () => {
    expect(resolveAddress('https://a.com')).toEqual({ kind: 'url', url: 'https://a.com' })
    expect(resolveAddress('file:///C:/x.html')).toEqual({ kind: 'url', url: 'file:///C:/x.html' })
    expect(resolveAddress('localhost:3000')).toEqual({ kind: 'url', url: 'http://localhost:3000' })
    expect(resolveAddress('127.0.0.1:8080/x')).toEqual({
      kind: 'url',
      url: 'http://127.0.0.1:8080/x'
    })
  })
})

describe('searchUrl', () => {
  it('builds a baidu URL by default', () => {
    expect(searchUrl('你好 world')).toBe(
      'https://www.baidu.com/s?wd=' + encodeURIComponent('你好 world')
    )
  })

  it('supports other engines and falls back for unknown ones', () => {
    expect(searchUrl('x', 'bing')).toContain('bing.com/search')
    expect(searchUrl('x', 'google')).toContain('google.com/search')
    expect(searchUrl('x', 'nope')).toContain('baidu.com')
  })
})

describe('MirrorStore.waitForInjections (long-poll delivery)', () => {
  it('returns pending items immediately and TAKES them (single consumer)', async () => {
    const m = new MirrorStore()
    m.addInjection('hello', 'api')
    const t0 = Date.now()
    const items = await m.waitForInjections(5000)
    expect(items.length).toBe(1)
    expect(items[0].text).toBe('hello')
    expect(Date.now() - t0).toBeLessThan(100)
    // taken, not peeked — a second waiter must not see it again
    expect(m.pendingInjections().length).toBe(0)
  })

  it('wakes up as soon as an injection arrives', async () => {
    const m = new MirrorStore()
    const p = m.waitForInjections(5000)
    const t0 = Date.now()
    setTimeout(() => m.addInjection('late', 'api'), 120)
    const items = await p
    const waited = Date.now() - t0
    expect(items.length).toBe(1)
    expect(items[0].text).toBe('late')
    expect(waited).toBeGreaterThanOrEqual(80)
    expect(waited).toBeLessThan(1000)
  })

  it('times out with an empty list', async () => {
    const m = new MirrorStore()
    const t0 = Date.now()
    const items = await m.waitForInjections(200)
    expect(items.length).toBe(0)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(150)
  })

  it('ack removes the item from pending', () => {
    const m = new MirrorStore()
    const inj = m.addInjection('x', 'annotation')
    expect(m.pendingInjections().length).toBe(1)
    m.ackInjection(inj.id)
    expect(m.pendingInjections().length).toBe(0)
  })

  it('dedupes identical events within the window (multi-instance guard)', () => {
    const m = new MirrorStore()
    const push = {
      kind: 'text' as const,
      sessionID: 's1',
      messageID: 'm1',
      partID: 'p1',
      role: 'assistant' as const,
      text: 'hi',
      done: false
    }
    expect(m.add(push)).not.toBeNull()
    expect(m.add(push)).toBeNull()
    expect(m.snapshot().length).toBe(1)
    // a different content for the same part goes through (streaming updates)
    expect(m.add({ ...push, text: 'hi there' })).not.toBeNull()
    expect(m.snapshot().length).toBe(2)
  })
})

describe('SessionBus (session select channel)', () => {
  it('wakes a long-poll as soon as a command arrives, then consumes it', async () => {
    const bus = new SessionBus()
    const p = bus.waitForCommands(5000)
    setTimeout(() => bus.push({ action: 'select', sessionID: 's1' }), 50)
    const cmds = await p
    expect(cmds.length).toBe(1)
    expect(cmds[0].action).toBe('select')
    expect(cmds[0].sessionID).toBe('s1')
    const again = await bus.waitForCommands(100)
    expect(again.length).toBe(0)
  })

  it('returns queued commands immediately', async () => {
    const bus = new SessionBus()
    bus.push({ action: 'list' })
    const cmds = await bus.waitForCommands(1000)
    expect(cmds.length).toBe(1)
    expect(cmds[0].action).toBe('list')
  })

  it('keeps session list state across reports without a list', () => {
    const bus = new SessionBus()
    bus.report({
      activeSessionID: 's2',
      activeTitle: '测试对话',
      sessions: [{ id: 's2', title: '测试对话', updated: 1 }]
    })
    expect(bus.state.activeSessionID).toBe('s2')
    expect(bus.state.activeTitle).toBe('测试对话')
    expect(bus.state.sessions.length).toBe(1)
    bus.report({ activeSessionID: null, reason: 'auto' })
    expect(bus.state.activeSessionID).toBeNull()
    expect(bus.state.sessions.length).toBe(1)
  })

  it('a list report never resets the user selection (multi-instance safety)', () => {
    const bus = new SessionBus()
    bus.select({ sessionID: 'picked', title: '我选的对话' })
    expect(bus.state.activeSessionID).toBe('picked')
    // plugin instance reporting its session list must not clear the pick
    bus.report({ sessions: [{ id: 'x', title: 'x', updated: 1 }], reason: 'listed' })
    expect(bus.state.activeSessionID).toBe('picked')
    expect(bus.state.activeTitle).toBe('我选的对话')
    expect(bus.state.sessions.length).toBe(1)
    // explicit null still clears (back to auto)
    bus.select({ sessionID: null })
    expect(bus.state.activeSessionID).toBeNull()
  })
})

describe('built-in agent mode', () => {
  it('builds OpenAI tool schemas for all MCP tools', () => {
    const tools = buildOpenAiTools()
    expect(tools.length).toBeGreaterThanOrEqual(20)
    const navigate = tools.find((t) => t.function.name === 'navigate')
    expect(navigate).toBeTruthy()
    expect((navigate!.function.parameters as { type?: string }).type).toBe('object')
    expect(navigate!.function.parameters.$schema).toBeUndefined()
    const props = (navigate!.function.parameters as { properties?: Record<string, unknown> })
      .properties
    expect(props && 'url' in props).toBe(true)
  })

  it('parses SSE streams with content and streamed tool calls', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"你好"}}]}',
      'data: {"choices":[{"delta":{"content":"，世界"}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"snapshot","arguments":"{\\"sel"}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ector\\":\\"h1\\"}"}}]}}]}',
      'data: [DONE]',
      ''
    ].join('\n')
    const origFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(sse, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' }
      })) as typeof fetch
    try {
      let streamed = ''
      const r = await chatStream({
        baseUrl: 'https://example.com/v1',
        apiKey: 'k',
        model: 'm',
        messages: [{ role: 'user', content: 'hi' }],
        onTextDelta: (d) => (streamed += d)
      })
      expect(r.text).toBe('你好，世界')
      expect(streamed).toBe('你好，世界')
      expect(r.toolCalls.length).toBe(1)
      expect(r.toolCalls[0].function.name).toBe('snapshot')
      expect(JSON.parse(r.toolCalls[0].function.arguments)).toEqual({ selector: 'h1' })
    } finally {
      globalThis.fetch = origFetch
    }
  })

  it('runs the agent loop: tool call -> execution -> final answer', async () => {
    const execLog: string[] = []
    const exec = async (name: string, args: Record<string, unknown>) => {
      execLog.push(`${name}:${JSON.stringify(args)}`)
      return { content: [{ type: 'text' as const, text: `result-of-${name}` }] }
    }
    const events: Array<Record<string, unknown>> = []
    let turn = 0
    const secondCallMessages: unknown[] = []
    const mockChat = (async (opts: { messages: unknown[] }) => {
      turn++
      if (turn === 1) {
        return {
          text: '',
          toolCalls: [
            {
              id: 'c1',
              type: 'function' as const,
              function: { name: 'navigate', arguments: '{"url":"https://a.com"}' }
            }
          ]
        }
      }
      secondCallMessages.push(...opts.messages)
      return { text: '已完成打开', toolCalls: [] }
    }) as never

    const rt = new AgentRuntime(
      exec as never,
      () => ({ baseUrl: 'https://x/v1', apiKey: 'k', model: 'm' }),
      (ev) => events.push(ev),
      mockChat as never,
      { load: () => [], save: () => undefined } as never
    )
    await rt.send('帮我打开 a.com')

    expect(execLog).toEqual(['navigate:{"url":"https://a.com"}'])
    expect(
      events.some(
        (e) => e.kind === 'tool' && e.status === 'completed' && e.tool === 'navigate'
      )
    ).toBe(true)
    expect(
      events.some((e) => e.kind === 'text' && e.role === 'assistant' && e.text === '已完成打开')
    ).toBe(true)
    const last = events[events.length - 1]
    expect(last.kind).toBe('session')
    expect(last.status).toBe('idle')
    // second LLM call must include the assistant tool_call and the tool result
    expect(
      secondCallMessages.some(
        (m) => (m as { role: string }).role === 'tool' && (m as { content: string }).content === 'result-of-navigate'
      )
    ).toBe(true)
    // and the user message echo must be in the UI stream
    expect(events.some((e) => e.kind === 'text' && e.role === 'user')).toBe(true)
  })

  it('rejects send when not configured', async () => {
    const rt = new AgentRuntime(
      (async () => ({ content: [] })) as never,
      () => ({ baseUrl: '', apiKey: '', model: '' }),
      () => undefined,
      (async () => ({ text: '', toolCalls: [] })) as never,
      { load: () => [], save: () => undefined } as never
    )
    await expect(rt.send('hi')).rejects.toThrow(/尚未配置/)
  })
})

describe('agent provider management (CC-Switch style)', () => {
  it('migrates the legacy single-agent config into a provider entry', () => {
    const r = normalizeProviderState({
      legacyAgent: {
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: 'sk-x',
        model: 'deepseek-chat'
      }
    })
    expect(r.providers.length).toBe(1)
    expect(r.providers[0].name).toBe('默认')
    expect(r.providers[0].model).toBe('deepseek-chat')
    expect(r.activeProviderId).toBe(r.providers[0].id)
  })

  it('normalizes providers and repairs a dangling active id', () => {
    const r = normalizeProviderState({
      providers: [
        { id: 'a', name: 'A', baseUrl: 'https://a.com/v1', apiKey: 'k1', model: 'm1' },
        { name: '', baseUrl: 'https://api.b.com/v1', apiKey: 'k2' }
      ],
      activeProviderId: 'missing'
    })
    expect(r.providers.length).toBe(2)
    expect(r.providers[1].name).toBe('b.com')
    expect(r.activeProviderId).toBe(r.providers[0].id)
  })

  it('extracts providers from an opencode config (key optional for local services) and dedupes on merge', () => {
    const oc = {
      provider: {
        deepseek: {
          options: { apiKey: 'k1', baseURL: 'https://api.deepseek.com/v1' },
          models: { 'deepseek-chat': {} }
        },
        qwen: {
          options: {
            apiKey: 'k2',
            baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1'
          },
          models: { 'qwen-max': {} }
        },
        ollama: {
          options: { baseURL: 'http://localhost:11434/v1' },
          models: { 'qwen2.5:7b': {} }
        },
        broken: { options: {} }
      }
    }
    const imported = providersFromOpencode(oc)
    expect(imported.length).toBe(3)
    expect(imported[0].name).toBe('deepseek')
    expect(imported[0].model).toBe('deepseek-chat')
    const ollama = imported.find((p) => p.name === 'ollama')
    expect(ollama).toBeTruthy()
    expect(ollama!.apiKey).toBe('')
    const first = mergeProviders([], imported)
    expect(first.added).toBe(3)
    const second = mergeProviders(first.providers, imported)
    expect(second.added).toBe(0)
    expect(second.providers.length).toBe(3)
  })

  it('allows keyless providers end to end (Ollama scenario)', async () => {
    const rt = new AgentRuntime(
      (async () => ({ content: [] })) as never,
      () => ({ baseUrl: 'http://localhost:11434/v1', apiKey: '', model: 'qwen2.5:7b' }),
      () => undefined,
      (async () => ({ text: '本地模型回复', toolCalls: [] })) as never,
      { load: () => [], save: () => undefined } as never
    )
    await expect(rt.send('你好')).resolves.toBeUndefined()
  })

  it('keeps sessions isolated: a new session starts empty and context does not leak', async () => {
    let saved: AgentSession[] = []
    const seenMessages: unknown[][] = []
    const mockChat = (async (opts: { messages: unknown[] }) => {
      seenMessages.push(JSON.parse(JSON.stringify(opts.messages)))
      return { text: 'ok', toolCalls: [] }
    }) as never
    const rt = new AgentRuntime(
      (async () => ({ content: [] })) as never,
      () => ({ baseUrl: 'http://x/v1', apiKey: '', model: 'm' }),
      () => undefined,
      mockChat,
      {
        load: () => [],
        save: (s: AgentSession[]) => {
          saved = s
        }
      } as never
    )
    await rt.send('第一句')
    expect(rt.events().length).toBeGreaterThan(1)
    rt.newSession()
    // a fresh session shows only the switched marker — empty conversation view
    expect(rt.events().length).toBe(1)
    await rt.send('第二句')
    const secondCall = seenMessages[seenMessages.length - 1].map((m) =>
      String((m as { content?: unknown }).content ?? '')
    )
    expect(secondCall.some((c) => c.includes('第二句'))).toBe(true)
    expect(secondCall.some((c) => c.includes('第一句'))).toBe(false)
    expect(saved.length).toBe(2)
  })
})

describe('agent session store (history persistence)', () => {
  it('normalizes raw sessions, repairs fields and sorts by recency', () => {
    const out = normalizeRawSessions([
      { id: 's1', title: 'A', createdAt: 1, updatedAt: 5, messages: [], uiEvents: [] },
      { bad: true },
      { id: 's2', title: '', updatedAt: 9, messages: [], uiEvents: [] }
    ])
    expect(out.length).toBe(2)
    expect(out[0].id).toBe('s2')
    expect(out[0].title).toBe('新对话')
  })

  it('trims long histories but keeps the system prompt', () => {
    const msgs = [
      { role: 'system' as const, content: 'sys' },
      ...Array.from({ length: 300 }, (_, i) => ({ role: 'user' as const, content: `m${i}` }))
    ]
    const s: AgentSession = {
      id: 'x',
      title: 't',
      createdAt: 1,
      updatedAt: 1,
      messages: msgs,
      uiEvents: Array.from({ length: 700 }, (_, i) => ({ i }))
    }
    const [trimmed] = trimSessionsForSave([s])
    expect(trimmed.messages.length).toBe(200)
    expect(trimmed.messages[0].content).toBe('sys')
    expect(trimmed.uiEvents.length).toBe(500)
  })

  it('creates/switches/deletes sessions and persists via injected store', () => {
    let saved: AgentSession[] = []
    const rt = new AgentRuntime(
      (async () => ({ content: [] })) as never,
      () => ({ baseUrl: 'http://x/v1', apiKey: '', model: 'm' }),
      () => undefined,
      (async () => ({ text: '', toolCalls: [] })) as never,
      {
        load: () => [],
        save: (s: AgentSession[]) => {
          saved = s
        }
      } as never
    )
    const first = rt.currentSessionId
    expect(rt.newSession().ok).toBe(true)
    const second = rt.currentSessionId
    expect(second).not.toBe(first)
    expect(rt.listSessions().length).toBe(2)
    expect(rt.listSessions()[0].current).toBe(true)
    expect(rt.switchSession(first).ok).toBe(true)
    expect(rt.currentSessionId).toBe(first)
    expect(rt.deleteSession(first).ok).toBe(true)
    expect(rt.currentSessionId).toBe(second)
    expect(saved.length).toBeGreaterThan(0)
  })
})

describe('local-model hardening (tolerant parsing + watchdogs)', () => {
  it('parses almost-JSON tool arguments from weak models', () => {
    expect(parseToolArguments('{"url":"https://a.com"}')).toEqual({
      ok: true,
      value: { url: 'https://a.com' }
    })
    expect(parseToolArguments('```json\n{"url":"https://b.com"}\n```')).toEqual({
      ok: true,
      value: { url: 'https://b.com' }
    })
    expect(parseToolArguments('{"url":"https://c.com",}')).toEqual({
      ok: true,
      value: { url: 'https://c.com' }
    })
    expect(parseToolArguments('好的，调用工具：{"url":"https://d.com"} 完成')).toEqual({
      ok: true,
      value: { url: 'https://d.com' }
    })
    expect(parseToolArguments('')).toEqual({ ok: true, value: {} })
    expect(parseToolArguments('完全不是 JSON').ok).toBe(false)
  })

  it('feeds parse failures back to the model and stops after 3 in a row', async () => {
    const events: Array<Record<string, unknown>> = []
    const mockChat = (async () => ({
      text: '',
      toolCalls: [
        {
          id: 'c1',
          type: 'function' as const,
          function: { name: 'navigate', arguments: 'NOT JSON AT ALL' }
        }
      ]
    })) as never
    const rt = new AgentRuntime(
      (async () => ({ content: [] })) as never,
      () => ({ baseUrl: 'http://x/v1', apiKey: '', model: 'm' }),
      (ev) => events.push(ev),
      mockChat,
      { load: () => [], save: () => undefined } as never
    )
    await rt.send('test')
    const failedTools = events.filter((e) => e.kind === 'tool' && e.status === 'error')
    expect(failedTools.length).toBe(3)
    expect(
      events.some(
        (e) => e.kind === 'session' && typeof e.error === 'string' && String(e.error).length > 0
      )
    ).toBe(true)
  })

  it('aborts a stream that goes silent (idle watchdog)', async () => {
    const origFetch = globalThis.fetch
    globalThis.fetch = (async (_url: string, init?: { signal?: AbortSignal }) => {
      // simulate a real fetch body: the stream errors when the signal aborts
      const stream = new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener('abort', () =>
            controller.error(new DOMException('Aborted', 'AbortError'))
          )
        }
      })
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }) as typeof fetch
    try {
      await expect(
        chatStream({
          baseUrl: 'http://x/v1',
          apiKey: '',
          model: 'm',
          messages: [{ role: 'user', content: 'hi' }],
          idleTimeoutMs: 80
        })
      ).rejects.toThrow(/超时/)
    } finally {
      globalThis.fetch = origFetch
    }
  })
})

describe('buildAnnotationText (code-layer structured description)', () => {
  const info: AnnotateInfo = {
    url: 'https://example.com/post/42',
    title: 'Example Post',
    scroll: { x: 0, y: 120 },
    viewport: { w: 1280, h: 800 },
    elements: [
      {
        tag: 'button',
        id: 'load-more',
        interactive: true,
        hits: 6,
        selector: '#load-more',
        text: '加载更多'
      },
      {
        tag: 'ul',
        classes: ['comments'],
        interactive: false,
        hits: 9,
        selector: 'main > ul.comments',
        text: '评论列表'
      }
    ],
    primary: [
      {
        tag: 'button',
        id: 'load-more',
        interactive: true,
        hits: 6,
        selector: '#load-more',
        text: '加载更多'
      }
    ],
    anchor: { selector: '#post-42 > .comments', tag: 'div', text: '评论 (12)' },
    text: '评论 (12) 加载更多',
    points: [],
    elementCount: 2
  }

  it('includes the question, anchor, elements and follow-up hint', () => {
    const t = buildAnnotationText(info, { tool: 'rect', question: '为什么不分页？' })
    expect(t).toContain('用户页面标注')
    expect(t).toContain('用户问题: 为什么不分页？')
    expect(t).toContain('区域锚点: #post-42 > .comments')
    expect(t).toContain('#load-more')
    expect(t).toContain('加载更多')
    expect(t).toContain('框内可见文本')
    expect(t).toContain('滚动: Y=120')
    expect(t).toContain('query / get_html')
    // machine-usable selectors must be present for non-vision models
    expect(t).toContain('#post-42 > .comments')
  })

  it('describes arrow point relations including empty space', () => {
    const t = buildAnnotationText(
      {
        ...info,
        points: [
          {
            tag: 'start',
            el: {
              tag: 'button',
              id: 'a',
              interactive: true,
              hits: 1,
              selector: '#a',
              text: '按钮A'
            }
          },
          { tag: 'end', el: null }
        ]
      },
      { tool: 'arrow' }
    )
    expect(t).toContain('指向关系')
    expect(t).toContain('按钮A')
    expect(t).toContain('（空白处）')
  })
})
