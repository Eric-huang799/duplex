import { describe, expect, it } from 'vitest'
import { duplexShimEnv, extractHttpUrl } from '../src/main/open-shim'

describe('extractHttpUrl (FB-001: launch arguments)', () => {
  it('finds the first http(s) url among argv entries', () => {
    expect(extractHttpUrl(['C:\\app\\Duplex.exe', '--flag', 'https://example.com/x?y=1'])).toBe(
      'https://example.com/x?y=1'
    )
    expect(extractHttpUrl(['http://localhost:3000/'])).toBe('http://localhost:3000/')
  })

  it('ignores non-url arguments', () => {
    expect(extractHttpUrl(['--user-data-dir=C:\\x', 'about:blank'])).toBeNull()
    expect(extractHttpUrl([])).toBeNull()
    expect(extractHttpUrl(['ftp://example.com'])).toBeNull()
    expect(extractHttpUrl(['C:\\Users\\me\\file.html'])).toBeNull()
  })
})

describe('duplexShimEnv (FB-001: BROWSER shim)', () => {
  it('sets BROWSER and prepends the shim dir to PATH', () => {
    const env = duplexShimEnv('/shim/dir', { PATH: '/usr/bin' } as NodeJS.ProcessEnv)
    expect(env.BROWSER).toBe('duplex-open')
    expect((env.PATH ?? '').startsWith('/shim/dir')).toBe(true)
    expect(env.PATH).toContain('/usr/bin')
  })
})
