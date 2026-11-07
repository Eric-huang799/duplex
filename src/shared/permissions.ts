/**
 * 站点级权限策略（Site Permissions）——纯逻辑，无 Electron / Node 依赖。
 *
 * 设计文档：docs/design-site-permissions.md
 * 产品原则：**AI 在安全范围内可以做一切有益于用户的事情。**
 *
 * 由此得到两个彼此正交的轴：
 *
 *  1. `default` —— 没有任何规则时怎么办（allow / ask / deny）
 *     判据是"**拒绝它会不会直接破坏一项日常功能**"：
 *     会 → allow（全屏、DRM、打印、SSO 存储…）；不会 → ask；高危 → deny。
 *
 *  2. `tier` —— **AI 能有多大自主权去改这条规则**
 *     判据是"**出错时能不能撤回**"：
 *       silent    → 可撤回且无隐私含义，AI 可以自行放宽，不打扰用户
 *       sensitive → 有隐私含义但可撤回，AI 可以自行放宽，但必须在对话里"说一声"并可一键撤销
 *       high-risk → 不可撤回（身体、设备、录屏），AI 放宽必须经过人工确认
 *
 * 核心思想：**能撤回就不打扰用户。** 确认弹窗是摩擦，只用在真正的
 * "不可逆"或"触及身体/设备"上；其余交给默认值与撤销入口。
 */

/** 用户可理解的权限类别（不是 Electron 的原始权限名）。 */
export type PermissionCategory =
  | 'fullscreen'
  | 'drm'
  | 'storage'
  | 'wake'
  | 'print'
  | 'pointer'
  | 'clipboard-write'
  | 'media'
  | 'notifications'
  | 'geolocation'
  | 'clipboard-read'
  | 'display-capture'
  | 'file-system'
  | 'sensors'
  | 'open-external'
  | 'device'
  | 'local-network'
  | 'other'

export type Decision = 'allow' | 'ask' | 'deny'

/** AI 修改该类别规则所需的自主权等级。 */
export type PermissionTier = 'silent' | 'sensitive' | 'high-risk'

export interface CategoryMeta {
  readonly tier: PermissionTier
  /** 没有规则时的行为。 */
  readonly default: Decision
  /** i18n key：类别名（"摄像头和麦克风"）。 */
  readonly labelKey: string
}

/**
 * 类别元数据。**这是唯一的策略真相源**——
 * 默认值、AI 自主权、文案 key 都从这里派生，不要在别处硬编码。
 */
export const CATEGORY_META: Readonly<Record<PermissionCategory, CategoryMeta>> = {
  // ── 静默放行：拒绝即破坏功能，且可撤回、无隐私含义 ──────────────────
  fullscreen: { tier: 'silent', default: 'allow', labelKey: 'perm.cat.fullscreen' },
  drm: { tier: 'silent', default: 'allow', labelKey: 'perm.cat.drm' },
  storage: { tier: 'silent', default: 'allow', labelKey: 'perm.cat.storage' },
  wake: { tier: 'silent', default: 'allow', labelKey: 'perm.cat.wake' },
  print: { tier: 'silent', default: 'allow', labelKey: 'perm.cat.print' },
  pointer: { tier: 'silent', default: 'allow', labelKey: 'perm.cat.pointer' },
  'clipboard-write': { tier: 'silent', default: 'allow', labelKey: 'perm.cat.clipboardWrite' },

  // ── 询问：有隐私含义，但可撤回；用户点一次就记住 ────────────────────
  media: { tier: 'high-risk', default: 'ask', labelKey: 'perm.cat.media' },
  notifications: { tier: 'sensitive', default: 'ask', labelKey: 'perm.cat.notifications' },
  geolocation: { tier: 'sensitive', default: 'ask', labelKey: 'perm.cat.geolocation' },
  'clipboard-read': { tier: 'sensitive', default: 'ask', labelKey: 'perm.cat.clipboardRead' },
  sensors: { tier: 'sensitive', default: 'ask', labelKey: 'perm.cat.sensors' },
  'open-external': { tier: 'sensitive', default: 'ask', labelKey: 'perm.cat.openExternal' },
  other: { tier: 'sensitive', default: 'ask', labelKey: 'perm.cat.other' },

  // ── 高危：不可撤回 / 触及身体或设备，默认不询问、直接拒绝，需显式开启 ──
  'display-capture': { tier: 'high-risk', default: 'ask', labelKey: 'perm.cat.displayCapture' },
  'file-system': { tier: 'high-risk', default: 'deny', labelKey: 'perm.cat.fileSystem' },
  device: { tier: 'high-risk', default: 'deny', labelKey: 'perm.cat.device' },
  'local-network': { tier: 'high-risk', default: 'deny', labelKey: 'perm.cat.localNetwork' }
}

export const ALL_CATEGORIES = Object.keys(CATEGORY_META) as PermissionCategory[]

export function metaOf(category: PermissionCategory): CategoryMeta {
  return CATEGORY_META[category] ?? CATEGORY_META.other
}

export function defaultDecision(category: PermissionCategory): Decision {
  return metaOf(category).default
}

export function isKnownCategory(value: unknown): value is PermissionCategory {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(CATEGORY_META, value)
}

/**
 * AI 想把这个类别的规则改成 `allow` 时，是否需要先问人。
 * 收紧（deny / ask）永远不需要——收紧是安全方向。
 */
export function agentGrantNeedsConfirmation(category: PermissionCategory): boolean {
  return metaOf(category).tier === 'high-risk'
}

