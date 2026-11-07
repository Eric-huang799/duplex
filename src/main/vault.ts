/**
 * 密码保险库（Password Vault）——只存密文、只按 origin 取用。
 *
 * 产品红线：**密码不属于「AI 在安全范围内可以做一切」的范围。**
 *  - 没有"列出全部密码"的接口；只能按 origin 查询，且 listForOrigin 只返回
 *    用户名与更新时间，永远不返回明文。
 *  - 明文只有 reveal() 一个出口，且仅允许由**真人手势触发的填充**调用；AI 发起的
 *    click/type/navigation 等自动化路径绝不能走到这里。
 *  - 日志、错误消息、toString() / JSON 序列化一律不带凭据（密文、用户名都不带）。
 *  - 不注册任何 AI 工具入口——本文件只做底层，工具面的口子一个都不开。
 *
 * 加密能力由外部注入（VaultCipher）：生产环境由主进程用 Electron safeStorage
 * 适配（OS 钥匙串 / DPAPI），测试注入假实现——因此本文件不 import electron，
 * 可以在 vitest 里直接跑。
 *
 * 存储：`<directory>/passwords.json`，只存密文：
 *   { version: 1, entries: [{ origin, username, secretBase64, updatedAt }] }
 * 落盘走 shared/atomic.ts 的 writeFileAtomic（tmp → fsync → rename，POSIX 0600）。
 *
 * 容错：某一条密文解不开（换机器 / 钥匙串失效 / 文件被篡改）只跳过那一条并计数，
 * 绝不让整个库读不出来。锁定态只影响 reveal，不影响元数据与写操作。
 */
import fs from 'node:fs'
import path from 'node:path'
import { writeFileAtomic } from '../shared/atomic'

/**
 * 注入的加密接口。生产实现包一层 Electron safeStorage：
 *   encrypt: (plain) => safeStorage.encryptString(plain)   // 已含随机 IV，结果即密文
 *   decrypt: (blob) => safeStorage.decryptString(blob)
 * safeStorage 不可用时（Linux 无钥匙串）必须**拒绝保存**，不能退化成明文。
 */
export interface VaultCipher {
  encrypt(plain: string): Buffer
  decrypt(blob: Buffer): string
}

interface VaultEntry {
  origin: string
  username: string
  secretBase64: string
  updatedAt: number
}

interface VaultFile {
  version: 1
  entries: VaultEntry[]
}

/** 单个库的条目上限：防止异常调用把文件写爆；满了返回显式错误，不静默淘汰。 */
const MAX_ENTRIES = 1000
const MAX_ORIGIN_LENGTH = 2048
const MAX_USERNAME_LENGTH = 512
const MAX_PASSWORD_LENGTH = 4096
/** 标准 base64（Buffer.toString('base64') 的输出格式）。 */
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/
/** http 只允许本机回环地址，其余必须 https。 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1'])

function formatOrigin(protocol: string, host: string, port: string): string {
  const fallback = protocol === 'https:' ? '443' : '80'
  return port && port !== fallback ? `${protocol}//${host}:${port}` : `${protocol}//${host}`
}

/**
 * 严格 origin 规范化：只接受 `https://host[:port]`（http 仅 localhost / 127.0.0.1）。
 * 拒绝带路径、查询、锚点、内嵌凭据的输入；主机名小写、去尾点、默认端口省略。
 *
 * 与 shared/autofill.ts 的 originOf() 使用同一套 canonical 规则（页面侧算出来的
 * origin 必须能在这里命中），但这里更严格：不接受路径，也不接受公网 http。
 */
