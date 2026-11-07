import { describe, expect, it } from 'vitest'
import { repairToolCallsFromText } from '../src/main/agent/llm/tool-repair'
import { compactToolDescriptions, isLocalEndpoint } from '../src/main/agent/llm/openai-chat'

const NAMES = ['click', 'navigate', 'snapshot', 'type'] as const

describe('repairToolCallsFromText', () => {
  it('识别代码块里的 JSON 调用，并把那段从正文里摘掉', () => {
    const text = '我先看一下页面。\n```json\n{"name":"snapshot","arguments":{}}\n```'
    const r = repairToolCallsFromText(text, NAMES)
    expect(r.toolCalls).toHaveLength(1)
    expect(r.toolCalls[0]?.function.name).toBe('snapshot')
    expect(r.toolCalls[0]?.function.arguments).toBe('{}')
    expect(r.text).toContain('我先看一下页面')
    expect(r.text).not.toContain('snapshot')
  })

  it('识别正文里的裸 JSON', () => {
    const r = repairToolCallsFromText('{"tool":"navigate","args":{"url":"https://a.example"}}', NAMES)
    expect(r.toolCalls[0]?.function.name).toBe('navigate')
    expect(JSON.parse(r.toolCalls[0]!.function.arguments)).toEqual({ url: 'https://a.example' })
  })

  it('识别 <tool_call> XML', () => {
    const r = repairToolCallsFromText('<tool_call>{"name":"click","parameters":{"ref":"e3"}}</tool_call>', NAMES)
    expect(r.toolCalls[0]?.function.name).toBe('click')
    expect(JSON.parse(r.toolCalls[0]!.function.arguments)).toEqual({ ref: 'e3' })
  })

  it('识别 name({...}) 函数写法', () => {
    const r = repairToolCallsFromText('navigate({"url":"https://b.example"})', NAMES)
    expect(r.toolCalls[0]?.function.name).toBe('navigate')
  })

  it('识别数组形式的多调用，并封顶', () => {
    const r = repairToolCallsFromText(
      '[{"name":"click","arguments":{"ref":"e1"}},{"name":"snapshot","arguments":{}}]',
      NAMES
    )
    expect(r.toolCalls.map((c) => c.function.name)).toEqual(['click', 'snapshot'])
  })

  it('工具名不在名单里时不认（宁可漏认也不误执行）', () => {
    const r = repairToolCallsFromText('{"name":"rm_rf","arguments":{"path":"/"}}', NAMES)
    expect(r.toolCalls).toEqual([])
    expect(r.text).toContain('rm_rf')
  })

  it('普通 JSON 不会被当成工具调用', () => {
    const text = '接口返回 {"ok": true, "count": 3}，继续看。'
    const r = repairToolCallsFromText(text, NAMES)
    expect(r.toolCalls).toEqual([])
    expect(r.text).toBe(text)
  })

  it('没有工具名单时直接原样返回', () => {
    const r = repairToolCallsFromText('{"name":"click","arguments":{}}', [])
    expect(r.toolCalls).toEqual([])
  })

  it('字符串里的花括号不会打乱配平', () => {
    const r = repairToolCallsFromText(
      '{"name":"type","arguments":{"text":"a {weird} json"}}',
      NAMES
    )
    expect(r.toolCalls[0]?.function.name).toBe('type')
    expect(JSON.parse(r.toolCalls[0]!.function.arguments)).toEqual({ text: 'a {weird} json' })
  })
})

describe('本地端点探测与工具描述压缩', () => {
  it('识别本地地址', () => {
    expect(isLocalEndpoint('http://localhost:11434/v1')).toBe(true)
    expect(isLocalEndpoint('http://127.0.0.1:1234/v1')).toBe(true)
    expect(isLocalEndpoint('http://192.168.1.9:11434/v1')).toBe(true)
    expect(isLocalEndpoint('https://api.deepseek.com/v1')).toBe(false)
  })

  it('压缩长描述但保留首句含义与工具名', () => {
    const tools = [
      {
        type: 'function' as const,
        function: {
          name: 'click',
          description: 'Click an element. ' + 'x'.repeat(600),
          parameters: {}
        }
      }
    ]
    const out = compactToolDescriptions(tools)
    expect(out[0]?.function.name).toBe('click')
    expect(out[0]?.function.description.length).toBeLessThanOrEqual(281)
    expect(out[0]?.function.description.startsWith('Click an element')).toBe(true)
    // 不修改入参
    expect(tools[0]?.function.description.length).toBeGreaterThan(600)
  })
})
