import { describe, expect, it } from 'vitest'
import { classifySite } from '../src/shared/sensitive-sites'

describe('敏感站点判定', () => {
  it('邮箱站点命中', () => {
    expect(classifySite('https://mail.google.com/mail/u/0/')).toMatchObject({
      sensitive: true,
      kind: 'mail'
    })
    expect(classifySite('https://outlook.office.com/mail/')).toMatchObject({ kind: 'mail' })
    expect(classifySite('https://mail.qq.com/')).toMatchObject({ kind: 'mail' })
    // 子域也要命中
    expect(classifySite('https://x.gmail.com/')).toMatchObject({ sensitive: true })
  })

  it('银行与支付站点命中', () => {
    expect(classifySite('https://www.alipay.com/')).toMatchObject({ kind: 'finance' })
    expect(classifySite('https://mybank.icbc.com.cn/')).toMatchObject({ kind: 'finance' })
    expect(classifySite('https://paypal.com/')).toMatchObject({ kind: 'finance' })
  })

  it('身份认证站点与登录路径命中', () => {
    expect(classifySite('https://accounts.google.com/signin')).toMatchObject({ kind: 'identity' })
    expect(classifySite('https://example.com/login?next=/')).toMatchObject({
      sensitive: true,
      kind: 'identity'
    })
    expect(classifySite('https://example.com/account/reset-password')).toMatchObject({
      sensitive: true
    })
  })

  it('政务与医疗站点命中', () => {
    expect(classifySite('https://www.beijing.gov.cn/')).toMatchObject({ kind: 'government' })
    expect(classifySite('https://www.usa.gov/')).toMatchObject({ kind: 'government' })
    expect(classifySite('https://www.hospital.example/')).toMatchObject({ kind: 'health' })
  })

  it('普通站点不命中', () => {
    expect(classifySite('https://example.com/blog/post-1')).toEqual({ sensitive: false })
    expect(classifySite('https://www.bilibili.com/video/BV1')).toEqual({ sensitive: false })
    expect(classifySite('https://github.com/owner/repo')).toEqual({ sensitive: false })
  })

  it('回环地址与非 http(s) 永不敏感（避免拦开发与自家面板）', () => {
    expect(classifySite('http://localhost:3000/login')).toEqual({ sensitive: false })
    expect(classifySite('http://127.0.0.1:8080/pay')).toEqual({ sensitive: false })
    expect(classifySite('file:///C:/passwords.html')).toEqual({ sensitive: false })
    expect(classifySite('about:blank')).toEqual({ sensitive: false })
    expect(classifySite(null)).toEqual({ sensitive: false })
    expect(classifySite('not a url')).toEqual({ sensitive: false })
  })

  it('命中的站点带可解释的原因', () => {
    const verdict = classifySite('https://mail.google.com/')
    expect(verdict.sensitive).toBe(true)
    expect(verdict.reason).toBe('邮箱')
  })
})