function normalizeOrigin(raw: string): string | null {
  if (typeof raw !== 'string') return null
  const s = raw.trim()
  if (!s || s.length > MAX_ORIGIN_LENGTH) return null
  let u: URL
  try {
    u = new URL(s)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
  // 内嵌凭据会把"谁"藏进 URL 里，正常 origin 不该有
  if (u.username || u.password) return null
  if (u.search || u.hash) return null
  // 允许裸 origin 与根路径的写法（https://host/），其余路径一律拒绝
  if (u.pathname !== '/' && u.pathname !== '') return null
  const host = u.hostname.toLowerCase().replace(/\.$/, '')
  if (!host) return null
  if (u.protocol === 'http:' && !LOOPBACK_HOSTS.has(host)) return null
  return formatOrigin(u.protocol, host, u.port)
}

/** 从磁盘读回的单条记录做结构与 origin 校验；坏数据直接丢弃，不让它污染内存。 */
function sanitizeEntry(raw: unknown): VaultEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const item = raw as Partial<VaultEntry>
  const origin = typeof item.origin === 'string' ? normalizeOrigin(item.origin) : null
  const username = typeof item.username === 'string' ? item.username.trim() : ''
  const secretBase64 = typeof item.secretBase64 === 'string' ? item.secretBase64 : ''
  if (!origin || !username || !BASE64.test(secretBase64)) return null
  return {
    origin,
    username,
    secretBase64,
    updatedAt: Number.isFinite(item.updatedAt) ? (item.updatedAt as number) : Date.now()
  }
}

export class PasswordVault {
  private readonly file: string
  private readonly cipher: VaultCipher
  private entries: VaultEntry[]
  /** 进程内存里的锁——**解锁态绝不落盘**，重启后默认解锁。 */
  private unlocked = true
  /** 解密失败次数（诊断用；不含任何凭据，便于发现"换了机器/钥匙串"）。 */
  private decryptFailures = 0

  constructor(directory: string, cipher: VaultCipher) {
    this.file = path.join(directory, 'passwords.json')
    this.cipher = cipher
    this.entries = this.load()
  }

  // ── 读取 ────────────────────────────────────────────────────────────────

