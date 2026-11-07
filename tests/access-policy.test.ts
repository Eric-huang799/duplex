import { describe, expect, it } from 'vitest'
import { DENIED_GUIDANCE, accessOrigin, decideAccess } from '../src/shared/access-policy'

describe('accessOrigin', () => {
  it('规范化 origin，丢弃路径与查询', () => {
    expect(accessOrigin('https://Mail.Google.com/mail/u/0?x=1')).toBe('https://mail.google.com')
    expect(accessOrigin('http://localhost:3000/login')).toBe('http://localhost:3000')
  })

  it('非 http(s) 返回 null', () => {
    expect(accessOrigin('file:///etc/passwd')).toBeNull()
    expect(accessOrigin('about:blank')).toBeNull()
    expect(accessOrigin(null)).toBeNull()
  })
})

describe('访问治理：真人 vs AI', () => {
  it('真人浏览任何站点都放行（内核不做内容审查）', () => {
    expect(decideAccess({ actor: 'human', url: 'https://mail.google.com/' }).decision).toBe('allow')
    expect(decideAccess({ actor: 'human', url: 'https://unknown.example/x' }).decision).toBe('allow')
    // 敏感站点也只是"提示不拦截"
    const mail = decideAccess({ actor: 'human', url: 'https://mail.google.com/' })
    expect(mail.decision).toBe('allow')
    expect(mail.reason).toContain('只提示')
  })

  it('AI 进敏感站点且未授权 → 需要授权', () => {
    const result = decideAccess({ actor: 'agent', url: 'https://mail.google.com/' })
    expect(result.decision).toBe('need-consent')
    expect(result.sensitivity?.kind).toBe('mail')
  })

  it('AI 进敏感站点但已授权 → 放行', () => {
    const result = decideAccess({
      actor: 'agent',
      url: 'https://mail.google.com/mail/u/0',
      authorizedOrigins: ['https://mail.google.com']
    })
    expect(result.decision).toBe('allow')
  })

  it('授权按 origin 精确匹配，子域不能顺带通过', () => {
    const result = decideAccess({
      actor: 'agent',
      url: 'https://accounts.google.com/signin',
      authorizedOrigins: ['https://mail.google.com']
    })
    expect(result.decision).toBe('need-consent')
  })

  it('未授权普通站点：默认放行，用户关掉总闸后才要求授权', () => {
    expect(decideAccess({ actor: 'agent', url: 'https://blog.example/' }).decision).toBe('allow')
    expect(
      decideAccess({
        actor: 'agent',
        url: 'https://blog.example/',
        agentMayBrowseUnlisted: false
      }).decision
    ).toBe('need-consent')
  })

  it('回环与本地开发不受这套治理管辖', () => {
    expect(decideAccess({ actor: 'agent', url: 'http://localhost:3000/login' }).decision).toBe('allow')
    expect(decideAccess({ actor: 'agent', url: 'http://127.0.0.1:8080/pay' }).decision).toBe('allow')
  })

  it('被拒绝时的指引明确禁止绕过', () => {
    expect(DENIED_GUIDANCE).toContain('不要重试')
    expect(DENIED_GUIDANCE).toContain('换搜索引擎')
  })
})
