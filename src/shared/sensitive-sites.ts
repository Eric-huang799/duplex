/**
 * 敏感站点判定（纯函数，主进程与渲染层共用）。
 *
 * 产品原则：**默认服从用户**——用户要求什么就尽量做什么；但邮箱、网银、政务、
 * 身份认证这类站点一旦被代操作，代价可能是不可逆的（转账、改密码、泄露邮件）。
 * 所以在这些站点上，agent 必须先取得用户明确授权，而不是"先干了再说"。
 *
 * 这里只做"是否敏感"的判定，不负责授权状态——授权记录由主进程持有，
 * 这样判定逻辑可以单独测试，也不会因为一次误判就把授权状态写坏。
 */

export type SensitiveKind = 'mail' | 'finance' | 'government' | 'identity' | 'health'

export interface SensitivityVerdict {
  sensitive: boolean
  kind?: SensitiveKind
  /** 命中原因，用于向用户解释"为什么要问这一下"。 */
  reason?: string
}

const MAIL_HOSTS = [
  'gmail.com',
  'mail.google.com',
  'outlook.com',
  'outlook.live.com',
  'outlook.office.com',
  'mail.qq.com',
  'exmail.qq.com',
  'mail.163.com',
  'mail.126.com',
  'mail.sina.com.cn',
  'proton.me',
  'mail.proton.me',
  'mail.yahoo.com',
  'icloud.com',
  'mail.icloud.com',
  'zoho.com',
  'mail.zoho.com'
]

const FINANCE_HOSTS = [
  'alipay.com',
  'paypal.com',
  'stripe.com',
  'unionpay.com',
  'icbc.com.cn',
  'ccb.com',
  'abchina.com',
  'boc.cn',
  'cmbchina.com',
  'bankofchina.com',
  '95588.com',
  'psbc.com',
  'cebbank.com',
  'spdb.com.cn',
  'citicbank.com',
  'pingan.com',
  'cmbc.com.cn'
]

const IDENTITY_HOSTS = [
  'accounts.google.com',
  'login.microsoftonline.com',
  'login.live.com',
  'appleid.apple.com',
  'auth0.com',
  'okta.com',
  'passport.baidu.com',
  'login.taobao.com',
  'passport.jd.com',
  'login.sina.com.cn',
  'graph.qq.com',
  'open.weixin.qq.com'
]

/** 路径命中即可判定的敏感动作（登录、改密、支付）。 */
const SENSITIVE_PATH_PATTERNS: Array<{ re: RegExp; kind: SensitiveKind; reason: string }> = [
  { re: /\/(login|signin|sign-in|auth\/|oauth|sso|logon)\b/i, kind: 'identity', reason: '登录/身份认证流程' },
  { re: /\/(password|passwd|reset|recover)\b/i, kind: 'identity', reason: '密码相关流程' },
  { re: /\/(pay|payment|checkout|transfer|withdraw)\b/i, kind: 'finance', reason: '支付/转账流程' }
]

const HEALTH_PATTERN = /(hospital|health|clinic|12320|挂号|医院|病历)/i

function hostOf(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.hostname.toLowerCase().replace(/\.$/, '')
  } catch {
    return null
  }
}

function matchesHost(host: string, list: readonly string[]): boolean {
  return list.some((entry) => host === entry || host.endsWith(`.${entry}`))
}

/** 判定一个 URL 是否属于敏感站点。非 http(s) 与回环地址一律不敏感。 */
export function classifySite(rawUrl: string | null | undefined): SensitivityVerdict {
  if (!rawUrl) return { sensitive: false }
  const host = hostOf(rawUrl)
  if (!host) return { sensitive: false }
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost')) {
    return { sensitive: false }
  }

  if (matchesHost(host, MAIL_HOSTS)) return { sensitive: true, kind: 'mail', reason: '邮箱' }
  if (matchesHost(host, FINANCE_HOSTS)) return { sensitive: true, kind: 'finance', reason: '银行/支付' }
  if (matchesHost(host, IDENTITY_HOSTS)) return { sensitive: true, kind: 'identity', reason: '身份认证' }

  if (/\.gov(\.|$)/i.test(host) || /\.gov\.cn$/i.test(host)) {
    return { sensitive: true, kind: 'government', reason: '政务站点' }
  }

  let pathAndQuery = ''
  try {
    const url = new URL(rawUrl)
    pathAndQuery = `${url.pathname}${url.search}`
  } catch {
    return { sensitive: false }
  }

  for (const rule of SENSITIVE_PATH_PATTERNS) {
    if (rule.re.test(pathAndQuery)) {
      return { sensitive: true, kind: rule.kind, reason: rule.reason }
    }
  }

  if (HEALTH_PATTERN.test(host) || HEALTH_PATTERN.test(pathAndQuery)) {
    return { sensitive: true, kind: 'health', reason: '医疗健康' }
  }

  return { sensitive: false }
}

/** 给用户看的一句话解释。 */
export function describeSensitivity(verdict: SensitivityVerdict): string {
  if (!verdict.sensitive) return ''
  return verdict.reason ?? '敏感站点'
}
