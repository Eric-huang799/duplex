import { describe, expect, it } from 'vitest'
import { CHALLENGE_PAUSE_THRESHOLD, detectChallenge, shouldPauseAgent } from '../src/shared/challenge'

describe('人机验证检测', () => {
  it('reCAPTCHA iframe 命中', () => {
    const verdict = detectChallenge({
      url: 'https://example.com/',
      frames: [{ url: 'https://www.google.com/recaptcha/api2/anchor?k=x' }]
    })
    expect(verdict).toMatchObject({ challenge: true, kind: 'recaptcha', confidence: 0.9 })
    expect(shouldPauseAgent(verdict)).toBe(true)
  })

  it('hCaptcha / Turnstile / 极验 命中对应类型', () => {
    expect(detectChallenge({ url: 'https://a.com/', frames: [{ url: 'https://hcaptcha.com/x' }] }).kind).toBe('hcaptcha')
    expect(
      detectChallenge({ url: 'https://a.com/', frames: [{ url: 'https://challenges.cloudflare.com/turnstile' }] }).kind
    ).toBe('turnstile')
    expect(detectChallenge({ url: 'https://a.com/', frames: [{ url: 'https://static.geetest.com/x' }] }).kind).toBe(
      'geetest'
    )
  })

  it('Cloudflare 挑战页 URL 命中', () => {
    const verdict = detectChallenge({ url: 'https://site.com/cdn-cgi/challenge-platform/h/b/orchestrate' })
    expect(verdict).toMatchObject({ challenge: true, kind: 'cloudflare' })
  })

  it('中文与英文文本命中', () => {
    expect(detectChallenge({ url: 'https://a.com/', text: '请完成安全验证后继续访问' }).challenge).toBe(true)
    expect(detectChallenge({ url: 'https://a.com/', text: 'Verify you are human' }).challenge).toBe(true)
    expect(detectChallenge({ url: 'https://a.com/', title: 'Just a moment...' }).challenge).toBe(false)
  })

  it('滑块提示优先标为 slider', () => {
    const verdict = detectChallenge({ url: 'https://a.com/', text: '拖动滑块完成验证' })
    expect(verdict).toMatchObject({ challenge: true, kind: 'slider' })
    expect(verdict.confidence).toBeGreaterThanOrEqual(CHALLENGE_PAUSE_THRESHOLD)
  })

  it('多证据时取最强置信度并合并证据', () => {
    const verdict = detectChallenge({
      url: 'https://site.com/cdn-cgi/challenge-platform/x',
      frames: [{ url: 'https://www.google.com/recaptcha/api2/anchor' }],
      text: '请完成安全验证'
    })
    expect(verdict.confidence).toBe(0.9)
    expect(verdict.evidence?.split('、').length).toBeGreaterThan(1)
    expect(verdict.evidence?.split('、').length).toBeLessThanOrEqual(3)
  })

  it('普通页面不误报', () => {
    expect(detectChallenge({ url: 'https://blog.example.com/verification-of-sources' })).toEqual({
      challenge: false,
      confidence: 0
    })
    // 普通嵌入 iframe 不算挑战
    expect(
      detectChallenge({
        url: 'https://news.example.com/',
        frames: [{ url: 'https://www.youtube.com/embed/abc', title: 'video' }]
      }).challenge
    ).toBe(false)
    // 登录页不算挑战
    expect(
      detectChallenge({ url: 'https://accounts.example.com/login', text: '请输入密码登录' }).challenge
    ).toBe(false)
  })

  it('缺失 frames/text 时不抛错', () => {
    expect(detectChallenge({ url: 'https://a.com/' })).toEqual({ challenge: false, confidence: 0 })
    expect(() => detectChallenge({ url: '' })).not.toThrow()
  })
})
