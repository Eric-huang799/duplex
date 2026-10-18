/**
 * Unit tests for panel-reply resume plans and transcript session metadata.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildResumePlan } from '../src/main/integrations/agents'
import { readSessionMeta } from '../src/main/integrations/transcripts'

const isWin = process.platform === 'win32'

describe('buildResumePlan', () => {
  it('codex: exec resume with skip-git-repo-check and stdin placeholder', () => {
    const p = buildResumePlan({ kind: 'codex' }, 'abc-123', '')
    if ('error' in p) throw new Error(p.error)
    expect(p.args).toContain('exec')
    expect(p.args).toContain('resume')
    expect(p.args).toContain('--skip-git-repo-check')
    expect(p.args).toContain('abc-123')
    expect(p.args[p.args.length - 1]).toBe('-')
    const instruction = p.args.find((a) => a.startsWith('developer_instructions='))
    expect(instruction).toBeDefined()
    expect(instruction).toContain('mcp__duplex__*')
    expect(p.args[p.args.indexOf(instruction!) - 1]).toBe('-c')
    if (isWin) expect(p.file).toBe('cmd.exe')
  })

  it('codex: resume carries the per-session duplex MCP server', () => {
    const p = buildResumePlan({ kind: 'codex' }, 'abc-123', '', '', {
      bridgePath: 'C:\\Duplex\\dist-bridge\\index.cjs',
      dataDir: 'C:\\tmp\\duplex-demo'
    })
    if ('error' in p) throw new Error(p.error)
    expect(p.args).toContain("mcp_servers.duplex.command='node'")
    expect(p.args).toContain(
      "mcp_servers.duplex.args=['C:\\Duplex\\dist-bridge\\index.cjs']"
    )
    expect(p.args).toContain(
      "mcp_servers.duplex.env.DUPLEX_DATA_DIR='C:\\tmp\\duplex-demo'"
    )
  })

  it('claude: --resume with print mode and stdin prompt', () => {
    const p = buildResumePlan({ kind: 'claude' }, 'sid-1', '')
    if ('error' in p) throw new Error(p.error)
    expect(p.args).toContain('--resume')
    expect(p.args).toContain('sid-1')
    expect(p.args).toContain('-p')
    expect(p.args).toContain('--append-system-prompt')
    expect(p.args).toContain('--allowedTools')
    expect(p.args).toContain('mcp__duplex')
    if (isWin) expect(p.file).toBe('cmd.exe')
  })

  it('claude: resume loads the per-session duplex MCP config', () => {
    const p = buildResumePlan({ kind: 'claude' }, 'sid-1', '', '', {
      claudeMcpConfigPath: 'C:\\tmp\\claude-mcp-duplex.json'
    })
    if ('error' in p) throw new Error(p.error)
    expect(p.args).toContain('--mcp-config')
    expect(p.args).toContain('C:\\tmp\\claude-mcp-duplex.json')
  })

  it('rejects an empty session id and unsupported kinds', () => {
    expect('error' in buildResumePlan({ kind: 'codex' }, '   ', '')).toBe(true)
    expect('error' in buildResumePlan({ kind: 'gemini' }, 'sid', '')).toBe(true)
    expect('error' in buildResumePlan({ kind: 'custom' }, 'sid', '')).toBe(true)
  })

  it('uses an existing cwd hint, falls back to the home directory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplex-resume-'))
    try {
      const p = buildResumePlan({ kind: 'claude' }, 'sid', dir)
      if ('error' in p) throw new Error(p.error)
      expect(p.cwd).toBe(dir)
      const p2 = buildResumePlan({ kind: 'claude' }, 'sid', path.join(dir, 'missing-dir'))
      if ('error' in p2) throw new Error(p2.error)
      expect(p2.cwd).toBe(os.homedir())
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('readSessionMeta', () => {
  let dir = ''

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplex-meta-'))
  })

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('codex: reads id + cwd from the session_meta line', () => {
    const f = path.join(dir, 'rollout-x.jsonl')
    fs.writeFileSync(
      f,
      JSON.stringify({
        timestamp: 'x',
        type: 'session_meta',
        payload: { id: 'cid-1', cwd: 'C:\\proj' }
      }) + '\n'
    )
    expect(readSessionMeta('codex', f)).toEqual({ cliSessionId: 'cid-1', cwd: 'C:\\proj' })
  })

  it('claude: scans for the first line carrying sessionId/cwd', () => {
    const f = path.join(dir, 'claude-x.jsonl')
    fs.writeFileSync(
      f,
      JSON.stringify({ type: 'summary', summary: 'x' }) +
        '\n' +
        JSON.stringify({ type: 'user', sessionId: 'sid-9', cwd: 'C:\\p2', message: {} }) +
        '\n'
    )
    expect(readSessionMeta('claude', f)).toEqual({ cliSessionId: 'sid-9', cwd: 'C:\\p2' })
  })

  it('returns empty meta for unknown kinds or unreadable files', () => {
    expect(readSessionMeta('gemini', path.join(dir, 'nope.json'))).toEqual({})
    expect(readSessionMeta('codex', path.join(dir, 'missing.jsonl'))).toEqual({})
  })
})
