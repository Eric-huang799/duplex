import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ALL_CATEGORIES,
  CATEGORY_META,
  agentGrantNeedsConfirmation,
  agentGrantNotice,
  defaultDecision,
  emptyStore,
  isGrantableOrigin,
  normalizeOrigin,
  originOfUrl,
  resolveDecision,
  type PermissionCategory
} from '../src/shared/permissions'
import { PermissionStore } from '../src/main/permission-store'
import { PERMISSION_CATEGORY, categoryForPermission } from '../src/main/permission-policy'

// ─────────────────────────────────────────────────────────────────────────────
// origin 规范化
// ─────────────────────────────────────────────────────────────────────────────

describe('normalizeOrigin', () => {
  it('接受裸 origin 并归一化默认端口与大小写', () => {
    expect(normalizeOrigin('https://Meeting.Tencent.com')).toBe('https://meeting.tencent.com')
    expect(normalizeOrigin('https://a.example.com:443')).toBe('https://a.example.com')
    expect(normalizeOrigin('http://a.example.com:80')).toBe('http://a.example.com')
    expect(normalizeOrigin('http://localhost:3000')).toBe('http://localhost:3000')
    expect(normalizeOrigin('https://a.example.com:8443')).toBe('https://a.example.com:8443')
  })

  it('去掉尾部点', () => {
    expect(normalizeOrigin('https://example.com.')).toBe('https://example.com')
  })

  it('拒绝带路径 / 查询 / 锚点 / 凭据的输入', () => {
    expect(normalizeOrigin('https://a.example.com/path')).toBeNull()
    expect(normalizeOrigin('https://a.example.com/?q=1')).toBeNull()
    expect(normalizeOrigin('https://a.example.com/#x')).toBeNull()
    expect(normalizeOrigin('https://user:pw@a.example.com')).toBeNull()
  })

  it('拒绝非 http(s) 与无法解析的输入', () => {
    expect(normalizeOrigin('file:///etc/passwd')).toBeNull()
    expect(normalizeOrigin('javascript:alert(1)')).toBeNull()
    expect(normalizeOrigin('about:blank')).toBeNull()
    expect(normalizeOrigin('')).toBeNull()
    expect(normalizeOrigin('not a url')).toBeNull()
  })
})

describe('originOfUrl', () => {
  it('从完整 URL 里提取 origin', () => {
    expect(originOfUrl('https://a.example.com/x/y?z=1#h')).toBe('https://a.example.com')
    expect(originOfUrl('http://127.0.0.1:8080/path')).toBe('http://127.0.0.1:8080')
    expect(originOfUrl('about:blank')).toBeNull()
    expect(originOfUrl(null)).toBeNull()
  })
})

