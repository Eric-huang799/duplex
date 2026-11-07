import { describe, expect, it } from 'vitest'
import { canFillInto, classifyFields, originOf, shouldOfferSave } from '../src/shared/autofill'

describe('originOf', () => {
  it('从完整 URL 提取 origin，去掉路径、查询和锚点', () => {
    expect(originOf('https://Example.com/login?redirect=%2F#top')).toBe('https://example.com')
    expect(originOf('https://example.com:8443/a/b?c=d')).toBe('https://example.com:8443')
    expect(originOf('http://localhost:5173/index.html')).toBe('http://localhost:5173')
  })

  it('主机名小写、默认端口省略', () => {
    expect(originOf('https://example.com:443/')).toBe('https://example.com')
    expect(originOf('http://example.com:80/')).toBe('http://example.com')
  })

  it('非 http/https 一律拒绝', () => {
    const rejected = [
      'ftp://example.com',
      'file:///C:/Windows/win.ini',
      'javascript:alert(1)',
      'data:text/html,<h1>x</h1>',
      'about:blank',
      'chrome://settings',
      'not a url',
      ''
    ]
    for (const raw of rejected) expect(originOf(raw), raw).toBeNull()
    expect(originOf(null)).toBeNull()
    expect(originOf(undefined)).toBeNull()
  })

  it('带内嵌凭据的地址不认', () => {
    expect(originOf('https://user:pass@example.com/')).toBeNull()
  })
})

describe('canFillInto', () => {
  it('完全相同的 origin 才放行', () => {
    expect(canFillInto('https://example.com', 'https://example.com')).toBe(true)
    expect(canFillInto('https://example.com:8443', 'https://example.com:8443')).toBe(true)
    expect(canFillInto('http://localhost:5173', 'http://localhost:5173')).toBe(true)
  })

  it('子域一律不填（父域与子域互填都不行）', () => {
    expect(canFillInto('https://mail.example.com', 'https://example.com')).toBe(false)
    expect(canFillInto('https://example.com', 'https://mail.example.com')).toBe(false)
    expect(canFillInto('https://www.example.com', 'https://example.com')).toBe(false)
    expect(canFillInto('https://example.com', 'https://www.example.com')).toBe(false)
  })

  it('协议降级/升级都不填（localhost 也不例外）', () => {
    expect(canFillInto('http://example.com', 'https://example.com')).toBe(false)
    expect(canFillInto('https://example.com', 'http://example.com')).toBe(false)
    expect(canFillInto('http://localhost:5173', 'https://localhost:5173')).toBe(false)
    expect(canFillInto('https://localhost:5173', 'http://localhost:5173')).toBe(false)
  })

  it('端口不同不填', () => {
    expect(canFillInto('https://example.com:8443', 'https://example.com')).toBe(false)
    expect(canFillInto('https://example.com', 'https://example.com:8443')).toBe(false)
  })

  it('不做任何宽容匹配：两侧必须已规范化且完全一致', () => {
    expect(canFillInto('https://example.com', 'https://example.com/')).toBe(false)
    expect(canFillInto('https://example.com', 'HTTPS://EXAMPLE.COM')).toBe(false)
    expect(canFillInto('', '')).toBe(false)
  })
})

describe('classifyFields', () => {
  it('标准登录表单：识别用户名框与密码框', () => {
    const result = classifyFields([
      { index: 0, type: 'text', name: 'username', visible: true },
      { index: 1, type: 'password', name: 'password', visible: true },
      { index: 2, type: 'submit', name: 'login', visible: true }
    ])
    expect(result.userField).toBe(0)
    expect(result.passwordFields).toEqual([1])
  })

  it('只有密码框时不猜用户名', () => {
    const result = classifyFields([{ index: 4, type: 'password', name: 'pass' }])
    expect(result.userField).toBeUndefined()
    expect(result.passwordFields).toEqual([4])
  })

  it('用户名藏在 autocomplete token 里也能识别', () => {
    const result = classifyFields([
      { index: 2, type: 'text', name: 'q', autocomplete: 'section-login username webauthn' },
      { index: 5, type: 'password', name: 'pw', autocomplete: 'current-password' }
    ])
    expect(result.userField).toBe(2)
    expect(result.passwordFields).toEqual([5])
  })

  it('按 name / id 关键词识别用户名（含 email / login / account）', () => {
    expect(classifyFields([{ index: 1, type: 'email', name: 'email', id: 'email' }]).userField).toBe(1)
    expect(classifyFields([{ index: 2, type: 'text', name: 'login_id' }]).userField).toBe(2)
    expect(classifyFields([{ index: 3, type: 'text', id: 'account' }]).userField).toBe(3)
    expect(classifyFields([{ index: 4, type: 'text', name: 'user_name' }]).userField).toBe(4)
    // 名称不含关键词的搜索框不是用户名框
    expect(classifyFields([{ index: 5, type: 'search', name: 'q' }]).userField).toBeUndefined()
  })

  it('不可见字段被忽略，且按钮不会被当成用户名框', () => {
    const result = classifyFields([
      { index: 0, type: 'text', name: 'username', visible: false },
      { index: 1, type: 'password', name: 'password', visible: false },
      { index: 2, type: 'hidden', name: 'login_token' },
      { index: 3, type: 'submit', name: 'login' },
      { index: 4, type: 'text', name: 'account' },
      { index: 5, type: 'password', name: 'password' }
    ])
    expect(result.userField).toBe(4)
    expect(result.passwordFields).toEqual([5])
  })

  it('多个密码框按 index 升序全部返回', () => {
    const result = classifyFields([
      { index: 3, type: 'password', name: 'confirm' },
      { index: 2, type: 'password', name: 'pass' }
    ])
    expect(result.passwordFields).toEqual([2, 3])
  })
})

describe('shouldOfferSave', () => {
  const base = {
    submittedForm: true,
    hasPassword: true,
    passwordChanged: true,
    originStoredForUser: false
  }

  it('提交了含新密码的表单、且该账号还没存过 → 询问保存', () => {
    expect(shouldOfferSave(base)).toBe(true)
  })

  it('任一前置条件不满足就不打扰用户', () => {
    expect(shouldOfferSave({ ...base, submittedForm: false })).toBe(false)
    expect(shouldOfferSave({ ...base, hasPassword: false })).toBe(false)
    expect(shouldOfferSave({ ...base, passwordChanged: false })).toBe(false)
    expect(shouldOfferSave({ ...base, originStoredForUser: true })).toBe(false)
  })

  it('四个布尔的全部 16 种组合都严格等于「提交 ∧ 有密码框 ∧ 密码变化 ∧ 未存过」', () => {
    for (let mask = 0; mask < 16; mask += 1) {
      const input = {
        submittedForm: (mask & 1) !== 0,
        hasPassword: (mask & 2) !== 0,
        passwordChanged: (mask & 4) !== 0,
        originStoredForUser: (mask & 8) !== 0
      }
      const expected =
        input.submittedForm && input.hasPassword && input.passwordChanged && !input.originStoredForUser
      expect(shouldOfferSave(input), `mask=${mask}`).toBe(expected)
    }
  })
})
