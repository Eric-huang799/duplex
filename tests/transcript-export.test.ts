import { describe, expect, it } from 'vitest'
import { exportTranscriptMarkdown, type TranscriptEvent, type TranscriptMeta } from '../src/shared/transcript-export'

const META: TranscriptMeta = {
  title: '排查搜索页',
  startedAt: Date.UTC(2026, 10, 8, 9, 0, 0),
  exportedAt: Date.UTC(2026, 10, 8, 9, 30, 0),
  appVersion: '0.3.0',
  model: 'qwen3:8b'
}

describe('exportTranscriptMarkdown 基本结构', () => {
  it('输出标题、元信息、对话小节，并保持事件顺序', () => {
    const events: TranscriptEvent[] = [
      { kind: 'session', status: 'idle' },
      { kind: 'text', role: 'user', text: '帮我搜一下「林丹」' },
      { kind: 'text', role: 'assistant', text: '先看看页面。\n\n**结果**：\n- 第一条\n- 第二条' },
      {
        kind: 'tool',
        tool: 'search',
        args: { query: '林丹' },
        status: 'completed',
        result: '找到 10 条结果'
      }
    ]

    const md = exportTranscriptMarkdown(events, META)

    expect(md.startsWith('# 排查搜索页\n\n')).toBe(true)
    expect(md).toContain('> 应用版本：0.3.0')
    expect(md).toContain('> 模型：qwen3:8b')
    expect(md).toContain('> 开始时间：2026-11-08 09:00:00 UTC')
    expect(md).toContain('> 导出时间：2026-11-08 09:30:00 UTC')
    expect(md).toContain('> 事件数：4')
    expect(md).toContain('## 对话')
    expect(md).toContain('> 帮我搜一下「林丹」')
    expect(md).toContain('**结果**')

    const lines = md.split('\n')
    expect(lines).toContain('- 🔧 search("林丹") → ok')
    expect(lines).toContain('  > 结果：找到 10 条结果')
    expect(lines).toContain('- 🧭 会话状态：idle')
    expect(md.endsWith('\n')).toBe(true)

    expect(md.indexOf('会话状态')).toBeLessThan(md.indexOf('> 帮我搜一下'))
    expect(md.indexOf('> 帮我搜一下')).toBeLessThan(md.indexOf('- 🔧 search'))
  })

  it('用户多行消息逐行引用，空行也保留引用符', () => {
    const md = exportTranscriptMarkdown(
      [{ kind: 'text', role: 'user', text: '第一行\n\n第三行' }],
      META
    )
    expect(md).toContain('> 第一行\n>\n> 第三行')
  })

  it('助手正文保留 Markdown 原样', () => {
    const body = '## 小结\n\n**重点**：\n\n1. 第一条\n2. 第二条\n\n[链接](https://example.com)'
    const md = exportTranscriptMarkdown([{ kind: 'text', role: 'assistant', text: body }], META)
    expect(md).toContain(body)
  })

  it('没有 role 的文本按助手正文输出', () => {
    const md = exportTranscriptMarkdown([{ kind: 'text', text: '裸文本' }], META)
    expect(md).toContain('裸文本')
  })
})

