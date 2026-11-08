import { describe, expect, it } from 'vitest'
import { exportTranscriptMarkdown } from '../src/shared/transcript-export'

const meta = { title: 't', exportedAt: 0, appVersion: '0.3.0-beta.1' }
const dump = (text: string): string =>
  exportTranscriptMarkdown([{ kind: 'text', role: 'assistant', text }], meta)

describe('导出脱敏：头字段形态（发布前安全审查补）', () => {
  it('Cookie / Set-Cookie 整行打码', () => {
    const md = dump('Cookie: sessionid=abc123; csrftoken=def456\nSet-Cookie: sid=zzz; Path=/')
    expect(md).not.toContain('sessionid=abc123')
    expect(md).not.toContain('csrftoken=def456')
    expect(md).not.toContain('sid=zzz')
    expect(md).toContain('Cookie: ***')
  })

  it('Authorization: Basic / Token 打码，Bearer 仍保留前缀', () => {
    const md = dump('Authorization: Basic dXNlcjpwYXNz\nAuthorization: Token abc.def\nAuthorization: Bearer xyz.123')
    expect(md).not.toContain('dXNlcjpwYXNz')
    expect(md).not.toContain('abc.def')
    expect(md).not.toContain('xyz.123')
    expect(md).toContain('Authorization: ***')
    expect(md).toContain('Bearer ***')
  })

  it('x-api-key 作为正文键名也打码（之前只有作为 args 键名才命中）', () => {
    const md = dump('-H "x-api-key: AKIAEXAMPLE123"')
    expect(md).not.toContain('AKIAEXAMPLE123')
    expect(md).toContain('x-api-key')
  })

  it('原有形态仍然有效（回归）', () => {
    const md = dump('apiKey=hunter2 sk-live-abcdef Bearer tok_987 https://user:pw@example.com/x')
    for (const secret of ['hunter2', 'sk-live-abcdef', 'tok_987', 'user:pw@']) {
      expect(md).not.toContain(secret)
    }
  })
})
