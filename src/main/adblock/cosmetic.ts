/**
 * 元素隐藏（cosmetic）规则 → 一段可注入的 CSS。
 *
 * 只做 `display:none!important`，绝不移除 DOM：AI 的 snapshot 依赖页面结构，
 * 移除节点会让人和 AI 看到的页面不一致。配合 webContents.insertCSS 使用时
 * DOM 原样保留，只是视觉上不显示。
 */
import { matchesHostname, type AdblockEngine } from './matcher'
import type { CosmeticRule } from './types'

/** 从 origin / 完整 URL / 裸 hostname 里取主机名；取不到返回空串。 */
function hostnameOf(origin: string): string {
  const raw = origin.trim()
  if (!raw) return ''
  if (raw.includes('://')) {
    try {
      return new URL(raw).hostname
    } catch {
      return ''
    }
  }
  // 兼容直接传 hostname / host:port 的调用方（origin 的常见误用）。
  const candidate = raw.split(/[/?#]/, 1)[0] ?? ''
  const host = candidate.replace(/:\d+$/, '')
  return /^[a-z0-9.-]+$/i.test(host) ? host : ''
}

/** 排除域优先；没有正选域 = 全局规则（排除项之外的全部站点）。 */
function appliesTo(rule: CosmeticRule, hostname: string): boolean {
  for (const excluded of rule.excludeDomains) {
    if (matchesHostname(hostname, excluded)) return false
  }
  if (rule.domains.length === 0) return true
  return rule.domains.some((domain) => matchesHostname(hostname, domain))
}

/**
 * 返回该 origin 适用的元素隐藏 CSS。
 * 无匹配规则（或 origin 不可解析）时返回空串，调用方据此跳过注入。
 */
export function cosmeticCssFor(engine: AdblockEngine, origin: string): string {
  const hostname = hostnameOf(origin)
  if (!hostname) return ''

  const selectors = new Set<string>()
  for (const rule of engine.cosmeticRules) {
    if (!appliesTo(rule, hostname)) continue
    const selector = rule.selector.trim()
    if (!selector) continue
    // 防御性再查一遍：手工构造的 engine 可能绕过解析器校验。
    if (/[{}<]/.test(selector)) continue
    selectors.add(selector)
  }
  if (selectors.size === 0) return ''

  return `${Array.from(selectors).join(',')}{display:none!important}`
}
