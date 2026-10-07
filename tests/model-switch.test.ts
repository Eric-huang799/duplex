/**
 * Unit tests for the external-tool model switcher: CLI flag injection and the
 * pure config editors used by "sync to global".
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  buildResumePlan,
  buildStartPlan,
  setJsonModel,
  setTomlModel,
  syncModelToGlobal
} from '../src/main/integrations/agents'

describe('model injection into spawn plans', () => {
  it('codex start plan includes -m when a model is set', () => {
    const p = buildStartPlan({ kind: 'codex' }, 'hi', 'gpt-6-luna')
    if ('error' in p) throw new Error(p.error)
    const i = p.args.indexOf('-m')
    expect(i).toBeGreaterThan(-1)
    expect(p.args[i + 1]).toBe('gpt-6-luna')
    expect(p.args[p.args.length - 1]).toBe('-')
  })

  it('codex start plan omits -m by default', () => {
    const p = buildStartPlan({ kind: 'codex' }, 'hi')
    if ('error' in p) throw new Error(p.error)
    expect(p.args).not.toContain('-m')
  })

  it('claude plans include --model for start and resume', () => {
    const p1 = buildStartPlan({ kind: 'claude' }, 'hi', 'deepseek-v4-pro')
    if ('error' in p1) throw new Error(p1.error)
    const i1 = p1.args.indexOf('--model')
    expect(i1).toBeGreaterThan(-1)
    expect(p1.args[i1 + 1]).toBe('deepseek-v4-pro')

    const p2 = buildResumePlan({ kind: 'claude' }, 'sid', '', 'deepseek-v4-flash')
    if ('error' in p2) throw new Error(p2.error)
    const i2 = p2.args.indexOf('--model')
    expect(i2).toBeGreaterThan(-1)
    expect(p2.args[i2 + 1]).toBe('deepseek-v4-flash')
    expect(p2.args).toContain('sid')
  })

  it('codex resume plan includes -m and the session id', () => {
    const p = buildResumePlan({ kind: 'codex' }, 'cid-1', '', 'gpt-5.5')
    if ('error' in p) throw new Error(p.error)
    const i = p.args.indexOf('-m')
    expect(i).toBeGreaterThan(-1)
    expect(p.args[i + 1]).toBe('gpt-5.5')
    expect(p.args).toContain('cid-1')
    expect(p.args[p.args.length - 1]).toBe('-')
  })

  it('omits model flags when the selection is empty', () => {
    const p1 = buildStartPlan({ kind: 'codex' }, 'hi', '')
    const p2 = buildResumePlan({ kind: 'claude' }, 'sid', '', '')
    if ('error' in p1) throw new Error(p1.error)
    if ('error' in p2) throw new Error(p2.error)
    expect(p1.args).not.toContain('-m')
    expect(p2.args).not.toContain('--model')
  })
})

describe('setTomlModel', () => {
  const sample = [
    'approvals_reviewer = "user"',
    'model = "gpt-6-sol"',
    'notify = ["x"]',
    '',
    '[mcp_servers.node_repl]',
    'model = "inner-model"',
    ''
  ].join('\n')

  it('replaces only the top-level model line', () => {
    const out = setTomlModel(sample, 'gpt-6-luna')
    const lines = out.split('\n')
    expect(lines[1]).toBe('model = "gpt-6-luna"')
    expect(lines[5]).toBe('model = "inner-model"')
    expect(lines[0]).toBe('approvals_reviewer = "user"')
  })

  it('inserts before the first table when no top-level model exists', () => {
    const out = setTomlModel('[a]\nx = 1\n', 'gpt-5.5')
    expect(out.startsWith('model = "gpt-5.5"\n[a]')).toBe(true)
  })

  it('preserves CRLF files', () => {
    const out = setTomlModel('model = "old"\r\n[a]\r\n', 'new-model')
    expect(out).toContain('model = "new-model"')
    expect(out).toContain('\r\n')
  })

  it('collapses duplicate top-level model keys into a single line', () => {
    const out = setTomlModel('model = "one"\nmodel = "two"\n[a]\nmodel = "inner"\n', 'new-model')
    expect(out).toBe('model = "new-model"\n[a]\nmodel = "inner"\n')
  })
})

describe('syncModelToGlobal', () => {
  let home = ''
  let restore: (() => void) | null = null

  afterEach(() => {
    restore?.()
    restore = null
    if (home) fs.rmSync(home, { recursive: true, force: true })
    home = ''
  })

  function useTempHome(): string {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'duplex-sync-'))
    const spy = vi.spyOn(os, 'homedir').mockReturnValue(home)
    restore = () => spy.mockRestore()
    return home
  }

  it('backs up, writes, and reports the backup path (codex)', () => {
    const h = useTempHome()
    const dir = path.join(h, '.codex')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'config.toml')
    const original = 'model = "old"\n'
    fs.writeFileSync(file, original, 'utf8')

    const r = syncModelToGlobal({ kind: 'codex' }, 'gpt-6-luna')
    expect(r.ok).toBe(true)
    expect(r.path).toBe(file)
    expect(r.backupPath).toBeTruthy()
    expect(fs.readFileSync(r.backupPath!, 'utf8')).toBe(original)
    expect(fs.readFileSync(file, 'utf8')).toContain('model = "gpt-6-luna"')
  })

  it('never overwrites an existing backup within the same second', () => {
    const h = useTempHome()
    const dir = path.join(h, '.codex')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'config.toml')
    fs.writeFileSync(file, 'model = "old"\n', 'utf8')

    const first = syncModelToGlobal({ kind: 'codex' }, 'model-a')
    const second = syncModelToGlobal({ kind: 'codex' }, 'model-b')
    expect(first.ok && second.ok).toBe(true)
    expect(second.backupPath).not.toBe(first.backupPath)
    expect(fs.readFileSync(first.backupPath!, 'utf8')).toBe('model = "old"\n')
    expect(fs.readFileSync(second.backupPath!, 'utf8')).toContain('model = "model-a"')
  })

  it('rolls back from the backup when post-write verification fails', () => {
    const h = useTempHome()
    const dir = path.join(h, '.claude')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'settings.json')
    const original = '{"env":{"A":"1"},"model":"opus"}'
    fs.writeFileSync(file, original, 'utf8')

    const realWrite = fs.writeFileSync.bind(fs)
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(((
      target: fs.PathOrFileDescriptor,
      _data: string | NodeJS.ArrayBufferView,
      options?: fs.WriteFileOptions
    ) => {
      // simulate a concurrent editor clobbering the file after our write
      realWrite(target, '{"broken":true}', options)
    }) as typeof fs.writeFileSync)

    try {
      const r = syncModelToGlobal({ kind: 'claude' }, 'deepseek-v4-pro')
      expect(r.ok).toBe(false)
      expect(r.error).toContain('回滚')
      expect(r.backupPath).toBeTruthy()
      writeSpy.mockRestore()
      expect(fs.readFileSync(file, 'utf8')).toBe(original)
      expect(fs.readFileSync(r.backupPath!, 'utf8')).toBe(original)
    } finally {
      writeSpy.mockRestore()
    }
  })
})

describe('setJsonModel', () => {
  it('sets the model field and preserves other keys', () => {
    const out = setJsonModel('{"env":{"A":"1"},"model":"opus[1m]"}', 'deepseek-v4-pro')
    const obj = JSON.parse(out) as { model: string; env: Record<string, string> }
    expect(obj.model).toBe('deepseek-v4-pro')
    expect(obj.env.A).toBe('1')
  })

  it('adds the model field when missing', () => {
    const out = setJsonModel('{"env":{}}', 'gpt-6-luna')
    expect((JSON.parse(out) as { model: string }).model).toBe('gpt-6-luna')
  })
})
