/**
 * 真人浏览时的"可疑站点"预警判定。
 *
 * 三条原则：
 *  1. **只提醒，不拦截**。用户自己搜到、点开的东西，浏览器不做内容审查——
 *     判断"该不该看"是用户的事，我们只把**客观存在的事实**摆出来。
 *  2. **只看可验证的技术信号**，不看内容、不做黑白名单。绝不出现"这个站点
 *     被认为不权威/不合规"这类主观判断，那正是我们要避免的东西。
 *  3. 预警与"敏感站点"是两套语义：邮箱/银行是**正当**的敏感站点（该问的是
 *     "要不要让 AI 进去"），不是"可疑"。
 */
export type RiskLevel = 'none' | 'notice' | 'warn'

export type RiskReason =
  | 'insecure'
  | 'ip-host'
  | 'punycode'
  | 'credentials-in-url'
  | 'unusual-port'
  | 'long-host'

export interface SiteRisk {
  level: RiskLevel
  reasons: RiskReason[]
}

const NO_RISK: SiteRisk = { level: 'none', reasons: [] }

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0'])

function compareLevel(a: RiskLevel, b: RiskLevel): RiskLevel {
  const rank = { none: 0, notice: 1, warn: 2 } as const
  return rank[a] >= rank[b] ? a : b
}

/**
 * 评估一个 URL。只返回"技术事实"级别的理由，永远不返回"阻止访问"。
 */
export function assessSiteRisk(rawUrl: string | null | undefined): SiteRisk {
  if (!rawUrl) return NO_RISK
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return NO_RISK
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return NO_RISK

  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  if (!host) return NO_RISK
  // 本地开发与自家面板不参与预警
  if (LOOPBACK.has(host) || host.endsWith('.localhost') || IPV4.test(host) && host.startsWith('127.')) {
    return NO_RISK
  }

  const reasons: RiskReason[] = []
  let level: RiskLevel = 'none'

  // 1) 明文 HTTP：内容可被中间人读取或篡改
  if (url.protocol === 'http:') {
    reasons.push('insecure')
    level = compareLevel(level, 'warn')
  }

  // 2) 直接用 IP 访问：证书/域名校验通常无法生效
  if (IPV4.test(host) || host.startsWith('[')) {
    reasons.push('ip-host')
    level = compareLevel(level, 'notice')
  }

  // 3) punycode 域名：同形字钓鱼的典型手法（真实字符被编码隐藏）
  if (host.split('.').some((label) => label.startsWith('xn--'))) {
    reasons.push('punycode')
    level = compareLevel(level, 'warn')
  }

  // 4) URL 里内嵌凭据（https://user:pass@host）：几乎总是钓鱼或旧式泄露
  if (url.username || url.password) {
    reasons.push('credentials-in-url')
    level = compareLevel(level, 'warn')
  }

  // 5) 非标准端口
  const port = url.port
  if (port && port !== '80' && port !== '443') {
    reasons.push('unusual-port')
    level = compareLevel(level, 'notice')
  }

  // 6) 异常长的域名或过多子域：常见于仿冒/跟踪域
  const labels = host.split('.').filter(Boolean)
  if (host.length > 60 || labels.length > 5) {
    reasons.push('long-host')
    level = compareLevel(level, 'notice')
  }

  return reasons.length === 0 ? NO_RISK : { level, reasons }
}

/** 是否值得向用户提示（notice 及以上）。 */
export function shouldWarn(risk: SiteRisk): boolean {
  return risk.level !== 'none'
}
