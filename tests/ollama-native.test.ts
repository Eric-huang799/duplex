import { describe, expect, it } from 'vitest'
import {
  buildOllamaBody,
  isOllamaEndpoint,
  ollamaRoot,
  parseOllamaChunk,
  toOllamaMessages
} from '../src/main/agent/llm/ollama-native'
import type { ChatMessage } from '../src/main/agent/llm/types'

describe('Ollama 端点识别与地址归一', () => {
  it('识别默认端口与回环地址', () => {
    expect(isOllamaEndpoint('http://localhost:11434/v1')).toBe(true)
    expect(isOllamaEndpoint('http://127.0.0.1:11434')).toBe(true)
    expect(isOllamaEndpoint('http://localhost:11434')).toBe(true)
    expect(isOllamaEndpoint('http://192.168.1.20:11434/v1')).toBe(true)
  })

  it('不误判远程 API 与其它本地端口', () => {
    expect(isOllamaEndpoint('https://api.deepseek.com/v1')).toBe(false)
    // LM Studio / llama.cpp 没有 /api/chat，误判会直接把请求打挂
    expect(isOllamaEndpoint('http://localhost:1234/v1')).toBe(false)
    // 显式 /api 路径视为 Ollama 家族（换端口时可用）
    expect(isOllamaEndpoint('http://localhost:8080/api')).toBe(true)
  })

  it('去掉 /v1 与尾斜杠', () => {
    expect(ollamaRoot('http://localhost:11434/v1')).toBe('http://localhost:11434')
    expect(ollamaRoot('http://localhost:11434/v1/')).toBe('http://localhost:11434')
    expect(ollamaRoot('http://localhost:11434/api')).toBe('http://localhost:11434/api')
  })
})

describe('原生请求体', () => {
  it('带上 num_ctx 与工具，且温度归零', () => {
    const body = buildOllamaBody(
      {
        model: 'qwen3:8b',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [
          { type: 'function', function: { name: 'click', description: 'Click.', parameters: {} } }
        ]
      },
      16384
    )
    expect(body.stream).toBe(true)
    expect((body.options as Record<string, unknown>).num_ctx).toBe(16384)
    expect((body.options as Record<string, unknown>).temperature).toBe(0)
    expect(Array.isArray(body.tools)).toBe(true)
  })

  it('没有工具时不发送 tools 字段', () => {
    const body = buildOllamaBody({ model: 'm', messages: [], tools: [] })
    expect('tools' in body).toBe(false)
  })

  it('压缩超长工具描述但保留工具名', () => {
    const body = buildOllamaBody({
      model: 'm',
      messages: [],
      tools: [
        {
          type: 'function',
          function: { name: 'navigate', description: 'Go to a URL. ' + 'x'.repeat(900), parameters: {} }
        }
      ]
    })
    const tool = (body.tools as Array<{ function: { name: string; description: string } }>)[0]!
    expect(tool.function.name).toBe('navigate')
    expect(tool.function.description.length).toBeLessThanOrEqual(281)
  })
})

describe('消息格式转换', () => {
  it('assistant 的工具调用转成对象形式的 arguments', () => {
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'click', arguments: '{"ref":"e2"}' } }
        ]
      },
      { role: 'tool', content: 'ok', tool_call_id: 'c1' }
    ]
    const out = toOllamaMessages(messages)
    expect(out[0]).toEqual({
      role: 'assistant',
      content: '',
      tool_calls: [{ function: { name: 'click', arguments: { ref: 'e2' } } }]
    })
    // 原生接口不认 tool_call_id，只保留角色与内容
    expect(out[1]).toEqual({ role: 'tool', content: 'ok' })
  })

  it('非法 arguments 退化成空对象而不是抛错', () => {
    const out = toOllamaMessages([
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'c', type: 'function', function: { name: 'x', arguments: 'not json' } }]
      }
    ])
    expect(
      (out[0] as { tool_calls: Array<{ function: { arguments: unknown } }> }).tool_calls[0]?.function
        .arguments
    ).toEqual({})
  })
})

describe('NDJSON 行解析', () => {
  it('解析普通文本增量', () => {
    const chunk = parseOllamaChunk('{"message":{"role":"assistant","content":"你好"},"done":false}')
    expect(chunk?.text).toBe('你好')
    expect(chunk?.done).toBe(false)
    expect(chunk?.toolCalls).toEqual([])
  })

  it('解析原生工具调用（arguments 是对象）', () => {
    const chunk = parseOllamaChunk(
      '{"message":{"role":"assistant","content":"","tool_calls":[{"function":{"name":"click","arguments":{"ref":"e5"}}}]},"done":false}'
    )
    expect(chunk?.toolCalls).toEqual([{ name: 'click', arguments: { ref: 'e5' } }])
  })

  it('解析 done_reason', () => {
    const chunk = parseOllamaChunk('{"message":{"content":""},"done":true,"done_reason":"length"}')
    expect(chunk?.done).toBe(true)
    expect(chunk?.doneReason).toBe('length')
  })

  it('坏行返回 null，不抛错', () => {
    expect(parseOllamaChunk('not json')).toBeNull()
    expect(parseOllamaChunk('')).toBeNull()
  })

  it('服务端错误会抛出来', () => {
    expect(() => parseOllamaChunk('{"error":"model not found"}')).toThrow(/model not found/)
  })
})
