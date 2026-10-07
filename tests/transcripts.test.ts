/**
 * Unit tests for external agent transcript parsers (Codex / Claude Code /
 * generic JSONL) using fixtures shaped like the real files.
 */
import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  claudeLineMessages,
  codexLineMessages,
  customLineMessages,
  decodeUtf8Complete,
  listClaudeSessions,
  listCodexSessions,
  readClaudeSession,
  readCodexSession,
  readGeminiSession
} from '../src/main/integrations/transcripts'

describe('codex transcript parser', () => {
  it('extracts user and assistant messages', () => {
    const user = {
      timestamp: '2026-08-23T10:14:10.054Z',
      type: 'response_item',
      payload: {
        type: 'message',
        id: 'm1',
        role: 'user',
        content: [{ type: 'input_text', text: 'Reply with exactly: OK' }]
      }
    }
    expect(codexLineMessages(user)).toEqual([
      { role: 'user', text: 'Reply with exactly: OK', ts: Date.parse('2026-08-23T10:14:10.054Z') }
    ])
    const asst = {
      timestamp: '2026-08-23T10:14:15.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        id: 'm2',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'OK' }]
      }
    }
    expect(codexLineMessages(asst)).toEqual([
      { role: 'assistant', text: 'OK', ts: Date.parse('2026-08-23T10:14:15.000Z') }
    ])
  })

  it('skips developer role and injected system blocks', () => {
    expect(
      codexLineMessages({
        type: 'response_item',
        payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'x' }] }
      })
    ).toEqual([])
    expect(
      codexLineMessages({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '<recommended_plugins>\n...' }]
        }
      })
    ).toEqual([])
    expect(
      codexLineMessages({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '<permissions instructions> x' }]
        }
      })
    ).toEqual([])
  })

  it('ignores non-message lines', () => {
    expect(codexLineMessages({ type: 'session_meta', payload: { session_id: 'x' } })).toEqual([])
    expect(codexLineMessages({ type: 'event_msg', payload: { type: 'task_started' } })).toEqual([])
    expect(codexLineMessages({ type: 'world_state', payload: {} })).toEqual([])
  })
})

describe('claude transcript parser', () => {
  it('extracts plain and array user content', () => {
    expect(
      claudeLineMessages({
        type: 'user',
        timestamp: '2026-08-04T14:33:22.980Z',
        message: { role: 'user', content: '帮我看看我刚才部署的东西' }
      })
    ).toEqual([
      { role: 'user', text: '帮我看看我刚才部署的东西', ts: Date.parse('2026-08-04T14:33:22.980Z') }
    ])
    expect(
      claudeLineMessages({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'hi' }] }
      })[0].text
    ).toBe('hi')
  })

  it('skips meta and local command lines', () => {
    expect(claudeLineMessages({ type: 'user', isMeta: true, message: { content: 'x' } })).toEqual([])
    expect(
      claudeLineMessages({ type: 'user', message: { content: '<command-name>/clear</command-name>' } })
    ).toEqual([])
  })

  it('extracts assistant text blocks only', () => {
    const msg = claudeLineMessages({
      type: 'assistant',
      timestamp: '2026-08-04T14:34:00.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'first' },
          { type: 'tool_use', name: 'x' },
          { type: 'text', text: 'second' }
        ]
      }
    })
    expect(msg).toEqual([
      { role: 'assistant', text: 'first\nsecond', ts: Date.parse('2026-08-04T14:34:00.000Z') }
    ])
  })
})

describe('custom generic parser', () => {
  it('handles common role/text shapes', () => {
    expect(customLineMessages({ role: 'user', content: 'hello' })[0]).toMatchObject({
      role: 'user',
      text: 'hello'
    })
    expect(
      customLineMessages({ type: 'assistant', message: { content: [{ type: 'text', text: 'yo' }] } })[0]
    ).toMatchObject({ role: 'assistant', text: 'yo' })
    expect(customLineMessages({ type: 'system', content: 'x' })).toEqual([])
    expect(customLineMessages({ role: 'user', text: '' })).toEqual([])
  })

  it('falls through an empty text field to content', () => {
    expect(customLineMessages({ role: 'user', text: '', content: 'real-text' })[0]).toMatchObject({
      role: 'user',
      text: 'real-text'
    })
  })
})

