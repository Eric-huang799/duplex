/**
 * 广告拦截匹配器。
 *
 * 性能要点：域名规则全部收进一张哈希表（key = 规则域名），匹配时只对
 * hostname 的「自身 + 各级父域」做 O(1) 查表（域名层级通常 ≤ 4 次），绝不
 * 对每条规则逐个跑正则。只有域名表没命中、或需要确认正则例外时，才扫一遍
 * 小规模正则列表兜底。
 *
 * 安全边界：本机回环与非 http(s) 协议永远放行——主进程的 MCP/HTTP 端点就在
 * 127.0.0.1 上，拦了它 AI 面板会直接断线。
 */
import type {
  CosmeticRule,
  FilterListStats,
  MatchResult,
  ParsedFilterList,
  RegexRule
} from './types'

/** 单个域名下最多保留两类规则原文（拦截 / 例外）；同一域名重复的规则只留第一条。 */
interface DomainBucket {
  block?: string
  exception?: string
}

/**
 * 永远放行的主机名（小写、已去掉 IPv6 方括号）。
 * `::` 与 `0.0.0.0` 是「未指定地址」，请求落到本机，同样不能拦。
 */
const LOOPBACK_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  '0:0:0:0:0:0:0:1',
  '::',
  '::ffff:7f00:1'
])

/** 规范化 hostname：小写、去掉 IPv6 方括号与末尾根点。 */
function normalizeHostname(raw: string): string {
  const value = raw.trim().toLowerCase()
  const withoutBrackets = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value
  return withoutBrackets.replace(/\.+$/, '')
}

/** 本机回环判定（匹配前最先执行，命中即无条件放行）。 */
export function isLoopbackHostname(rawHostname: string): boolean {
  const host = normalizeHostname(rawHostname)
  if (!host) return false
  if (LOOPBACK_HOSTS.has(host)) return true
  // RFC 6761：localhost 的子域同样指向本机。
  if (host.endsWith('.localhost')) return true
  // 127.0.0.0/8 整段都是回环，不只 127.0.0.1。
  return /^127(?:\.\d{1,3}){3}$/.test(host)
}

/** hostname 是否等于域名本身或是其子域（`x.ads.example.com` 匹配 `ads.example.com`）。 */
export function matchesHostname(rawHostname: string, rawDomain: string): boolean {
  const host = normalizeHostname(rawHostname)
  const domain = normalizeHostname(rawDomain)
  if (!host || !domain) return false
  return host === domain || host.endsWith(`.${domain}`)
}

/**
 * hostname 自身 + 各级父域，用于逐级查哈希表。
 * 单标签后缀（`com`）不可能出现在规则里（解析要求至少两段），到它就停，
 * 顺带省掉一次无意义的查表。
 */
function parentDomains(hostname: string): string[] {
  const chain: string[] = [hostname]
  let rest = hostname
  for (;;) {
    const dot = rest.indexOf('.')
    if (dot < 0) break
    rest = rest.slice(dot + 1)
    if (!rest.includes('.')) break
    chain.push(rest)
  }
  return chain
}

/** 广告拦截引擎：构造时建索引，之后 `match` 是同步纯函数。 */
export class AdblockEngine {
  private readonly domainIndex = new Map<string, DomainBucket>()
  private readonly blockRegex: RegexRule[] = []
  private readonly exceptionRegex: RegexRule[] = []
  /** 元素隐藏规则；`cosmetic.ts` 只读它，不参与请求拦截。 */
  readonly cosmeticRules: readonly CosmeticRule[]
  /** 解析期统计（跳过/无效规则条数），便于启动日志诊断。 */
  readonly stats: FilterListStats

  constructor(parsed: ParsedFilterList) {
    this.stats = parsed.stats
    this.cosmeticRules = parsed.cosmetic.slice()

    for (const rule of parsed.domain) {
      const bucket = this.domainIndex.get(rule.domain) ?? {}
      if (rule.exception) {
        if (bucket.exception === undefined) bucket.exception = rule.rule
      } else if (bucket.block === undefined) {
        bucket.block = rule.rule
      }
      this.domainIndex.set(rule.domain, bucket)
    }

    for (const rule of parsed.regex) {
      if (rule.exception) this.exceptionRegex.push(rule)
      else this.blockRegex.push(rule)
    }
  }

  /** 索引规模，启动日志里打印一行就能确认列表加载成功。 */
  get size(): { domains: number; blockRegex: number; exceptionRegex: number; cosmetic: number } {
    return {
      domains: this.domainIndex.size,
      blockRegex: this.blockRegex.length,
      exceptionRegex: this.exceptionRegex.length,
      cosmetic: this.cosmeticRules.length
    }
  }

  /**
   * 判定一个请求 URL 是否应被拦截。
   *
   * 顺序（重要）：协议 → 回环 → 域名例外 → 正则例外 → 域名拦截 → 正则拦截。
   * 例外必须先于任何拦截检查，包括「域名拦截已命中但存在正则例外」的情况。
   */
  match(rawUrl: string): MatchResult {
    let url: URL
    try {
      url = new URL(rawUrl)
    } catch {
      return { blocked: false, reason: 'invalid' }
    }

    const protocol = url.protocol.toLowerCase()
    if (protocol !== 'http:' && protocol !== 'https:') {
      return { blocked: false, reason: 'non-http' }
    }

    const hostname = normalizeHostname(url.hostname)
    if (isLoopbackHostname(hostname)) {
      return { blocked: false, reason: 'loopback' }
    }

    const chain = parentDomains(hostname)

    // 例外优先：域名例外 → 正则例外，任一命中即整体放行。
    for (const host of chain) {
      const exception = this.domainIndex.get(host)?.exception
      if (exception !== undefined) {
        return { blocked: false, exception: true, rule: exception, reason: 'exception' }
      }
    }
    for (const rule of this.exceptionRegex) {
      if (rule.regex.test(rawUrl)) {
        return { blocked: false, exception: true, rule: rule.rule, reason: 'exception' }
      }
    }

    for (const host of chain) {
      const block = this.domainIndex.get(host)?.block
      if (block !== undefined) {
        return { blocked: true, rule: block, reason: 'blocked' }
      }
    }
    for (const rule of this.blockRegex) {
      if (rule.regex.test(rawUrl)) {
        return { blocked: true, rule: rule.rule, reason: 'blocked' }
      }
    }

    return { blocked: false, reason: 'no-rule' }
  }
}
