/**
 * EasyList 子集解析器。
 *
 * 只接受引擎真能安全表达的几种语法：
 *   `! 注释` / `[Adblock Plus 2.0]` 头
 *   `@@||example.com^`   例外（放行）
 *   `||example.com^`     域名（含子域）拦截
 *   `example.com`        纯域名拦截
 *   `/regex/`            通用正则（长度 ≤ 200 且能编译）
 *   `example.com##.ad`   元素隐藏（支持逗号分隔与 `~` 排除）
 *
 * 不认识的语法（`$options`、`#@#`、通配符域名等）一律丢弃并计入
 * `stats.skipped`，调用方从 `skippedReasons` 就能看出列表里有多少规则没生效。
 */
import type {
  CosmeticRule,
  DomainRule,
  FilterListStats,
  ParsedFilterList,
  RegexRule
} from './types'

/** 通用正则的长度上限（不含首尾斜杠）。超过即丢弃，避免病态正则拖垮匹配。 */
export const MAX_REGEX_LENGTH = 200

/** 单条元素隐藏选择器的长度上限：防止写坏的列表把注入的 CSS 撑爆。 */
export const MAX_COSMETIC_SELECTOR_LENGTH = 1000

/** 域名形状：至少两段，标签内允许字母/数字/连字符（punycode 也满足）。 */
const DOMAIN_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i

/** `||example.com^`：本子集只接受「域名 + 结尾 ^」的精确形态。 */
const ANCHORED_DOMAIN_PATTERN = /^\|\|([a-z0-9._-]+)\^$/i

type SkipReason = keyof FilterListStats['skippedReasons']

/** 解析失败的原因，成功时给 `rule`。 */
type RegexOutcome = { rule: RegexRule } | { reason: SkipReason }

function emptyStats(): FilterListStats {
  return {
    total: 0,
    accepted: 0,
    skipped: 0,
    commentLines: 0,
    blankLines: 0,
    skippedReasons: {
      regexTooLong: 0,
      regexInvalid: 0,
      unsupported: 0,
      invalid: 0
    }
  }
}

/** 小写、去首尾点并校验形状；不像域名的返回 null。 */
function normalizeDomain(value: string): string | null {
  const domain = value.trim().toLowerCase().replace(/^\.+/, '').replace(/\.+$/, '')
  if (!domain || !DOMAIN_PATTERN.test(domain)) return null
  return domain
}

/** 整行 `/.../` → 已编译正则；任何不合法/超长/不是整行包裹的都给出原因。 */
function parseRegex(line: string, exception: boolean): RegexOutcome {
  if (!line.endsWith('/') || line.length < 3) return { reason: 'unsupported' }
  const pattern = line.slice(1, -1)
  if (!pattern) return { reason: 'regexInvalid' }
  if (pattern.length > MAX_REGEX_LENGTH) return { reason: 'regexTooLong' }
  try {
    // 广告 URL 大小写混用很常见，统一按不区分大小写匹配。
    // 规则原文保留 `@@` 前缀，命中日志里能直接看出是例外规则。
    return {
      rule: { rule: exception ? `@@${line}` : line, regex: new RegExp(pattern, 'i'), exception }
    }
  } catch {
    return { reason: 'regexInvalid' }
  }
}

/**
 * `example.com,~ads.example.com##.ad-banner`。
 * 域名部分有任何非法 token 就整条丢弃：宁可少隐藏，也不要把限定域丢掉后
 * 变成一条意外的全局规则。
 */
function parseCosmetic(line: string, at: number, exception = false, markerLength = 2): CosmeticRule | null {
  const domains: string[] = []
  const excludeDomains: string[] = []
  const rawDomains = line.slice(0, at).trim()
  if (rawDomains) {
    for (const token of rawDomains.split(',')) {
      const trimmed = token.trim()
      if (!trimmed) return null
      const excluded = trimmed.startsWith('~')
      const normalized = normalizeDomain(excluded ? trimmed.slice(1) : trimmed)
      if (!normalized) return null
      if (excluded) excludeDomains.push(normalized)
      else domains.push(normalized)
    }
    if (domains.length === 0 && excludeDomains.length === 0) return null
  }

  const selector = line.slice(at + markerLength).trim()
  if (!selector || selector.length > MAX_COSMETIC_SELECTOR_LENGTH) return null
  // `{}` 会提前闭合注入的规则；`<` 在把 CSS 塞进 <style> 时可能被当成标签。
  // 只做 display:none，绝不支持 +js(...) 这类脚本注入。
  if (/[{}<]/.test(selector) || selector.startsWith('+js(')) return null

  return exception
    ? { rule: line, domains, excludeDomains, selector, exception: true }
    : { rule: line, domains, excludeDomains, selector }
}

/** 解析一份 EasyList 子集文本；任何异常行都不会抛错，只会计入统计。 */
export function parseFilterList(text: string): ParsedFilterList {
  const domain: DomainRule[] = []
  const regex: RegexRule[] = []
  const cosmetic: CosmeticRule[] = []
  const stats = emptyStats()

  const skip = (reason: SkipReason): void => {
    stats.skipped++
    stats.skippedReasons[reason]++
  }

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) {
      stats.blankLines++
      continue
    }
    if (line.startsWith('!') || (line.startsWith('[') && line.endsWith(']'))) {
      stats.commentLines++
      continue
    }
    stats.total++

    let body = line
    let exception = false
    if (body.startsWith('@@')) {
      exception = true
      body = body.slice(2).trim()
    }
    if (!body) {
      skip('invalid')
      continue
    }

    // 整行 /.../ 先判：正则里可能出现 `##` 或 `||`，不能被后面的分支误认。
    if (body.startsWith('/')) {
      const outcome = parseRegex(body, exception)
      if ('reason' in outcome) skip(outcome.reason)
      else {
        regex.push(outcome.rule)
        stats.accepted++
      }
      continue
    }

    // 元素隐藏。`#@#` 是例外规则（在指定站点取消隐藏），必须解析而不是丢弃：
    // 丢掉例外就等于把所有"这里不要隐藏"的保护全部无视，页面会被我们改坏。
    const exceptionAt = body.indexOf('#@#')
    const cosmeticAt = body.indexOf('##')
    if (exceptionAt >= 0 && (cosmeticAt < 0 || exceptionAt < cosmeticAt)) {
      const rule = parseCosmetic(body, exceptionAt, true, 3)
      if (!rule) skip('invalid')
      else {
        cosmetic.push(rule)
        stats.accepted++
      }
      continue
    }
    if (cosmeticAt >= 0) {
      if (exception) {
        skip('unsupported')
        continue
      }
      const rule = parseCosmetic(body, cosmeticAt)
      if (!rule) skip('invalid')
      else {
        cosmetic.push(rule)
        stats.accepted++
      }
      continue
    }
    if (body.includes('#@#') || body.includes('#$#') || body.includes('#?#')) {
      skip('unsupported')
      continue
    }

    // `||example.com^`
    const anchored = ANCHORED_DOMAIN_PATTERN.exec(body)
    if (anchored) {
      const normalized = normalizeDomain(anchored[1] ?? '')
      if (!normalized) {
        skip('invalid')
        continue
      }
      domain.push({ rule: line, domain: normalized, exception })
      stats.accepted++
      continue
    }

    // 纯域名行
    if (DOMAIN_PATTERN.test(body)) {
      domain.push({ rule: line, domain: body.toLowerCase(), exception })
      stats.accepted++
      continue
    }

    skip('unsupported')
  }

  return { domain, regex, cosmetic, stats }
}

