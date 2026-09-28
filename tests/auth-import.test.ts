import { beforeEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'

/**
 * In-memory stand-in for the credential files. Tests never touch the real
 * ~/.codex or ~/.local/share/opencode auth files, and all values below are
 * fake fixtures.
 */
const files = vi.hoisted(() => new Map<string, string>())

vi.mock('node:fs', () => ({
  default: {
    readFileSync: (file: string) => {
      const content = files.get(String(file))
      if (content === undefined) {
        const err = new Error(`ENOENT: no such file or directory, open '${file}'`) as Error & {
          code?: string
        }
        err.code = 'ENOENT'
        throw err
      }
      return content
    }
  }
}))

import { importStatus, resolveImportedKey } from '../src/main/agent/auth-import'

const CODEX_PATH = path.join(os.homedir(), '.codex', 'auth.json')
const OPENCODE_PATH = path.join(os.homedir(), '.local', 'share', 'opencode', 'auth.json')

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

/** Fake JWT with an `exp` claim in seconds (payload only, never verified). */
function fakeJwt(expSeconds: number): string {
  return `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({ sub: 'fake-user', exp: expSeconds })}.fake-signature`
}

const future = (): number => Math.floor(Date.now() / 1000) + 3600
const past = (): number => Math.floor(Date.now() / 1000) - 3600

beforeEach(() => {
  files.clear()
})

describe('resolveImportedKey / importStatus (codex)', () => {
  it('parses a chatgpt auth.json and returns the access token plus JWT expiry', () => {
    const exp = future()
    const token = fakeJwt(exp)
    files.set(
      CODEX_PATH,
      JSON.stringify({
        auth_mode: 'chatgpt',
        OPENAI_API_KEY: null,
        tokens: {
          id_token: 'fake-id-token',
          access_token: token,
          refresh_token: 'fake-refresh-token',
          account_id: 'fake-account'
        },
        last_refresh: '2026-01-01T00:00:00Z'
      })
    )

    const r = resolveImportedKey('codex')
    expect(r.ok).toBe(true)
    expect(r.apiKey).toBe(token)
    expect(r.expiresAt).toBe(exp * 1000)

    const s = importStatus('codex')
    expect(s.found).toBe(true)
    expect(s.path).toBe(CODEX_PATH)
    expect(s.providers).toEqual(['chatgpt'])
    expect(s.expiresAt).toBe(exp * 1000)
    expect(s.error).toBeUndefined()
  })

  it('reports an expired chatgpt token with a Chinese hint to run the CLI', () => {
    files.set(
      CODEX_PATH,
      JSON.stringify({
        auth_mode: 'chatgpt',
        OPENAI_API_KEY: null,
        tokens: { access_token: fakeJwt(past()), refresh_token: 'fake-refresh-token' }
      })
    )

    const r = resolveImportedKey('codex')
    expect(r.ok).toBe(false)
    expect(r.apiKey).toBeUndefined()
    expect(r.error).toContain('过期')
    expect(r.error).toContain('codex CLI')

    const s = importStatus('codex')
    expect(s.found).toBe(true)
    expect(s.error).toContain('过期')
  })

  it('returns an API-key credential with no expiry (apikey mode and opaque token)', () => {
    files.set(
      CODEX_PATH,
      JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-fake-key', tokens: null })
    )
    const byMode = resolveImportedKey('codex')
    expect(byMode.ok).toBe(true)
    expect(byMode.apiKey).toBe('sk-fake-key')
    expect(byMode.expiresAt).toBeUndefined()

    // an unparsable access token counts as "expiry unknown", not as expired
    files.set(CODEX_PATH, JSON.stringify({ tokens: { access_token: 'not-a-jwt' } }))
    const opaque = resolveImportedKey('codex')
    expect(opaque.ok).toBe(true)
    expect(opaque.apiKey).toBe('not-a-jwt')
    expect(opaque.expiresAt).toBeUndefined()
  })

  it('fails with a Chinese message when the file is missing', () => {
    const r = resolveImportedKey('codex')
    expect(r.ok).toBe(false)
    expect(r.error).toContain('Codex')

    const s = importStatus('codex')
    expect(s.found).toBe(false)
    expect(s.path).toBe(CODEX_PATH)
    expect(s.providers).toEqual([])
    expect(s.error).toBeTruthy()
  })
})

describe('resolveImportedKey / importStatus (opencode)', () => {
  it('prefers the first oauth entry by default and supports providerName selection', () => {
    const expires = Date.now() + 3600_000
    files.set(
      OPENCODE_PATH,
      JSON.stringify({
        anthropic: { type: 'oauth', refresh: 'fake-refresh', access: 'fake-access', expires },
        deepseek: { type: 'api', key: 'sk-fake-deepseek' },
        corp: { type: 'wellknown', key: 'fake', token: 'fake' }
      })
    )

    const byDefault = resolveImportedKey('opencode')
    expect(byDefault.ok).toBe(true)
    expect(byDefault.apiKey).toBe('fake-access')
    expect(byDefault.expiresAt).toBe(expires)

    const api = resolveImportedKey('opencode', 'deepseek')
    expect(api.ok).toBe(true)
    expect(api.apiKey).toBe('sk-fake-deepseek')
    expect(api.expiresAt).toBeUndefined()

    const missing = resolveImportedKey('opencode', 'nope')
    expect(missing.ok).toBe(false)
    expect(missing.error).toContain('nope')

    const s = importStatus('opencode')
    expect(s.found).toBe(true)
    expect(s.path).toBe(OPENCODE_PATH)
    // wellknown entries are not importable and must not be listed
    expect(s.providers).toEqual(['anthropic', 'deepseek'])
    expect(s.expiresAt).toBe(expires)
    expect(s.error).toBeUndefined()
  })

  it('falls back to an api entry when no oauth entry exists', () => {
    files.set(OPENCODE_PATH, JSON.stringify({ deepseek: { type: 'api', key: 'sk-fake-deepseek' } }))
    const r = resolveImportedKey('opencode')
    expect(r.ok).toBe(true)
    expect(r.apiKey).toBe('sk-fake-deepseek')
  })

  it('reports an expired oauth entry with a Chinese hint to run the CLI', () => {
    files.set(
      OPENCODE_PATH,
      JSON.stringify({
        anthropic: { type: 'oauth', refresh: 'fake-refresh', access: 'fake-access', expires: Date.now() - 1000 }
      })
    )
    const r = resolveImportedKey('opencode')
    expect(r.ok).toBe(false)
    expect(r.error).toContain('过期')
    expect(r.error).toContain('opencode CLI')

    const s = importStatus('opencode')
    expect(s.found).toBe(true)
    expect(s.error).toContain('过期')
  })

  it('fails with a Chinese message when the file is missing', () => {
    const r = resolveImportedKey('opencode')
    expect(r.ok).toBe(false)
    expect(r.error).toContain('opencode')

    const s = importStatus('opencode')
    expect(s.found).toBe(false)
    expect(s.path).toBe(OPENCODE_PATH)
    expect(s.providers).toEqual([])
    expect(s.error).toBeTruthy()
  })
})
