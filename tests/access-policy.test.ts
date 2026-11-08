import { describe, expect, it } from 'vitest'
import {
  DENIED_GUIDANCE,
  accessOrigin,
  decideAccess,
  type SiteGrant
} from '../src/shared/access-policy'

const grant = (actor: string, origin: string): SiteGrant => ({ actor, origin })

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
    const result = decideAccess({
      actor: 'agent',
      agentId: 'mcp:agent-a',
      url: 'https://mail.google.com/'
    })
    expect(result.decision).toBe('need-consent')
    expect(result.sensitivity?.kind).toBe('mail')
  })

  it('AI 进敏感站点且该 agent 已授权 → 放行', () => {
    const result = decideAccess({
      actor: 'agent',
      agentId: 'mcp:agent-a',
      url: 'https://mail.google.com/mail/u/0',
      grants: [grant('mcp:agent-a', 'https://mail.google.com')]
    })
    expect(result.decision).toBe('allow')
  })

  it('A 授权后 B 仍被拦：授权按 (actor, origin) 匹配', () => {
    const grants = [grant('mcp:agent-a', 'https://mail.google.com')]
    expect(
      decideAccess({
        actor: 'agent',
        agentId: 'mcp:agent-b',
        url: 'https://mail.google.com/',
        grants
      }).decision
    ).toBe('need-consent')
    // 同一个 agent 才放行
    expect(
      decideAccess({
        actor: 'agent',
        agentId: 'mcp:agent-a',
        url: 'https://mail.google.com/',
        grants
      }).decision
    ).toBe('allow')
  })

  it('没有具体 agentId 时一律视为未授权（不回退到共享列表）', () => {
    const result = decideAccess({
      actor: 'agent',
      url: 'https://mail.google.com/',
      grants: [grant('mcp:agent-a', 'https://mail.google.com')]
    })
    expect(result.decision).toBe('need-consent')
  })

  it('授权按 origin 精确匹配，子域不能顺带通过', () => {
    const result = decideAccess({
      actor: 'agent',
      agentId: 'mcp:agent-a',
      url: 'https://accounts.google.com/signin',
      grants: [grant('mcp:agent-a', 'https://mail.google.com')]
    })
    expect(result.decision).toBe('need-consent')
  })

  it('授权记录即使带路径/尾斜杠也只比较 origin', () => {
    const result = decideAccess({
      actor: 'agent',
      agentId: 'mcp:agent-a',
      url: 'https://mail.google.com/mail/u/0',
      grants: [grant('mcp:agent-a', 'https://mail.google.com/mail/u/0')]
    })
    expect(result.decision).toBe('allow')
  })

  it('未授权普通站点：默认放行，用户关掉总闸后才要求授权', () => {
    expect(decideAccess({ actor: 'agent', agentId: 'a', url: 'https://blog.example/' }).decision).toBe(
      'allow'
    )
    expect(
      decideAccess({
        actor: 'agent',
        agentId: 'a',
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
