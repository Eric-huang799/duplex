/**
 * 广告拦截引擎的公共类型。
 *
 * 这一层刻意不依赖 electron / 网络 / 第三方包：解析、匹配、元素隐藏都能在
 * vitest 里直接跑，主进程也可以在启动早期同步构建索引，不必等窗口就绪。
 */

/** 一条域名规则（`||example.com^`、`@@||a.example.com^` 或纯域名行）。 */
export interface DomainRule {
  /** 规则原文，命中时原样回报，便于日志里定位是哪一条生效。 */
  rule: string
  /** 小写、无首尾点的域名；匹配时按 hostname 的父域逐级查表。 */
  domain: string
  /** true = `@@` 例外规则（放行），优先于拦截规则。 */
  exception: boolean
}

/** 一条已编译的通用正则规则（整行 `/.../` 形式）。 */
export interface RegexRule {
  /** 规则原文（含首尾斜杠）。 */
  rule: string
  /** 统一按不区分大小写编译，匹配对象是完整 URL。 */
  regex: RegExp
  exception: boolean
}

/** 一条元素隐藏（cosmetic）规则，`example.com##.ad-banner` 的形式。 */
export interface CosmeticRule {
  /** 规则原文。 */
  rule: string
  /** `##` 前的正选域（含子域）；空数组 = 全局规则。 */
  domains: string[]
  /** `~` 排除域，命中任一即不应用；优先级高于 domains。 */
  excludeDomains: string[]
  /** `##` 后的 CSS 选择器（已 trim）。 */
  selector: string
}

/** 解析统计，用来回答「这份列表实际生效了多少条、跳过了多少、为什么」。 */
export interface FilterListStats {
  /** 真正尝试解析的行数（非注释、非空行）。 */
  total: number
  /** 成功生效的规则数（domain + regex + cosmetic）。 */
  accepted: number
  /** 被跳过的规则数；恒有 accepted + skipped === total。 */
  skipped: number
  /** 注释行数（`!` 开头与 `[Adblock Plus 2.0]` 这类头部）。 */
  commentLines: number
  /** 空行/纯空白行数。 */
  blankLines: number
  /** 跳过原因细分，定位列表里哪一段没被接受。 */
  skippedReasons: {
    /** 正则超过长度上限。 */
    regexTooLong: number
    /** `new RegExp` 编译失败（括号不配对等）。 */
    regexInvalid: number
    /** 语法不在本子集内（$options、#@#、通配符域名等）。 */
    unsupported: number
    /** 域名/选择器为空或非法。 */
    invalid: number
  }
}

/** `parseFilterList` 的结果。 */
export interface ParsedFilterList {
  domain: DomainRule[]
  regex: RegexRule[]
  cosmetic: CosmeticRule[]
  stats: FilterListStats
}

/** 匹配结果的原因，只用于诊断，不参与拦截决策。 */
export type MatchReason = 'blocked' | 'exception' | 'loopback' | 'non-http' | 'invalid' | 'no-rule'

/** `AdblockEngine.match` 的返回值。 */
export interface MatchResult {
  blocked: boolean
  /** 命中的规则原文（拦截或例外）；没有命中时缺省。 */
  rule?: string
  /** true = 命中的是例外规则（放行）。 */
  exception?: boolean
  /** 诊断原因，例如本机回环被强制放行时是 `loopback`。 */
  reason: MatchReason
}
