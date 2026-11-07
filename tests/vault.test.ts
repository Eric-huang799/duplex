import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PasswordVault, type VaultCipher } from '../src/main/vault'

/** 假加密器：模拟 safeStorage（可逆、带钥匙标识；用错钥匙解不开）。 */
class FakeCipher implements VaultCipher {
  private readonly key: string

  constructor(key = 'key-a') {
    this.key = key
  }

  encrypt(plain: string): Buffer {
    return Buffer.from(`v1:${this.key}:${Buffer.from(plain, 'utf8').toString('base64')}`, 'utf8')
  }

  decrypt(blob: Buffer): string {
    const text = blob.toString('utf8')
    const prefix = `v1:${this.key}:`
    if (!text.startsWith(prefix)) throw new Error('wrong key')
    return Buffer.from(text.slice(prefix.length), 'base64').toString('utf8')
  }
}

/** 模拟 safeStorage 不可用（例如 Linux 没有钥匙串）：加密直接失败。 */
class BrokenCipher implements VaultCipher {
  encrypt(): Buffer {
    throw new Error('keychain unavailable')
  }

  decrypt(): string {
    throw new Error('keychain unavailable')
  }
}

function readFileEntries(file: string): Array<Record<string, unknown>> {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { entries: Array<Record<string, unknown>> }
  return parsed.entries
}

