import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SiteConsentStore } from '../src/main/site-consent'

describe('SiteConsentStore', () => {
  let dir = ''
  let store: SiteConsentStore

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
    expect(store.isAuthorized('https://mail.google.com/')).toBe(false)
  })

  it('always 授权落盘，重启后仍然有效', () => {
    expect(store.authorize('https://mail.google.com/mail/u/0', 'always')).toEqual({
      ok: true,
      origin: 'https://mail.google.com'
    })
    expect(store.isAuthorized('https://mail.google.com/')).toBe(true)
    const reloaded = new SiteConsentStore(dir)
    expect(reloaded.isAuthorized('https://mail.google.com/x')).toBe(true)
  })

  it('session 授权不落盘：重启后失效', () => {
    store.authorize('https://bank.example/', 'session')
    expect(store.isAuthorized('https://bank.example/')).toBe(true)
    const reloaded = new SiteConsentStore(dir)
    expect(reloaded.isAuthorized('https://bank.example/')).toBe(false)
  })

  it('按 origin 精确授权，子域不继承', () => {
    store.authorize('https://mail.google.com/', 'always')
    expect(store.isAuthorized('https://mail.google.com/')).toBe(true)
    expect(store.isAuthorized('https://accounts.google.com/signin')).toBe(false)
  })

  it('撤销后两条路径都不再放行', () => {
    store.authorize('https://a.example/', 'always')
    store.authorize('https://a.example/', 'session')
    expect(store.revoke('https://a.example/').removed).toBe(true)
    expect(store.isAuthorized('https://a.example/')).toBe(false)
    expect(new SiteConsentStore(dir).isAuthorized('https://a.example/')).toBe(false)
  })

  it('非法输入不写入', () => {
    expect(store.authorize('file:///etc/passwd', 'always').ok).toBe(false)
    expect(store.authorize('not a url', 'session').ok).toBe(false)
    expect(store.list()).toEqual([])
  })

  it('文件损坏时按空表开始，而不是错误放行', () => {
    fs.writeFileSync(path.join(dir, 'site-consent.json'), '{broken', 'utf8')
    const reloaded = new SiteConsentStore(dir)
    expect(reloaded.list()).toEqual([])
    expect(reloaded.isAuthorized('https://mail.google.com/')).toBe(false)
  })

  it('落盘内容只有 origin 列表，不含路径或查询', () => {
    store.authorize('https://mail.google.com/mail/u/0?secrets=1', 'always')
    const raw = fs.readFileSync(path.join(dir, 'site-consent.json'), 'utf8')
    expect(raw).toContain('https://mail.google.com')
    expect(raw).not.toContain('/mail/u/0')
    expect(raw).not.toContain('secrets')
  })
})
