/**
 * Unit tests for the multi-protocol LLM adapters: each protocol parses a
 * mocked SSE stream and converts messages to its wire format.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { chatStream } from '../src/main/agent/llm'
import { toAnthropicMessages } from '../src/main/agent/llm/anthropic'
import { toResponsesInput } from '../src/main/agent/llm/openai-responses'
import { toGeminiContents } from '../src/main/agent/llm/gemini'
import type { ChatMessage } from '../src/main/agent/llm'

function sseResponse(lines: string[]): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const l of lines) controller.enqueue(encoder.encode(l + '\n'))
      controller.close()
    }
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function mockFetch(lines: string[]): ReturnType<typeof vi.fn> {
  const fn = vi.fn().mockResolvedValue(sseResponse(lines))
  vi.stubGlobal('fetch', fn)
  return fn
}

afterEach(() => {
  vi.unstubAllGlobals()
})

const base = { baseUrl: 'https://example.test', apiKey: 'K', model: 'm' }

describe('openai-chat protocol', () => {
  it('accumulates text and streamed tool-call arguments', async () => {
    const fn = mockFetch([
      'data: {"choices":[{"delta":{"content":"你好"}}]}',
      'data: {"choices":[{"delta":{"content":"，世界"}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"click","arguments":"{\\"tar"}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"get\\":\\"e1\\"}"}}]}}]}',
      'data: [DONE]'
    ])
    const deltas: string[] = []
    const res = await chatStream({ ...base, messages: [{ role: 'user', content: 'hi' }], onTextDelta: (d) => deltas.push(d) })
    expect(res.text).toBe('你好，世界')
    expect(deltas.join('')).toBe('你好，世界')
    expect(res.toolCalls).toHaveLength(1)
    expect(res.toolCalls[0].id).toBe('call_1')
    expect(res.toolCalls[0].function.name).toBe('click')
    expect(res.toolCalls[0].function.arguments).toBe('{"target":"e1"}')
    expect(fn.mock.calls[0][0]).toBe('https://example.test/chat/completions')
  })

  it('respects a baseUrl that already ends with /chat/completions', async () => {
    const fn = mockFetch(['data: {"choices":[{"delta":{"content":"x"}}]}'])
    await chatStream({ ...base, baseUrl: 'https://x.test/v1/chat/completions', messages: [] })
    expect(fn.mock.calls[0][0]).toBe('https://x.test/v1/chat/completions')
  })

  it('rejects on non-2xx HTTP status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 500 })))
    await expect(
      chatStream({ ...base, messages: [{ role: 'user', content: 'x' }] })
    ).rejects.toThrow('模型接口返回 500')
  })
})

describe('anthropic-messages protocol', () => {
  it('splits the system message and merges tool results', () => {
    const msgs: ChatMessage[] = [
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'a', arguments: '{"x":1}' } },
          { id: 'c2', type: 'function', function: { name: 'b', arguments: '{}' } }
        ]
      },
      { role: 'tool', tool_call_id: 'c1', content: 'R1' },
      { role: 'tool', tool_call_id: 'c2', content: 'R2' }
    ]
    const { system, messages } = toAnthropicMessages(msgs)
    expect(system).toBe('SYS')
    expect(messages).toHaveLength(3)
    expect(messages[0]).toEqual({ role: 'user', content: 'hi' })
    const assistant = messages[1]
    expect(assistant.role).toBe('assistant')
    const blocks = assistant.content as Array<Record<string, unknown>>
    expect(blocks[0]).toEqual({ type: 'tool_use', id: 'c1', name: 'a', input: { x: 1 } })
    expect(blocks[1]).toEqual({ type: 'tool_use', id: 'c2', name: 'b', input: {} })
    const toolTurn = messages[2]
    expect(toolTurn.role).toBe('user')
    const results = toolTurn.content as Array<Record<string, unknown>>
    expect(results).toHaveLength(2)
    expect(results[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'c1', content: 'R1' })
    expect(results[1]).toMatchObject({ type: 'tool_result', tool_use_id: 'c2', content: 'R2' })
  })

  it('parses text and tool_use stream events', async () => {
    const fn = mockFetch([
      'data: {"type":"message_start"}',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"好的"}}',
      'data: {"type":"content_block_stop","index":0}',
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu_1","name":"snapshot"}}',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"tabId\\":"}}',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"1}"}}',
      'data: {"type":"content_block_stop","index":1}',
      'data: {"type":"message_stop"}'
    ])
    const res = await chatStream({
      ...base,
      baseUrl: 'https://api.anthropic.com',
      protocol: 'anthropic-messages',
      messages: [{ role: 'user', content: 'hi' }]
    })
    expect(res.text).toBe('好的')
    expect(res.toolCalls).toHaveLength(1)
    expect(res.toolCalls[0]).toMatchObject({
      id: 'tu_1',
      function: { name: 'snapshot', arguments: '{"tabId":1}' }
    })
    expect(fn.mock.calls[0][0]).toBe('https://api.anthropic.com/v1/messages')
    const init = fn.mock.calls[0][1] as RequestInit
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('K')
    expect((init.headers as Record<string, string>)['anthropic-version']).toBeTruthy()
  })

  it('surfaces in-stream error events', async () => {
    mockFetch(['data: {"type":"error","error":{"message":"overloaded"}}'])
    await expect(
      chatStream({
        ...base,
        protocol: 'anthropic-messages',
        messages: [{ role: 'user', content: 'x' }]
      })
    ).rejects.toThrow('overloaded')
  })
})

describe('openai-responses protocol', () => {
  it('converts messages to responses input items', () => {
    const msgs: ChatMessage[] = [
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: 'thinking',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'a', arguments: '{}' } }]
      },
      { role: 'tool', tool_call_id: 'c1', content: 'R1' }
    ]
    const input = toResponsesInput(msgs) as Array<Record<string, unknown>>
    expect(input[0]).toEqual({ role: 'system', content: 'SYS' })
    expect(input[1]).toEqual({ role: 'user', content: 'hi' })
    expect(input[2]).toEqual({ role: 'assistant', content: 'thinking' })
    expect(input[3]).toEqual({ type: 'function_call', call_id: 'c1', name: 'a', arguments: '{}' })
    expect(input[4]).toEqual({ type: 'function_call_output', call_id: 'c1', output: 'R1' })
  })

  it('parses function_call stream events', async () => {
    const fn = mockFetch([
      'data: {"type":"response.output_item.added","item":{"type":"function_call","id":"item_1","call_id":"call_abc","name":"navigate"}}',
      'data: {"type":"response.function_call_arguments.delta","item_id":"item_1","delta":"{\\"url\\""}',
      'data: {"type":"response.function_call_arguments.delta","item_id":"item_1","delta":":\\"https://x\\"}"}',
      'data: {"type":"response.output_text.delta","delta":"done"}',
      'data: {"type":"response.completed"}'
    ])
    const res = await chatStream({
      ...base,
      protocol: 'openai-responses',
      messages: [{ role: 'user', content: 'go' }]
    })
    expect(res.text).toBe('done')
    expect(res.toolCalls).toHaveLength(1)
    expect(res.toolCalls[0].id).toBe('call_abc')
    expect(res.toolCalls[0].function.name).toBe('navigate')
    expect(res.toolCalls[0].function.arguments).toBe('{"url":"https://x"}')
    expect(fn.mock.calls[0][0]).toBe('https://example.test/v1/responses')
  })

  it('surfaces response.failed events', async () => {
    mockFetch(['data: {"type":"response.failed","response":{"error":{"message":"boom"}}}'])
    await expect(
      chatStream({
        ...base,
        protocol: 'openai-responses',
        messages: [{ role: 'user', content: 'x' }]
      })
    ).rejects.toThrow('boom')
  })
})

describe('gemini protocol', () => {
  it('converts messages to contents with functionResponse names resolved', () => {
    const msgs: ChatMessage[] = [
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'list_tabs', arguments: '{}' } }]
      },
      { role: 'tool', tool_call_id: 'c1', content: 'R1' }
    ]
    const { system, contents } = toGeminiContents(msgs)
    expect(system).toBe('SYS')
    expect(contents[0]).toEqual({ role: 'user', parts: [{ text: 'hi' }] })
    expect(contents[1].role).toBe('model')
    expect(contents[1].parts[0]).toEqual({ functionCall: { name: 'list_tabs', args: {} } })
    expect(contents[2].role).toBe('user')
    expect(contents[2].parts[0]).toEqual({
      functionResponse: { name: 'list_tabs', response: { output: 'R1' } }
    })
  })

  it('parses text and functionCall parts', async () => {
    const fn = mockFetch([
      'data: {"candidates":[{"content":{"parts":[{"text":"你好"}]}}]}',
      'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"list_tabs","args":{}}}]}}]}'
    ])
    const res = await chatStream({
      ...base,
      protocol: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com',
      messages: [{ role: 'user', content: 'go' }]
    })
    expect(res.text).toBe('你好')
    expect(res.toolCalls).toHaveLength(1)
    expect(res.toolCalls[0].function.name).toBe('list_tabs')
    expect(fn.mock.calls[0][0]).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/m:streamGenerateContent?alt=sse'
    )
  })
})