describe('PasswordVault', () => {
  let dir = ''
  let file = ''

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplex-vault-'))
    file = path.join(dir, 'passwords.json')
  })

  afterEach(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  })

  it('保存后按 origin 查询，只返回用户名与更新时间', () => {
    const vault = new PasswordVault(dir, new FakeCipher())
    expect(vault.save('https://mail.example.com', 'alice@example.com', 'p@ss-1')).toEqual({ ok: true })
    expect(vault.save('https://mail.example.com', 'bob@example.com', 'p@ss-2')).toEqual({ ok: true })
    expect(vault.save('https://other.example.com', 'carol@example.com', 'p@ss-3')).toEqual({ ok: true })

    const listed = vault.listForOrigin('https://mail.example.com')
    expect(listed.map((entry) => entry.username).sort()).toEqual(['alice@example.com', 'bob@example.com'])
    for (const entry of listed) expect(typeof entry.updatedAt).toBe('number')
    // 列表里绝没有明文
    expect(JSON.stringify(listed)).not.toContain('p@ss-')

    expect(vault.listForOrigin('https://OTHER.example.com:443')).toHaveLength(1)
    expect(vault.listForOrigin('https://unknown.example.com')).toEqual([])
    expect(vault.listForOrigin('not-an-origin')).toEqual([])
    expect(vault.count()).toBe(3)
  })

  it('reveal 是唯一取明文入口，按 origin + username 精确取', () => {
    const vault = new PasswordVault(dir, new FakeCipher())
    vault.save('https://mail.example.com', 'alice@example.com', 'p@ss-1')

    expect(vault.reveal('https://mail.example.com', 'alice@example.com')).toBe('p@ss-1')
    // origin / username 不匹配一律拿不到
    expect(vault.reveal('https://other.example.com', 'alice@example.com')).toBeNull()
    expect(vault.reveal('https://mail.example.com', 'bob@example.com')).toBeNull()
    expect(vault.reveal('not-an-origin', 'alice@example.com')).toBeNull()
    expect(vault.reveal('https://mail.example.com', '')).toBeNull()
  })

  it('同一 origin + username 再保存是覆盖，不是新增', () => {
    const vault = new PasswordVault(dir, new FakeCipher())
    vault.save('https://example.com', 'alice', 'old-secret')
    expect(vault.save('https://example.com', 'alice', 'new-secret').ok).toBe(true)
    expect(vault.count()).toBe(1)
    expect(vault.reveal('https://example.com', 'alice')).toBe('new-secret')
    expect(readFileEntries(file)).toHaveLength(1)
  })

  it('删除支持按 username 与按 origin 两种粒度', () => {
    const vault = new PasswordVault(dir, new FakeCipher())
    vault.save('https://a.example.com', 'alice', 'one')
    vault.save('https://a.example.com', 'bob', 'two')
    vault.save('https://b.example.com', 'alice', 'three')

    expect(vault.remove('https://a.example.com', 'alice')).toEqual({ ok: true, removed: 1 })
    expect(vault.listForOrigin('https://a.example.com').map((entry) => entry.username)).toEqual(['bob'])
    expect(vault.remove('https://a.example.com')).toEqual({ ok: true, removed: 1 })
    expect(vault.listForOrigin('https://a.example.com')).toEqual([])
    expect(vault.count()).toBe(1)
    // 重复删除是幂等的
    expect(vault.remove('https://a.example.com')).toEqual({ ok: true, removed: 0 })
    // 非法 origin 不删任何东西
    expect(vault.remove('http://example.com')).toEqual({ ok: false, removed: 0 })
    expect(vault.count()).toBe(1)
  })

  it('落盘文件里不出现明文密码，只存 secretBase64', () => {
    const secret = 'Tr0ub4dor&3-unique-marker'
    const vault = new PasswordVault(dir, new FakeCipher())
    vault.save('https://example.com', 'alice', secret)

    const raw = fs.readFileSync(file, 'utf8')
    expect(raw).not.toContain(secret)
    expect(raw).not.toContain(JSON.stringify(secret))
    expect(raw).not.toContain('"password"')

    const parsed = JSON.parse(raw) as { version: number; entries: Array<Record<string, unknown>> }
    expect(parsed.version).toBe(1)
    expect(parsed.entries).toHaveLength(1)
    expect(Object.keys(parsed.entries[0]).sort()).toEqual(['origin', 'secretBase64', 'updatedAt', 'username'])
    expect(parsed.entries[0].origin).toBe('https://example.com')
    expect(typeof parsed.entries[0].secretBase64).toBe('string')
    // 密文本身（去掉 vault 的 base64 外壳）也不是明文
    const inner = Buffer.from(parsed.entries[0].secretBase64 as string, 'base64').toString('utf8')
    expect(inner).not.toContain(secret)

    // 重新打开后仍能解密回原文（加密可逆，只是不在盘上留明文）
    const reopened = new PasswordVault(dir, new FakeCipher())
    expect(reopened.reveal('https://example.com', 'alice')).toBe(secret)
  })

  it('单条解密失败只跳过该条并计数，其他条目照常可用', () => {
    const vault = new PasswordVault(dir, new FakeCipher())
    vault.save('https://a.example.com', 'alice', 'good-secret')
    vault.save('https://b.example.com', 'bob', 'bad-secret')

    // 篡改 bob 的密文，模拟"换了机器/钥匙串"：不再是本钥匙能解的 blob
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { entries: Array<Record<string, unknown>> }
    const target = parsed.entries.find((entry) => entry.username === 'bob')
    if (!target) throw new Error('测试数据缺少 bob 条目')
    target.secretBase64 = Buffer.from('v1:another-key:AAAA', 'utf8').toString('base64')
    fs.writeFileSync(file, JSON.stringify(parsed, null, 2))

    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const reopened = new PasswordVault(dir, new FakeCipher())
      expect(reopened.count()).toBe(2)
      expect(reopened.reveal('https://b.example.com', 'bob')).toBeNull()
      expect(reopened.decryptFailureCount()).toBe(1)
      // 坏的那条不影响好的那条
      expect(reopened.reveal('https://a.example.com', 'alice')).toBe('good-secret')
      expect(reopened.decryptFailureCount()).toBe(1)
      // 列表仍能看到用户名（元数据可读，只是取不出明文），整个库没有"读不出来"
      expect(reopened.listForOrigin('https://b.example.com').map((entry) => entry.username)).toEqual(['bob'])
    } finally {
      spy.mockRestore()
    }
  })

  it('非法 origin 被拒绝且不落盘', () => {
    const vault = new PasswordVault(dir, new FakeCipher())
    const invalid = [
      'http://example.com', // 公网 http 不加密，绝不允许
      'http://example.com:8080',
      'ftp://example.com',
      'file:///C:/Windows/win.ini',
      'javascript:alert(1)',
      'https://example.com/login', // 带路径
      'https://example.com/?q=1', // 带查询
      'https://example.com/#frag', // 带锚点
      'https://user:pass@example.com', // 内嵌凭据
      'https://example.com:not-a-port',
      'not-an-origin',
      '',
      '   '
    ]
    for (const origin of invalid) {
      const result = vault.save(origin, 'alice', 'secret')
      expect(result.ok, `origin 应被拒绝: ${origin}`).toBe(false)
      expect(result.error).toBe('invalid origin')
    }
    expect(vault.count()).toBe(0)
    expect(fs.existsSync(file)).toBe(false)
  })

  it('加密器不可用时拒绝保存，绝不退化成明文', () => {
    const vault = new PasswordVault(dir, new BrokenCipher())
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const result = vault.save('https://example.com', 'alice', 'plaintext-marker')
      expect(result).toEqual({ ok: false, error: 'encrypt failed' })
      expect(vault.count()).toBe(0)
      expect(fs.existsSync(file)).toBe(false)
    } finally {
      spy.mockRestore()
    }
  })

  it('空用户名或空密码不保存', () => {
    const vault = new PasswordVault(dir, new FakeCipher())
    expect(vault.save('https://example.com', '', 'secret').ok).toBe(false)
    expect(vault.save('https://example.com', '   ', 'secret').ok).toBe(false)
    expect(vault.save('https://example.com', 'alice', '').ok).toBe(false)
    expect(vault.count()).toBe(0)
  })

  it('origin 大小写、默认端口与根路径归一；http 仅回环地址', () => {
    const vault = new PasswordVault(dir, new FakeCipher())
    expect(vault.save('HTTPS://Example.COM:443/', 'alice', 'one').ok).toBe(true)
    expect(vault.save('https://example.com:8443', 'alice', 'two').ok).toBe(true)
    expect(vault.save('http://localhost:5173/', 'dev', 'three').ok).toBe(true)
    expect(vault.save('http://127.0.0.1:8080', 'dev', 'four').ok).toBe(true)
    expect(vault.save('http://LOCALHOST:80', 'dev', 'five').ok).toBe(true)
    expect(vault.save('https://localhost', 'dev', 'six').ok).toBe(true)

    const origins = readFileEntries(file).map((entry) => entry.origin)
    expect(origins).toContain('https://example.com')
    expect(origins).toContain('https://example.com:8443')
    expect(origins).toContain('http://localhost:5173')
    expect(origins).toContain('http://127.0.0.1:8080')
    expect(origins).toContain('http://localhost')
    expect(origins).toContain('https://localhost')
    expect(vault.count()).toBe(6)

    // 输入侧同样归一后再查
    expect(vault.listForOrigin('https://EXAMPLE.com:443')).toHaveLength(1)
    expect(vault.reveal('https://example.com', 'alice')).toBe('one')
    expect(vault.reveal('https://example.com:8443', 'alice')).toBe('two')
  })

  it('lock 后 reveal 返回 null；解锁态不落盘', () => {
    const vault = new PasswordVault(dir, new FakeCipher())
    vault.save('https://example.com', 'alice', 'secret')
    expect(vault.isUnlocked()).toBe(true)

    vault.lock()
    expect(vault.isUnlocked()).toBe(false)
    expect(vault.reveal('https://example.com', 'alice')).toBeNull()
    // 锁只挡明文；元数据仍可用于展示"哪个账号"
    expect(vault.listForOrigin('https://example.com')).toHaveLength(1)

    // 新实例（进程重启）默认解锁——解锁态绝不能被持久化
    const reopened = new PasswordVault(dir, new FakeCipher())
    expect(reopened.isUnlocked()).toBe(true)
    expect(reopened.reveal('https://example.com', 'alice')).toBe('secret')
  })

  it('toString / JSON.stringify 脱敏，不带出凭据与文件名', () => {
    const vault = new PasswordVault(dir, new FakeCipher())
    vault.save('https://example.com', 'alice@example.com', 'serialize-me')

    const text = vault.toString()
    expect(text).toContain('entries=1')
    expect(text).not.toContain('alice')
    expect(text).not.toContain('serialize-me')

    const json = JSON.stringify(vault)
    expect(json).not.toContain('alice')
    expect(json).not.toContain('serialize-me')
    expect(json).not.toContain('secretBase64')
    expect(json).not.toContain('passwords.json')
    expect(JSON.parse(json)).toEqual({ type: 'PasswordVault', entries: 1, unlocked: true })
  })

  it('库文件损坏时退回空库，不抛异常', () => {
    fs.writeFileSync(file, '{ not json')
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const vault = new PasswordVault(dir, new FakeCipher())
      expect(vault.count()).toBe(0)
      expect(vault.save('https://example.com', 'alice', 'secret').ok).toBe(true)
      expect(new PasswordVault(dir, new FakeCipher()).count()).toBe(1)
    } finally {
      spy.mockRestore()
    }
  })
})