describe('list/read against temp fixtures', () => {
  it('lists codex sessions (only rollout-*) with parsed titles', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplex-tr-'))
    try {
      const good = path.join(dir, 'rollout-2026-01-01T00-00-00-abc.jsonl')
      fs.writeFileSync(
        good,
        [
          JSON.stringify({ timestamp: '2026-01-01T00:00:00Z', type: 'session_meta', payload: {} }),
          JSON.stringify({
            timestamp: '2026-01-01T00:00:01Z',
            type: 'response_item',
            payload: {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: '我的第一个问题' }]
            }
          }),
          JSON.stringify({
            timestamp: '2026-01-01T00:00:02Z',
            type: 'response_item',
            payload: {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: '答案' }]
            }
          })
        ].join('\n')
      )
      fs.writeFileSync(path.join(dir, 'not-a-rollout.jsonl'), '{}\n')
      const list = listCodexSessions(dir)
      expect(list).toHaveLength(1)
      expect(list[0].title).toBe('我的第一个问题')
      const msgs = readCodexSession(good)
      expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant'])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('lists claude sessions excluding agent-* files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplex-tr-'))
    try {
      const proj = path.join(dir, 'C--Users-test')
      fs.mkdirSync(proj)
      const s1 = path.join(proj, '11111111-2222-3333-4444-555555555555.jsonl')
      fs.writeFileSync(
        s1,
        JSON.stringify({
          type: 'user',
          timestamp: '2026-01-01T00:00:01Z',
          message: { role: 'user', content: 'claude 的问题' }
        })
      )
      fs.writeFileSync(path.join(proj, 'agent-abc.jsonl'), '{}\n')
      const list = listClaudeSessions(dir)
      expect(list).toHaveLength(1)
      expect(list[0].title).toBe('claude 的问题')
      expect(readClaudeSession(s1)).toHaveLength(1)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('readGeminiSession tolerates corrupt and missing files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplex-tr-'))
    try {
      const f = path.join(dir, 'bad.json')
      fs.writeFileSync(f, 'not-json{{{')
      expect(readGeminiSession(f)).toEqual([])
      expect(readGeminiSession(path.join(dir, 'missing.json'))).toEqual([])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('parses only the tail of files larger than 20MB', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplex-tr-big-'))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const f = path.join(dir, 'rollout-big.jsonl')
      const filler = JSON.stringify({
        timestamp: '2026-01-01T00:00:00Z',
        type: 'event_msg',
        payload: { type: 'token_count', padding: 'x'.repeat(1024) }
      })
      const fd = fs.openSync(f, 'w')
      try {
        const chunk = filler + '\n'
        for (let written = 0; written < 21 * 1024 * 1024; written += chunk.length) {
          fs.writeSync(fd, chunk)
        }
        fs.writeSync(
          fd,
          JSON.stringify({
            timestamp: '2026-01-01T00:10:00Z',
            type: 'response_item',
            payload: {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: 'tail question' }]
            }
          }) + '\n'
        )
      } finally {
        fs.closeSync(fd)
      }
      const msgs = readCodexSession(f)
      expect(msgs.map((m) => m.text)).toContain('tail question')
      expect(errSpy).toHaveBeenCalled()
    } finally {
      errSpy.mockRestore()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('decodeUtf8Complete', () => {
  it('keeps complete characters at the buffer end', () => {
    expect(decodeUtf8Complete(Buffer.from('hello你', 'utf8'))).toBe('hello你')
    const full = Buffer.from('a你', 'utf8')
    expect(decodeUtf8Complete(full)).toBe('a你')
  })

  it('drops a multi-byte character split by the truncation point', () => {
    const buf = Buffer.from('abc你', 'utf8') // 你 = 3 bytes
    expect(decodeUtf8Complete(buf.subarray(0, buf.length - 1))).toBe('abc')
    expect(decodeUtf8Complete(buf.subarray(0, buf.length - 2))).toBe('abc')
    const emoji = Buffer.from('x😀', 'utf8') // 😀 = 4 bytes
    expect(decodeUtf8Complete(emoji.subarray(0, emoji.length - 3))).toBe('x')
  })
})
