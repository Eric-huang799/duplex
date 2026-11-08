import { describe, expect, it } from 'vitest'
import { parseFilterList } from '../src/main/adblock/filter-list'
import { AdblockEngine } from '../src/main/adblock/matcher'
import { cosmeticCssFor } from '../src/main/adblock/cosmetic'

function engineFor(text: string): AdblockEngine {
  return new AdblockEngine(parseFilterList(text))
}

describe('元素隐藏：#@# 例外与通用规则默认关闭', () => {
  it('域内精确规则仍然生效', () => {
    const engine = engineFor('example.com##.ad-banner')
    expect(cosmeticCssFor(engine, 'https://example.com/')).toContain('.ad-banner')
    expect(cosmeticCssFor(engine, 'https://other.com/')).toBe('')
  })

  it('通用规则默认不套用（这是页面被改坏的主要来源）', () => {
    const engine = engineFor('##.ad')
    expect(cosmeticCssFor(engine, 'https://example.com/')).toBe('')
    expect(cosmeticCssFor(engine, 'https://example.com/', { includeGeneric: true })).toContain('.ad')
  })

  it('#@# 例外会在该站点取消同选择器的隐藏', () => {
    const engine = engineFor('##.ad\nexample.com#@#.ad')
    // 通用规则本身默认关掉；显式打开后，例外仍必须生效
    expect(cosmeticCssFor(engine, 'https://example.com/', { includeGeneric: true })).toBe('')
    // 别的站点没有例外，照旧隐藏
    expect(cosmeticCssFor(engine, 'https://other.com/', { includeGeneric: true })).toContain('.ad')
  })

  it('例外只作用于声明的域名（含子域）', () => {
    const engine = engineFor('##.ad\nsub.example.com#@#.ad')
    expect(cosmeticCssFor(engine, 'https://sub.example.com/', { includeGeneric: true })).toBe('')
    expect(cosmeticCssFor(engine, 'https://example.com/', { includeGeneric: true })).toContain('.ad')
  })

  it('#@# 规则被计入 accepted，而不是当作不支持丢弃', () => {
    const parsed = parseFilterList('##.ad\nexample.com#@#.ad')
    const exceptions = parsed.cosmetic.filter((rule) => rule.exception)
    expect(exceptions).toHaveLength(1)
    expect(exceptions[0]?.selector).toBe('.ad')
    expect(parsed.stats.skippedReasons.unsupported).toBe(0)
  })

  it('域内规则与例外并存时，只保留未被取消的', () => {
    const engine = engineFor('example.com##.ad\nexample.com##.banner\nexample.com#@#.ad')
    const css = cosmeticCssFor(engine, 'https://example.com/')
    expect(css).toContain('.banner')
    expect(css).not.toContain('.ad')
  })
})