/** AI 改完之后怎么告知用户。 */
export function agentGrantNotice(category: PermissionCategory): 'none' | 'notify' | 'confirm' {
  const tier = metaOf(category).tier
  if (tier === 'high-risk') return 'confirm'
  if (tier === 'sensitive') return 'notify'
  return 'none'
}

// ─────────────────────────────────────────────────────────────────────────────
// origin 规范化
// ─────────────────────────────────────────────────────────────────────────────

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.toLowerCase())
}

function formatOrigin(protocol: string, host: string, port: string): string {
  const fallback = protocol === 'https:' ? '443' : '80'
  return port && port !== fallback ? `${protocol}//${host}:${port}` : `${protocol}//${host}`
}

/**
 * 从任意 URL 提取规范化 origin（`scheme://host[:port]`）。
 * 非 http(s)、无 host、`about:blank` 一律返回 null。
 */
export function originOfUrl(raw: string | null | undefined): string | null {
  if (!raw) return null
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  const host = u.hostname.toLowerCase().replace(/\.$/, '')
  if (!host) return null
  return formatOrigin(u.protocol, host, u.port)
}

/**
 * 严格模式：只接受**裸 origin**，拒绝带路径/查询/锚点/凭据的输入。
 * AI 工具与设置页写规则时必须走这里——绝不能让 `https://a.com/x?y=z`
 * 变成一条规则键，那会把权限文件变成历史记录。
 */
export function normalizeOrigin(raw: string | null | undefined): string | null {
  if (!raw) return null
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  if (u.username || u.password) return null
  if (u.search || u.hash) return null
  if (u.pathname !== '/' && u.pathname !== '') return null
  const host = u.hostname.toLowerCase().replace(/\.$/, '')
  if (!host) return null
  return formatOrigin(u.protocol, host, u.port)
}

/**
 * 非 https 只允许回环地址。用于 AI 写入校验：不允许 agent 把
 * `http://内网主机` 记成"已放行"。
 */
export function isGrantableOrigin(origin: string): boolean {
  let u: URL
  try {
    u = new URL(origin)
  } catch {
    return false
  }
  if (u.protocol === 'https:') return true
  return u.protocol === 'http:' && isLoopbackHost(u.hostname.replace(/\.$/, ''))
}

// ─────────────────────────────────────────────────────────────────────────────
// 决策引擎
// ─────────────────────────────────────────────────────────────────────────────

export interface OriginRule {
  /** 规范化 origin，即键本身。 */
  origin: string
  /** 只存与内置默认不同的类别（稀疏），这样调整默认值能自动继承。 */
  decisions: Partial<Record<PermissionCategory, Decision>>
  updatedAt: number
  /** 审计：谁改的。 */
  source: 'user' | 'agent'
}

export interface PermissionStoreFile {
  version: 1
  /** 用户对默认值的全局覆盖（稀疏）。 */
  global: Partial<Record<PermissionCategory, Decision>>
  origins: Record<string, OriginRule>
}

export interface DecisionInput {
  category: PermissionCategory
  /** 该 origin 的持久规则。 */
  rule?: Pick<OriginRule, 'decisions'> | null
  /** 全局覆盖。 */
  global?: Partial<Record<PermissionCategory, Decision>> | null
  /** 内存中的"仅本次允许"。 */
  sessionGrant?: boolean
  /** 急停 / AI 暂停中。 */
  aiPaused?: boolean
  /** 该标签正被 AI 的写操作持有。 */
  aiDriving?: boolean
  /** 请求是否来自 AI 发起的浏览操作（否则是真人点击）。 */
  fromAgent?: boolean
}

/**
 * 决策优先级（自上而下，首个命中即返回）：
 *   1. 请求来自 AI 且 AI 已暂停            → deny
 *   2. 请求来自 AI 且 AI 正持有该标签写权   → 高危类别 deny
 *   3. 仅本次允许                          → allow
 *   4. 该 origin 的显式规则（比全局更具体）
 *   5. 全局覆盖
 *   6. 内置默认
 *
 * 注意 1/2 只作用于 AI 发起的请求——用户自己按全屏不该因为 AI 暂停而失效。
 */
export function resolveDecision(input: DecisionInput): Decision {
  const meta = metaOf(input.category)
  if (input.fromAgent && input.aiPaused) return 'deny'
  if (input.fromAgent && input.aiDriving && meta.tier === 'high-risk') return 'deny'
  if (input.sessionGrant) return 'allow'
  const explicit = input.rule?.decisions?.[input.category] ?? input.global?.[input.category]
  if (explicit === 'allow' || explicit === 'ask' || explicit === 'deny') return explicit
  return meta.default
}

/** 空规则文件（首次运行 / 损坏回退时使用——绝不回退成"全部允许"）。 */
export function emptyStore(): PermissionStoreFile {
  return { version: 1, global: {}, origins: {} }
}

/**
 * 主进程 → 渲染层的权限询问请求（提示条渲染用）。
 * `origin` 与 `topOrigin` **必须**由主进程从 `details.requestingUrl` 计算，
 * 渲染层只负责显示——页面与渲染层都不能决定"这条提示代表谁"。
 */
export interface PermissionAskRequest {
  id: number
  origin: string
  topOrigin?: string
  category: PermissionCategory
  tabId: number | null
  /** 类别文案的 i18n key（`perm.cat.*`）。 */
  labelKey: string
  tier: PermissionTier
}

export type PermissionAnswer = 'allow' | 'allow-session' | 'deny'