describe('isGrantableOrigin', () => {
  it('https 一律可授权；http 只允许回环地址', () => {
    expect(isGrantableOrigin('https://a.example.com')).toBe(true)
    expect(isGrantableOrigin('http://localhost:3000')).toBe(true)
    expect(isGrantableOrigin('http://127.0.0.1')).toBe(true)
    expect(isGrantableOrigin('http://intranet.corp')).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 类别映射：Electron 权限必须全部归类
// ─────────────────────────────────────────────────────────────────────────────

describe('Electron 权限映射', () => {
  it('每个权限都有类别，且类别是已知的', () => {
    for (const [permission, category] of Object.entries(PERMISSION_CATEGORY)) {
      expect(ALL_CATEGORIES, `权限 ${permission} 映射到了未知类别 ${category}`).toContain(category)
    }
    expect(categoryForPermission('media')).toBe('media')
    expect(categoryForPermission('nope')).toBeNull()
  })

  it('危险能力必须落在 high-risk，低风险能力必须落在 silent', () => {
    expect(agentGrantNeedsConfirmation(PERMISSION_CATEGORY['media'])).toBe(true)
    expect(agentGrantNeedsConfirmation(PERMISSION_CATEGORY['serial'])).toBe(true)
    expect(agentGrantNeedsConfirmation(PERMISSION_CATEGORY['display-capture'])).toBe(true)
    expect(agentGrantNeedsConfirmation(PERMISSION_CATEGORY['fullscreen'])).toBe(false)
    expect(agentGrantNeedsConfirmation(PERMISSION_CATEGORY['mediaKeySystem'])).toBe(false)
    expect(agentGrantNotice(PERMISSION_CATEGORY['fullscreen'])).toBe('none')
    expect(agentGrantNotice(PERMISSION_CATEGORY['geolocation'])).toBe('notify')
    expect(agentGrantNotice(PERMISSION_CATEGORY['media'])).toBe('confirm')
  })

  it('"拒绝即破坏功能"的能力默认放行', () => {
    for (const permission of ['fullscreen', 'mediaKeySystem', 'persistent-storage', 'storage-access', 'web-printing']) {
      const category = PERMISSION_CATEGORY[permission as keyof typeof PERMISSION_CATEGORY]
      expect(defaultDecision(category), `${permission} 默认应放行`).toBe('allow')
    }
  })

  it('硬件直通默认拒绝', () => {
    for (const permission of ['serial', 'usb', 'hid', 'midiSysex', 'smart-card']) {
      const category = PERMISSION_CATEGORY[permission as keyof typeof PERMISSION_CATEGORY]
      expect(defaultDecision(category), `${permission} 默认应拒绝`).toBe('deny')
    }
  })

  it('每个类别都有元数据与文案 key', () => {
    for (const category of ALL_CATEGORIES) {
      expect(CATEGORY_META[category].labelKey.startsWith('perm.cat.')).toBe(true)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 决策引擎
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveDecision', () => {
  const media: PermissionCategory = 'media'
  const fullscreen: PermissionCategory = 'fullscreen'

  it('无规则时回落到内置默认', () => {
    expect(resolveDecision({ category: fullscreen })).toBe('allow')
    expect(resolveDecision({ category: media })).toBe('ask')
    expect(resolveDecision({ category: 'device' })).toBe('deny')
  })

  it('origin 规则优先于全局覆盖', () => {
    expect(
      resolveDecision({ category: media, rule: { decisions: { media: 'allow' } }, global: { media: 'deny' } })
    ).toBe('allow')
  })

  it('全局覆盖在没有 origin 规则时生效', () => {
    expect(resolveDecision({ category: media, global: { media: 'deny' } })).toBe('deny')
  })

  it('「仅本次允许」优先于持久规则', () => {
    expect(
      resolveDecision({ category: media, sessionGrant: true, rule: { decisions: { media: 'deny' } } })
    ).toBe('allow')
  })

  it('AI 暂停时只拒绝 AI 发起的请求，不影响真人点全屏', () => {
    expect(resolveDecision({ category: media, fromAgent: true, aiPaused: true })).toBe('deny')
    expect(resolveDecision({ category: fullscreen, fromAgent: true, aiPaused: true })).toBe('deny')
    // 真人发起的请求不受 AI 状态影响
    expect(resolveDecision({ category: fullscreen, fromAgent: false, aiPaused: true })).toBe('allow')
    expect(
      resolveDecision({ category: media, fromAgent: false, aiPaused: true, rule: { decisions: { media: 'allow' } } })
    ).toBe('allow')
  })

  it('AI 正持有写权时拒绝高危类别，但不拦低危类别', () => {
    expect(resolveDecision({ category: media, fromAgent: true, aiDriving: true })).toBe('deny')
    expect(
      resolveDecision({ category: fullscreen, fromAgent: true, aiDriving: true, rule: { decisions: { fullscreen: 'allow' } } })
    ).toBe('allow')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 存储
// ─────────────────────────────────────────────────────────────────────────────

describe('PermissionStore', () => {
  let dir = ''

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplex-perm-'))
  })

  afterEach(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  })

  it('首次运行返回空规则（不是"全部允许"）', () => {
    const store = new PermissionStore(dir)
    expect(store.list()).toEqual([])
    expect(store.globalDecisions()).toEqual({})
    expect(new PermissionStore(dir).ruleFor('https://a.example.com')).toBeNull()
  })

  it('写入后可重新读取，且稀疏存储（等于内置默认的项不落盘）', () => {
    const store = new PermissionStore(dir)
    expect(store.set('https://a.example.com', 'media', 'allow', 'user').ok).toBe(true)
    // 全屏的内置默认就是 allow，写 allow 不应产生规则
    expect(store.set('https://a.example.com', 'fullscreen', 'allow', 'user')).toEqual({ ok: true, changed: false })
    store.flushNow()

    const reloaded = new PermissionStore(dir)
    expect(reloaded.ruleFor('https://a.example.com')?.decisions).toEqual({ media: 'allow' })
    expect(reloaded.ruleFor('https://a.example.com')?.source).toBe('user')
  })

  it('把规则设回内置默认等于删除该条', () => {
    const store = new PermissionStore(dir)
    store.set('https://a.example.com', 'media', 'allow', 'user')
    expect(store.ruleFor('https://a.example.com')?.decisions.media).toBe('allow')
    store.set('https://a.example.com', 'media', 'ask', 'user')
    expect(store.ruleFor('https://a.example.com')).toBeNull()
  })

  it('拒绝非法 origin / 类别 / 决定', () => {
    const store = new PermissionStore(dir)
    expect(store.set('https://a.example.com/path', 'media', 'allow', 'user').ok).toBe(false)
    expect(store.set('https://a.example.com', 'nope' as PermissionCategory, 'allow', 'user').ok).toBe(false)
    expect(store.set('https://a.example.com', 'media', 'maybe' as never, 'user').ok).toBe(false)
  })

  it('删除单条与清空整个 origin', () => {
    const store = new PermissionStore(dir)
    store.set('https://a.example.com', 'media', 'allow', 'user')
    store.set('https://a.example.com', 'notifications', 'deny', 'user')
    expect(store.remove('https://a.example.com', 'media')).toEqual({ ok: true, removed: 1 })
    expect(store.ruleFor('https://a.example.com')?.decisions).toEqual({ notifications: 'deny' })
    expect(store.remove('https://a.example.com').removed).toBe(1)
    expect(store.ruleFor('https://a.example.com')).toBeNull()
  })

  it('主文件损坏时从 .bak 恢复', () => {
    const store = new PermissionStore(dir)
    store.set('https://a.example.com', 'media', 'allow', 'user')
    store.flushNow()
    // 再写一次，让 .bak 成为上一版
    store.set('https://b.example.com', 'geolocation', 'allow', 'agent')
    store.flushNow()

    fs.writeFileSync(path.join(dir, 'permissions.json'), '{ this is not json', 'utf8')
    const recovered = new PermissionStore(dir)
    expect(recovered.ruleFor('https://a.example.com')?.decisions.media).toBe('allow')
  })

  it('主文件与 .bak 都损坏时回退成空规则，而不是"全部允许"', () => {
    fs.writeFileSync(path.join(dir, 'permissions.json'), 'garbage', 'utf8')
    fs.writeFileSync(path.join(dir, 'permissions.json.bak'), 'also garbage', 'utf8')
    const store = new PermissionStore(dir)
    expect(store.list()).toEqual([])
    expect(store.effective('https://a.example.com').find((e) => e.category === 'device')?.decision).toBe('deny')
  })

  it('丢弃未知类别与非法的决定值', () => {
    fs.writeFileSync(
      path.join(dir, 'permissions.json'),
      JSON.stringify({
        version: 1,
        global: {},
        origins: {
          'https://a.example.com': {
            origin: 'https://a.example.com',
            decisions: { media: 'allow', nonsense: 'allow', notifications: 'maybe' },
            updatedAt: Date.now(),
            source: 'agent'
          }
        }
      }),
      'utf8'
    )
    const store = new PermissionStore(dir)
    expect(store.ruleFor('https://a.example.com')?.decisions).toEqual({ media: 'allow' })
  })

  it('effective() 给出完整生效视图', () => {
    const store = new PermissionStore(dir)
    store.set('https://a.example.com', 'media', 'deny', 'user')
    store.grantForSession('https://a.example.com', 'geolocation')
    const view = new Map(store.effective('https://a.example.com').map((e) => [e.category, e]))
    expect(view.get('media')?.decision).toBe('deny')
    expect(view.get('media')?.source).toBe('user')
    expect(view.get('geolocation')?.source).toBe('session')
    expect(view.get('fullscreen')?.decision).toBe('allow')
    expect(view.get('fullscreen')?.source).toBe('default')
    expect(store.effective('https://a.example.com')).toHaveLength(ALL_CATEGORIES.length)
  })

  it('「仅本次允许」不落盘', () => {
    const store = new PermissionStore(dir)
    store.grantForSession('https://a.example.com', 'media')
    expect(store.isSessionGranted('https://a.example.com', 'media')).toBe(true)
    store.flushNow()
    const reloaded = new PermissionStore(dir)
    expect(reloaded.isSessionGranted('https://a.example.com', 'media')).toBe(false)
    expect(reloaded.list()).toEqual([])
  })

  it('emptyStore 是合法初始状态', () => {
    expect(emptyStore()).toEqual({ version: 1, global: {}, origins: {} })
  })
})
