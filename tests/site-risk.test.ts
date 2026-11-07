import { describe, expect, it } from 'vitest'
import { assessSiteRisk, shouldWarn } from '../src/shared/site-risk'

describe('可疑站点预警', () => {
  it('普通 https 站点没有任何提示', () => {
    expect(assessSiteRisk('https://example.com/page')).toEqual({ level: 'none', reasons: [] })
    expect(shouldWarn(assessSiteRisk('https://example.com/'))).toBe(false)
  })

  it('明文 HTTP 给出警告（内容可被篡改）', () => {
    const risk = assessSiteRisk('http://example.com/login')
    expect(risk.level).toBe('warn')
    expect(risk.reasons).toContain('insecure')
  })

  it('IP 直连给出提示', () => {
    const risk = assessSiteRisk('https://203.0.113.7/')
    expect(risk.reasons).toContain('ip-host')
    expect(risk.level).toBe('notice')
  })

  it('punycode 域名给出警告（同形字钓鱼）', () => {
    const risk = assessSiteRisk('https://xn--80ak6aa92e.com/')
    expect(risk.reasons).toContain('punycode')
    expect(risk.level).toBe('warn')
  })

  it('URL 内嵌凭据给出警告', () => {
    const risk = assessSiteRisk('https://user:pass@evil.example/')
    expect(risk.reasons).toContain('credentials-in-url')
    expect(risk.level).toBe('warn')
  })

  it('非标准端口与超长域名给出提示', () => {
    expect(assessSiteRisk('https://example.com:8443/').reasons).toContain('unusual-port')
    expect(
      assessSiteRisk('https://a.b.c.d.e.f.example.com/').reasons
    ).toContain('long-host')
  })

  it('多个信号时取最高级别', () => {
    const risk = assessSiteRisk('http://user:pass@xn--80ak6aa92e.com:8080/x')
    expect(risk.level).toBe('warn')
    expect(risk.reasons).toEqual(
      expect.arrayContaining(['insecure', 'punycode', 'credentials-in-url', 'unusual-port'])
    )
  })

  it('本地开发与回环地址不打扰', () => {
    expect(shouldWarn(assessSiteRisk('http://localhost:3000/login'))).toBe(false)
    expect(shouldWarn(assessSiteRisk('http://127.0.0.1:8080/pay'))).toBe(false)
  })

  it('非 http(s) 不参与预警', () => {
    expect(assessSiteRisk('file:///C:/x.html')).toEqual({ level: 'none', reasons: [] })
    expect(assessSiteRisk('about:blank')).toEqual({ level: 'none', reasons: [] })
    expect(assessSiteRisk(null)).toEqual({ level: 'none', reasons: [] })
  })

  it('只看技术事实，不返回阻止类结论', () => {
    // 任何输入都只会得到 none / notice / warn 三个级别，不存在"禁止访问"
    const levels = [
      assessSiteRisk('http://example.com'),
      assessSiteRisk('https://example.com'),
      assessSiteRisk('https://203.0.113.7'),
      assessSiteRisk('nonsense')
    ].map((risk) => risk.level)
    expect(levels.every((level) => ['none', 'notice', 'warn'].includes(level))).toBe(true)
  })
})
