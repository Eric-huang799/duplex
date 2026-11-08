import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SiteConsentStore } from '../src/main/site-consent'
import { decideAccess } from '../src/shared/access-policy'

const A = 'mcp:agent-a'
const B = 'mcp:agent-b'
const MAIL = 'https://mail.google.com'

describe('SiteConsentStore', () => {
  let dir = ''
  let store: SiteConsentStore

  const filePath = (): string => path.join(dir, 'site-consent.json')
  const disk = (): { version: number; always: Array<{ actor: string; origin: string }> } =>
    JSON.parse(fs.readFileSync(filePath(), 'utf8')) as {
      version: number
      always: Array<{ actor: string; origin: string }>
    }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplex-consent-'))
    store = new SiteConsentStore(dir)
  })

  afterEach(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  })

  it('默认什么都不授权（宁可多问一次）', () => {
    expect(store.list()).toEqual([])
    expect(store.isAuthorized(A, MAIL)).toBe(false)
    expect(store.isAuthorized(B, MAIL)).toBe(false)
  })

  it('A 授权后 B 仍被拦（store 与策略联合）', () => {
    expect(store.authorize(A, `${MAIL}/mail/u/0`, 'always')).toEqual({ ok: true, origin: MAIL })
    expect(store.isAuthorized(A, MAIL)).toBe(true)
    expect(store.isAuthorized(B, MAIL)).toBe(false)
    expect(store.listFor(A)).toEqual([MAIL])
    expect(store.listFor(B)).toEqual([])
    expect(
      decideAccess({ actor: 'agent', agentId: B, url: MAIL, grants: store.list() }).decision
    ).toBe('need-consent')
    expect(
      decideAccess({ actor: 'agent', agentId: A, url: MAIL, grants: store.list() }).decision
    ).toBe('allow')
  })

  it('同一 agent 同一 origin 只记一条，授权后不再重复问', () => {
    store.authorize(A, MAIL, 'session')
    store.authorize(A, `${MAIL}/mail/u/0`, 'session')
    expect(store.list().filter((entry) => entry.actor === A && entry.origin === MAIL)).toHaveLength(1)
    expect(store.isAuthorized(A, `${MAIL}/mail/u/0`)).toBe(true)
    // 模拟同一运行里的后续工具调用：两次判定都直接放行。
    for (let i = 0; i < 2; i += 1) {
      expect(
        decideAccess({ actor: 'agent', agentId: A, url: MAIL, grants: store.list() }).decision
      ).toBe('allow')
    }
  })

  it('always 授权落盘，重启后同 agent 仍有效、别的 agent 无效', () => {
    store.authorize(A, `${MAIL}/mail/u/0`, 'always')
    const reloaded = new SiteConsentStore(dir)
    expect(reloaded.isAuthorized(A, MAIL)).toBe(true)
    expect(reloaded.isAuthorized(B, MAIL)).toBe(false)
    expect(reloaded.listFor(B)).toEqual([])
  })

  it('session 授权不落盘：重启后失效，且只属于该 agent', () => {
    store.authorize(A, 'https://bank.example/', 'session')
    expect(store.isAuthorized(A, 'https://bank.example/')).toBe(true)
    expect(store.isAuthorized(B, 'https://bank.example/')).toBe(false)
    const reloaded = new SiteConsentStore(dir)
    expect(reloaded.isAuthorized(A, 'https://bank.example/')).toBe(false)
  })

  it('撤销只影响该 agent，别的 agent 的同站点授权保留', () => {
    store.authorize(A, MAIL, 'always')
    store.authorize(B, MAIL, 'always')
    expect(store.revoke(A, MAIL)).toEqual({ ok: true, removed: true })
    expect(store.isAuthorized(A, MAIL)).toBe(false)
    expect(store.isAuthorized(B, MAIL)).toBe(true)
    expect(store.revoke(A, MAIL)).toEqual({ ok: true, removed: false })
    const reloaded = new SiteConsentStore(dir)
    expect(reloaded.isAuthorized(A, MAIL)).toBe(false)
    expect(reloaded.isAuthorized(B, MAIL)).toBe(true)
  })

  it('按 origin 精确授权，子域不继承', () => {
    store.authorize(A, MAIL, 'always')
    expect(store.isAuthorized(A, MAIL)).toBe(true)
    expect(store.isAuthorized(A, 'https://accounts.google.com/signin')).toBe(false)
  })

  it('非法输入不写入', () => {
    expect(store.authorize('', MAIL, 'always').ok).toBe(false)
    expect(store.authorize('agent\nx', MAIL, 'always').ok).toBe(false)
    expect(store.authorize(A, 'file:///etc/passwd', 'always').ok).toBe(false)
    expect(store.authorize(A, 'not a url', 'session').ok).toBe(false)
    expect(store.revoke(A, 'not a url')).toEqual({ ok: false, removed: false })
    expect(store.list()).toEqual([])
  })

  it('文件损坏时按空表开始，而不是错误放行', () => {
    fs.writeFileSync(filePath(), '{broken', 'utf8')
    const reloaded = new SiteConsentStore(dir)
    expect(reloaded.list()).toEqual([])
    expect(reloaded.isAuthorized(A, MAIL)).toBe(false)
  })

  it('旧格式（只有 origin）不继承给任何 agent：丢弃、写日志并迁移到 v2', () => {
    fs.writeFileSync(
      filePath(),
      JSON.stringify({ version: 1, always: [`${MAIL}/mail/u/0`, 'not a url'] })
    )
    const log = vi.fn()
    const migrated = new SiteConsentStore(dir, log)

    // 关键：旧授权不能变成"所有 agent 都获准"。
    expect(migrated.list()).toEqual([])
    expect(migrated.isAuthorized(A, MAIL)).toBe(false)
    expect(migrated.isAuthorized(B, MAIL)).toBe(false)
    expect(
      decideAccess({ actor: 'agent', agentId: A, url: MAIL, grants: migrated.list() }).decision
    ).toBe('need-consent')

    expect(log).toHaveBeenCalledTimes(1)
    const message = String(log.mock.calls[0]?.[0] ?? '')
    expect(message).toContain('旧版授权')
    expect(message).toContain(MAIL)
    // 迁移后磁盘上不再保留 v1 的裸字符串。
    expect(disk()).toEqual({ version: 2, always: [] })
  })

  it('v2 里缺 actor / origin 的坏记录不会被当成通用授权', () => {
    fs.writeFileSync(
      filePath(),
      JSON.stringify({
        version: 2,
        always: [
          { origin: MAIL },
          { actor: '', origin: 'https://empty.example' },
          { actor: A, origin: 'https://ok.example' }
        ]
      })
    )
    const reloaded = new SiteConsentStore(dir)
    expect(reloaded.list()).toEqual([{ actor: A, origin: 'https://ok.example' }])
    expect(reloaded.isAuthorized(A, MAIL)).toBe(false)
    expect(reloaded.isAuthorized(A, 'https://empty.example')).toBe(false)
  })

  it('落盘结构为 version 2 + 每条 {actor, origin}，不含路径或查询', () => {
    store.authorize(A, `${MAIL}/mail/u/0?secrets=1`, 'always')
    const raw = fs.readFileSync(filePath(), 'utf8')
    expect(raw).toContain(A)
    expect(raw).toContain(MAIL)
    expect(raw).not.toContain('/mail/u/0')
    expect(raw).not.toContain('secrets')
    expect(disk()).toEqual({ version: 2, always: [{ actor: A, origin: MAIL }] })
  })

  it('list 合并 session 与 always、去重并按 actor/origin 排序', () => {
    store.authorize(B, 'https://b.example', 'always')
    store.authorize(A, 'https://a.example', 'session')
    store.authorize(B, 'https://b.example', 'session')
    expect(store.list()).toEqual([
      { actor: A, origin: 'https://a.example' },
      { actor: B, origin: 'https://b.example' }
    ])
  })

  it('v2 文件可读回多个 agent 的授权', () => {
    store.authorize(A, MAIL, 'always')
    store.authorize(B, 'https://bank.example', 'always')
    const reloaded = new SiteConsentStore(dir)
    expect(reloaded.list()).toEqual([
      { actor: A, origin: MAIL },
      { actor: B, origin: 'https://bank.example' }
    ])
  })
})