describe('脱敏', () => {
  it('文本里的密钥键值、sk-*、Bearer、URL 账号密码都替换成 ***', () => {
    const raw = [
      'apiKey: sk-live-ABCDEFGH',
      'token=abc123456',
      'password: hunter2',
      'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9',
      '地址 https://alice:s3cret@example.com/path',
      '密码：open-sesame',
      '裸 key sk-proj-XYZ987654'
    ].join('\n')

    const md = exportTranscriptMarkdown([{ kind: 'text', role: 'assistant', text: raw }], {
      ...META,
      title: 'token=title-secret',
      model: 'sk-model-SECRET'
    })

    for (const secret of [
      'sk-live-ABCDEFGH',
      'abc123456',
      'hunter2',
      'eyJhbGciOiJIUzI1NiJ9',
      'alice',
      's3cret',
      'open-sesame',
      'sk-proj-XYZ987654',
      'title-secret',
      'model-SECRET'
    ]) {
      expect(md).not.toContain(secret)
    }
    expect(md).toContain('***')
    expect(md).toContain('https://***@example.com/path')
    expect(md).toContain('Bearer ***')
  })

  it('args 递归脱敏：键名命中 token/password/secret 时值整段打码', () => {
    const args = {
      nested: {
        token: 'nested-secret',
        list: ['Bearer abc12345', 'https://bob:pw@example.com']
      },
      count: 2,
      flags: [true, false]
    }

    const md = exportTranscriptMarkdown(
      [{ kind: 'tool', tool: 'inspect', args, status: 'completed' }],
      META
    )

    expect(md).not.toContain('nested-secret')
    expect(md).not.toContain('abc12345')
    expect(md).not.toContain('bob')
    expect(md).not.toContain('"pw"')
    expect(md).toContain('"token":"***"')
    expect(md).toContain('"Bearer ***"')
    // 纯函数：不修改调用方传入的参数
    expect(args.nested.token).toBe('nested-secret')
  })

  it('工具结果与状态也会脱敏', () => {
    const md = exportTranscriptMarkdown(
      [
        {
          kind: 'tool',
          tool: 'fetch',
          args: { url: 'https://example.com' },
          status: 'error',
          result: 'Authorization: Bearer abcdefgh123'
        }
      ],
      META
    )
    expect(md).not.toContain('abcdefgh123')
    expect(md).toContain('Bearer ***')
  })

  it('工具参数含循环引用也不抛错', () => {
    const circular: Record<string, unknown> = { count: 1 }
    circular.self = circular

    const md = exportTranscriptMarkdown(
      [{ kind: 'tool', tool: 'loop', args: circular, status: 'completed' }],
      META
    )
    expect(md).toContain('[循环引用]')
  })
})

describe('工具调用渲染', () => {
  it('无参数、错误状态、运行状态各有一条完整工具行', () => {
    const md = exportTranscriptMarkdown(
      [
        { kind: 'tool', tool: 'snapshot', status: 'completed' },
        {
          kind: 'tool',
          tool: 'click',
          args: { ref: 'e3' },
          status: 'error',
          result: 'element not found'
        },
        { kind: 'tool', tool: 'wait', args: { ms: 500 }, status: 'running' },
        { kind: 'tool', tool: 'noop', status: 'completed', result: 'ok' }
      ],
      META
    )

    const lines = md.split('\n')
    expect(lines).toContain('- 🔧 snapshot() → ok')
    expect(lines).toContain('- 🔧 click("e3") → error')
    expect(lines).toContain('- 🔧 wait({"ms":500}) → running')
    expect(lines).toContain('- 🔧 noop() → ok')
    expect(md).toContain('结果：element not found')
    // 成功且结果就是 ok 时不重复写一行
    expect(md).not.toContain('结果：ok')
  })
})

describe('安全与空输入', () => {
  it('把 <script 开标签转义，正文和参数都覆盖', () => {
    const md = exportTranscriptMarkdown(
      [
        { kind: 'text', role: 'user', text: '<script>alert(1)</script>' },
        { kind: 'text', role: 'assistant', text: '<SCRIPT>alert(2)</SCRIPT>' },
        { kind: 'tool', tool: 'type', args: { text: '<script>' }, status: 'completed' }
      ],
      { ...META, title: '<script>标题' }
    )

    expect(md.toLowerCase()).not.toContain('<script')
    expect(md).toContain('&lt;script')
  })

  it('空事件返回最小合法文档，不抛错', () => {
    expect(() => exportTranscriptMarkdown([], META)).not.toThrow()

    const md = exportTranscriptMarkdown([], {
      title: '空对话',
      exportedAt: Date.UTC(2026, 10, 8, 9, 30, 0),
      appVersion: '0.3.0'
    })
    expect(md.startsWith('# 空对话\n\n')).toBe(true)
    expect(md).toContain('## 对话')
    expect(md).toContain('_（本次没有可导出的事件）_')
    expect(md.endsWith('\n')).toBe(true)
  })

  it('空标题与非法时间回退到安全默认值', () => {
    const md = exportTranscriptMarkdown([], {
      title: '   ',
      exportedAt: Number.NaN,
      appVersion: ''
    })
    expect(md.startsWith('# 对话导出')).toBe(true)
    expect(md).toContain('> 应用版本：未知')
    expect(md).toContain('> 导出时间：未知')
  })

  it('只有空白文本事件时也给出空态占位', () => {
    const md = exportTranscriptMarkdown(
      [{ kind: 'text', role: 'assistant', text: '   \n  ' }],
      META
    )
    expect(md).toContain('_（本次没有可导出的事件）_')
  })
})
