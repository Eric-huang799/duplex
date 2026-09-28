/**
 * Unit tests for the external-agent adapter layer: command-line splitting,
 * headless start plans, and the Gemini-family / generic-JSON transcript
 * readers.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildStartPlan, splitCommandLine } from '../src/main/integrations/agents'
import {
  geminiJsonToMessages,
  listGeminiSessions,
  readCustomSession
} from '../src/main/integrations/transcripts'

const isWin = process.platform === 'win32'

describe('splitCommandLine', () => {
  it('splits plain tokens', () => {
    expect(splitCommandLine('gemini -p')).toEqual(['gemini', '-p'])
  })
  it('supports quotes', () => {
    expect(splitCommandLine('my-agent --prompt "hello world" --flag')).toEqual([
      'my-agent',
      '--prompt',
      'hello world',
      '--flag'
    ])
    expect(splitCommandLine("a 'b c'")).toEqual(['a', 'b c'])
  })
  it('collapses whitespace and handles empties', () => {
    expect(splitCommandLine('  a   b ')).toEqual(['a', 'b'])
    expect(splitCommandLine('')).toEqual([])
  })
})

describe('buildStartPlan', () => {
  it('codex: exec with stdin prompt and repo check skipped', () => {
    const p = buildStartPlan({ kind: 'codex' }, 'hi')
    if ('error' in p) throw new Error(p.error)
    expect(p.useStdin).toBe(true)
    expect(p.args).toContain('exec')
    expect(p.args).toContain('--skip-git-repo-check')
    expect(p.args[p.args.length - 1]).toBe('-')
    if (isWin) expect(p.file).toBe('cmd.exe')
  })

  it('claude: -p with stdin', () => {
    const p = buildStartPlan({ kind: 'claude' }, 'hi')
    if ('error' in p) throw new Error(p.error)
    expect(p.useStdin).toBe(true)
    expect(p.args).toContain('-p')
  })

  it('gemini and qwen: bare command, prompt via stdin', () => {
    for (const kind of ['gemini', 'qwen'] as const) {
      const p = buildStartPlan({ kind }, 'hi')
      if ('error' in p) throw new Error(p.error)
      expect(p.useStdin).toBe(true)
      expect(p.args.join(' ')).toContain(kind)
    }
  })

  it('custom without command refuses to start', () => {
    const p = buildStartPlan({ kind: 'custom' }, 'hi')
    expect('error' in p).toBe(true)
  })

  it('custom stdin mode', () => {
    const p = buildStartPlan({ kind: 'custom', command: 'my-agent run --json' }, 'hi')
    if ('error' in p) throw new Error(p.error)
    expect(p.useStdin).toBe(true)
    expect(p.args.join(' ')).toContain('my-agent')
  })

  it('custom {prompt} mode inlines the message as an argument', () => {
    const p = buildStartPlan(
      { kind: 'custom', command: 'my-agent --prompt {prompt} --json' },
      'hello world'
    )
    if ('error' in p) throw new Error(p.error)
    expect(p.useStdin).toBe(false)
    expect(p.args).toContain('hello world')
    expect(p.args).toContain('--json')
  })

  it('custom {prompt} replacement is literal ($ patterns are not expanded)', () => {
    const p = buildStartPlan({ kind: 'custom', command: 'my-agent --p={prompt}' }, 'a$&b')
    if ('error' in p) throw new Error(p.error)
    expect(p.args).toContain('--p=a$&b')
  })

  it('opencode cannot be started from the panel', () => {
    expect('error' in buildStartPlan({ kind: 'opencode' }, 'x')).toBe(true)
  })
})

describe('gemini transcript parser', () => {
  it('maps user/gemini messages and skips info', () => {
    const msgs = geminiJsonToMessages({
      sessionId: 's1',
      messages: [
        { type: 'user', content: '你好', timestamp: '2026-01-01T00:00:01Z' },
        { type: 'gemini', content: '你好！' },
        { type: 'info', content: 'compressed' }
      ]
    })
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(msgs[0].text).toBe('你好')
    expect(msgs[1].text).toBe('你好！')
  })

  it('lists sessions from <root>/<hash>/chats/session-*.json', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplex-gem-'))
    try {
      const chats = path.join(dir, 'abc123', 'chats')
      fs.mkdirSync(chats, { recursive: true })
      fs.writeFileSync(
        path.join(chats, 'session-2026-01-01T00-00-aaaa.json'),
        JSON.stringify({
          sessionId: 'x',
          messages: [
            { type: 'user', content: '第一个问题' },
            { type: 'gemini', content: 'ok' }
          ]
        })
      )
      fs.writeFileSync(path.join(dir, 'abc123', 'logs.json'), '[]')
      const list = listGeminiSessions(dir)
      expect(list).toHaveLength(1)
      expect(list[0].title).toBe('第一个问题')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('custom smart reader', () => {
  it('reads multi-line JSONL', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplex-cus-'))
    try {
      const f = path.join(dir, 'a.jsonl')
      fs.writeFileSync(
        f,
        JSON.stringify({ role: 'user', content: 'hi' }) +
          '\n' +
          JSON.stringify({ role: 'assistant', text: 'yo' }) +
          '\n'
      )
      const msgs = readCustomSession(f)
      expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant'])
      expect(msgs[0].text).toBe('hi')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reads whole-file JSON with messages[]', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplex-cus-'))
    try {
      const f = path.join(dir, 'sess.json')
      fs.writeFileSync(
        f,
        JSON.stringify(
          {
            messages: [
              { type: 'user', content: 'q' },
              { type: 'gemini', content: 'a' }
            ]
          },
          null,
          2
        )
      )
      const msgs = readCustomSession(f)
      expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant'])
      expect(msgs[1].text).toBe('a')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reads top-level JSON arrays of role/content', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplex-cus-'))
    try {
      const f = path.join(dir, 'arr.json')
      fs.writeFileSync(
        f,
        JSON.stringify([
          { role: 'user', content: 'one' },
          { role: 'assistant', content: 'two' }
        ])
      )
      const msgs = readCustomSession(f)
      expect(msgs.map((m) => m.text)).toEqual(['one', 'two'])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
