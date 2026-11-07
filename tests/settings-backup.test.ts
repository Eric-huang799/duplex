import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { saveProviders } from '../src/main/settings'

const SECRET = 'sk-live-very-secret-value'

function provider(apiKey: string): unknown {
  return {
    id: 'p1',
    name: 'test',
    baseUrl: 'https://api.example.com/v1',
    apiKey,
    model: 'm',
    protocol: 'openai-chat',
    authType: 'key'
  }
}

describe('settings 备份不应残留已清除的密钥', () => {
  let dir = ''
  let originalEnv: string | undefined

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplex-settings-'))
    originalEnv = process.env['DUPLEX_DATA_DIR']
    process.env['DUPLEX_DATA_DIR'] = dir
    fs.writeFileSync(
      path.join(dir, 'settings.json'),
      JSON.stringify({ agentProviders: [provider(SECRET)], activeProviderId: 'p1' }, null, 2),
      'utf8'
    )
  })

  afterEach(() => {
    if (originalEnv === undefined) delete process.env['DUPLEX_DATA_DIR']
    else process.env['DUPLEX_DATA_DIR'] = originalEnv
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  })

  it('清除 API Key 之后，settings.json.bak 里不再有旧密钥', () => {
    const result = saveProviders([provider('')] as never, null)
    expect(result.ok).toBe(true)

    const main = fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')
    expect(main).not.toContain(SECRET)

    const backupPath = path.join(dir, 'settings.json.bak')
    expect(fs.existsSync(backupPath)).toBe(true)
    // 这条是这个 bug 的核心：备份里也不能再出现已清除的密钥
    expect(fs.readFileSync(backupPath, 'utf8')).not.toContain(SECRET)
  })

  it('轮换密钥之后，备份里换成新密钥而不是旧密钥', () => {
    const next = 'sk-rotated-2'
    const result = saveProviders([provider(next)] as never, null)
    expect(result.ok).toBe(true)

    const backup = fs.readFileSync(path.join(dir, 'settings.json.bak'), 'utf8')
    expect(backup).not.toContain(SECRET)
    expect(backup).toContain(next)
  })

  it('没有密钥可清理时不动备份（保留上一代回滚能力）', () => {
    // 先写一版带 key 的设置，让备份里有 key
    saveProviders([provider(SECRET)] as never, null)

    // 这次只是再存一次同样的 provider：密钥没变，备份应保持"上一代"语义，
    // 也就是说备份里仍然有可回滚的完整设置，而不是被 scrub 逻辑清空。
    const result = saveProviders([provider(SECRET)] as never, null)
    expect(result.ok).toBe(true)
    const afterBak = fs.readFileSync(path.join(dir, 'settings.json.bak'), 'utf8')
    expect(afterBak).toContain(SECRET)
    expect(JSON.parse(afterBak)).toHaveProperty('agentProviders')
  })
})