  private load(): VaultEntry[] {
    let raw: string
    try {
      raw = fs.readFileSync(this.file, 'utf8')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code
      if (code !== 'ENOENT') {
        console.error('[vault] 读取 passwords.json 失败，已从空库开始：', (error as Error).message)
      }
      return []
    }
    try {
      const parsed = JSON.parse(raw) as Partial<VaultFile> | null
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.entries)) {
        console.error('[vault] passwords.json 结构不合法，已从空库开始')
        return []
      }
      // 这里**不解密**：启动时不把全库明文拉进内存，解密留到 reveal 那一次
      const entries: VaultEntry[] = []
      for (const item of parsed.entries) {
        const entry = sanitizeEntry(item)
        if (entry) entries.push(entry)
      }
      return entries
    } catch {
      // 只报告"解析失败"，不打印文件内容——虽然只是密文，也没有理由泄出去
      console.error('[vault] passwords.json 解析失败，已从空库开始')
      return []
    }
  }

  /**
   * 按 origin 查询可填充的账号元数据——**不含密码**。
   * 结果按 updatedAt 倒序（最近用过的排前面，供 UI 直接展示）。
   */
  listForOrigin(origin: string): Array<{ username: string; updatedAt: number }> {
    const key = normalizeOrigin(origin)
    if (!key) return []
    return this.entries
      .filter((entry) => entry.origin === key)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((entry) => ({ username: entry.username, updatedAt: entry.updatedAt }))
  }

  /**
   * 唯一取明文入口。**只允许"真人手势触发的填充"调用**（用户点选账号、自动填充
   * 提示条等由 chrome 绘制的真实点击）；AI 工具、页面脚本、自动化路径一律不得调用。
   * 锁定、origin 不匹配、账号不存在或密文解不开时返回 null。
   */
  reveal(origin: string, username: string): string | null {
    if (!this.unlocked) return null
    const key = normalizeOrigin(origin)
    if (!key) return null
    const user = (username ?? '').trim()
    if (!user) return null
    const entry = this.entries.find((item) => item.origin === key && item.username === user)
    if (!entry) return null
    try {
      return this.cipher.decrypt(Buffer.from(entry.secretBase64, 'base64'))
    } catch {
      // 换机器 / 钥匙串失效 / 密文被篡改：跳过这一条并计数，不能让整个库都读不出来
      this.decryptFailures += 1
      console.error('[vault] 一条凭据解密失败，已跳过（可能是换了机器或钥匙串）')
      return null
    }
  }

  // ── 写入 ────────────────────────────────────────────────────────────────

  /**
   * 保存（或覆盖同 origin+username 的）一条凭据。明文只在这里用于加密，
   * 不缓存、不写日志。返回的错误码不含任何凭据内容。
   */
  save(origin: string, username: string, password: string): { ok: boolean; error?: string } {
    const key = normalizeOrigin(origin)
    if (!key) return { ok: false, error: 'invalid origin' }
    const user = (username ?? '').trim()
    if (!user) return { ok: false, error: 'invalid username' }
    if (user.length > MAX_USERNAME_LENGTH) return { ok: false, error: 'invalid username' }
    if (typeof password !== 'string' || password.length === 0) return { ok: false, error: 'empty password' }
    if (password.length > MAX_PASSWORD_LENGTH) return { ok: false, error: 'password too long' }

    let secretBase64: string
    try {
      secretBase64 = this.cipher.encrypt(password).toString('base64')
    } catch {
      // 加密失败（例如 safeStorage 不可用）——宁可存不了，也不退化成明文
      console.error('[vault] 加密失败，凭据未保存')
      return { ok: false, error: 'encrypt failed' }
    }
    if (!secretBase64 || !BASE64.test(secretBase64)) {
      // 加密器返回空/非法密文：不能存一条永远解不开、还会污染库的记录
      console.error('[vault] 加密器返回了非法密文，凭据未保存')
      return { ok: false, error: 'encrypt failed' }
    }

    const now = Date.now()
    const index = this.entries.findIndex((entry) => entry.origin === key && entry.username === user)
    if (index >= 0) {
      const previous = this.entries[index]
      this.entries[index] = { origin: key, username: user, secretBase64, updatedAt: now }
      if (!this.persist()) {
        this.entries[index] = previous
        return { ok: false, error: 'write failed' }
      }
      return { ok: true }
    }

    if (this.entries.length >= MAX_ENTRIES) return { ok: false, error: 'vault full' }
    const entry: VaultEntry = { origin: key, username: user, secretBase64, updatedAt: now }
    this.entries.push(entry)
    if (!this.persist()) {
      this.entries.pop()
      return { ok: false, error: 'write failed' }
    }
    return { ok: true }
  }

  /** 删除某 origin 的全部凭据，或只删其中一个 username。 */
  remove(origin: string, username?: string): { ok: boolean; removed: number } {
    const key = normalizeOrigin(origin)
    if (!key) return { ok: false, removed: 0 }
    const user = username === undefined ? null : (username ?? '').trim()
    if (user !== null && !user) return { ok: false, removed: 0 }

    const previous = this.entries
    const kept = previous.filter((entry) => {
      if (entry.origin !== key) return true
      return user !== null && entry.username !== user
    })
    const removed = previous.length - kept.length
    if (removed === 0) return { ok: true, removed: 0 }
    this.entries = kept
    if (!this.persist()) {
      this.entries = previous
      return { ok: false, removed: 0 }
    }
    return { ok: true, removed }
  }

  private persist(): boolean {
    try {
      const file: VaultFile = { version: 1, entries: this.entries }
      writeFileAtomic(this.file, JSON.stringify(file, null, 2))
      return true
    } catch (error) {
      // fs 的错误信息只含路径/errno，不含凭据；这里也不展开第三参数
      console.error('[vault] 写入 passwords.json 失败：', (error as Error).message)
      return false
    }
  }

  // ── 锁与诊断 ────────────────────────────────────────────────────────────

  /** 锁库：只影响 reveal，不写盘（解锁态绝不持久化）。 */
  lock(): void {
    this.unlocked = false
  }

  isUnlocked(): boolean {
    return this.unlocked
  }

  /** 密文条目总数（元数据，不含任何凭据内容）。 */
  count(): number {
    return this.entries.length
  }

  /** 解密失败次数，用于诊断"换了机器/钥匙串"；不含凭据，可安全上报。 */
  decryptFailureCount(): number {
    return this.decryptFailures
  }

  // ── 脱敏 ────────────────────────────────────────────────────────────────

  /** JSON.stringify(vault) 只会看到计数与锁状态——密文、用户名、路径一概不出现。 */
  toJSON(): { type: 'PasswordVault'; entries: number; unlocked: boolean } {
    return { type: 'PasswordVault', entries: this.entries.length, unlocked: this.unlocked }
  }

  toString(): string {
    return `[PasswordVault entries=${this.entries.length} ${this.unlocked ? 'unlocked' : 'locked'}]`
  }
}
