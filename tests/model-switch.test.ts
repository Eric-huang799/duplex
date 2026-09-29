/**
 * Unit tests for the external-tool model switcher: CLI flag injection and the
 * pure config editors used by "sync to global".
 */
import { describe, expect, it } from 'vitest'
import {
  buildResumePlan,
  buildStartPlan,
  setJsonModel,
  setTomlModel
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
