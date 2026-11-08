import { describe, expect, it } from 'vitest'
import { cosmeticCssFor } from '../src/main/adblock/cosmetic'
import { MAX_REGEX_LENGTH, parseFilterList } from '../src/main/adblock/filter-list'
import { AdblockEngine } from '../src/main/adblock/matcher'
import type { DomainRule, ParsedFilterList, RegexRule } from '../src/main/adblock/types'

function engineFrom(text: string): AdblockEngine {
  return new AdblockEngine(parseFilterList(text))
}

describe('parseFilterList', () => {
  it('跳过注释/空行/无效正则并正确计数', () => {
    const tooLong = 'a'.repeat(MAX_REGEX_LENGTH + 1)
    const parsed = parseFilterList(
      [
        '! 注释行',
        '[Adblock Plus 2.0]',
        '',
        '   ',
        '||ads.example.com^',
        'example.org',
        '/ads[0-9]+\\.js/',
        '/[unclosed/',
        `/${tooLong}/`,
        '||example.net^$third-party'
      ].join('\n')
    )

    expect(parsed.domain.map((rule) => rule.domain)).toEqual(['ads.example.com', 'example.org'])
    expect(parsed.regex).toHaveLength(1)
    expect(parsed.cosmetic).toHaveLength(0)
    expect(parsed.stats).toEqual({
      total: 6,
      accepted: 3,
      skipped: 3,
      commentLines: 2,
      blankLines: 2,
      skippedReasons: { regexTooLong: 1, regexInvalid: 1, unsupported: 1, invalid: 0 }
    })
    expect(parsed.stats.accepted + parsed.stats.skipped).toBe(parsed.stats.total)

    // 存活下来的正则规则确实能拦到对应 URL。
    const engine = new AdblockEngine(parsed)
    expect(engine.match('https://cdn.test/ads12.js')).toMatchObject({
      blocked: true,
      rule: '/ads[0-9]+\\.js/'
    })
  })

  it('无效 cosmetic 计入 invalid/unsupported，`#@#` 例外现在是合法规则', () => {
    const parsed = parseFilterList(
      ['example.com##', 'bad_domain!!##.x', '@@example.com##.x', '#@#.ad'].join('\n')
    )
    // `#@#.ad` 从"不支持丢弃"改为解析为例外规则（见 cosmetic-exceptions.test.ts）
    expect(parsed.cosmetic).toHaveLength(1)
    expect(parsed.cosmetic[0]).toMatchObject({ selector: '.ad', exception: true })
    expect(parsed.stats).toMatchObject({
      total: 4,
      accepted: 1,
      skipped: 3,
      skippedReasons: { regexTooLong: 0, regexInvalid: 0, unsupported: 1, invalid: 2 }
    })
  })
})

describe('AdblockEngine 域名匹配', () => {
  it('域名规则命中子域，不误伤 example.com.evil.net', () => {
    const engine = engineFrom(
      ['||ads.example.com^', 'example.org', '@@||safe.ads.example.com^'].join('\n')
    )

    expect(engine.match('https://x.ads.example.com/a.js')).toMatchObject({
      blocked: true,
      rule: '||ads.example.com^'
    })
    expect(engine.match('https://ads.example.com/a.js').blocked).toBe(true)
    // 例外域（含子域）优先于父域拦截。
    expect(engine.match('https://safe.ads.example.com/a.js')).toMatchObject({
      blocked: false,
      exception: true,
      rule: '@@||safe.ads.example.com^'
    })
    // 只是前缀相同、但不是子域，不能误伤。
    expect(engine.match('https://example.com.evil.net/a.js')).toMatchObject({
      blocked: false,
      reason: 'no-rule'
    })
    expect(engine.match('https://notads.example.com/a.js').blocked).toBe(false)
    // 纯域名行同样匹配子域。
    expect(engine.match('https://sub.example.org/x').blocked).toBe(true)
  })
})

describe('AdblockEngine 放行边界', () => {
  it('回环地址永不拦截（本机 endpoint 不能被自己拦掉）', () => {
    const engine = engineFrom('/^https?:\\/\\//')
    const loopbacks = [
      'http://localhost:3087/rpc',
      'http://127.0.0.1:3210/endpoint.json',
      'http://[::1]:3087/x',
      'http://0.0.0.0:3087/x'
    ]
    for (const url of loopbacks) {
      expect(engine.match(url), url).toMatchObject({ blocked: false, reason: 'loopback' })
    }
    // 同一份会匹配所有 http(s) 的正则，对普通站点仍然生效。
    expect(engine.match('https://example.com/ads.js')).toMatchObject({ blocked: true })
  })

  it('非 http(s) 协议不拦截', () => {
    const engine = engineFrom('/^.*$/')
    const urls = [
      'devtools://devtools/bundled/inspector.html',
      'chrome-extension://abcdefgh/page.html',
      'file:///C:/tmp/ad.html',
      'about:blank'
    ]
    for (const url of urls) {
      expect(engine.match(url), url).toMatchObject({ blocked: false, reason: 'non-http' })
    }
    expect(engine.match('https://example.com/x').blocked).toBe(true)
  })

  it('无法解析的 URL 视为放行', () => {
    expect(engineFrom('/^.*$/').match('not a url')).toMatchObject({
      blocked: false,
      reason: 'invalid'
    })
  })
})

describe('AdblockEngine 例外优先', () => {
  it('域名例外与正则例外都先于拦截规则（包括域名拦截）', () => {
    const engine = engineFrom(
      ['||example.com^', '@@||api.example.com^', '@@/allowed\\.js$/', '/ads\\.js/'].join('\n')
    )

    expect(engine.match('https://example.com/a.js')).toMatchObject({
      blocked: true,
      reason: 'blocked'
    })
    expect(engine.match('https://api.example.com/a.js')).toMatchObject({
      blocked: false,
      exception: true,
      rule: '@@||api.example.com^',
      reason: 'exception'
    })
    // 正则例外可以救回已被域名规则拦掉的 URL。
    expect(engine.match('https://example.com/allowed.js')).toMatchObject({
      blocked: false,
      exception: true,
      rule: '@@/allowed\\.js$/',
      reason: 'exception'
    })
    // 普通正则拦截仍然生效。
    expect(engine.match('https://cdn.test/ads.js')).toMatchObject({
      blocked: true,
      rule: '/ads\\.js/',
      reason: 'blocked'
    })
  })
})

describe('cosmeticCssFor', () => {
  const engine = engineFrom(
    [
      '##.global-ad',
      'example.com##.ad-banner',
      'example.com,~ads.example.com##.sponsored',
      'example.com,foo.test##.sponsor',
      '~example.com##.everywhere',
      'news.example.com##.news-ad',
      'bad_domain!!##.never'
    ].join('\n')
  )

  it('带域名限定与 ~ 排除都能正确给出 CSS（通用规则需显式打开）', () => {
    // 通用（无域名限定）规则默认不套用：它们正是误伤真实元素的来源。
    expect(cosmeticCssFor(engine, 'https://example.com/article')).toBe(
      '.ad-banner,.sponsored,.sponsor{display:none!important}'
    )
    const withGeneric = { includeGeneric: true }
    expect(cosmeticCssFor(engine, 'https://example.com/article', withGeneric)).toBe(
      '.global-ad,.ad-banner,.sponsored,.sponsor{display:none!important}'
    )
    // ~ads.example.com 让 .sponsored 在该子域上不生效。
    expect(cosmeticCssFor(engine, 'https://ads.example.com/a', withGeneric)).toBe(
      '.global-ad,.ad-banner,.sponsor{display:none!important}'
    )
    expect(cosmeticCssFor(engine, 'https://www.example.com/a', withGeneric)).toBe(
      '.global-ad,.ad-banner,.sponsored,.sponsor{display:none!important}'
    )
    // 更具体的 news.example.com 规则只在它自己及子域生效。
    expect(cosmeticCssFor(engine, 'https://news.example.com/a', withGeneric)).toBe(
      '.global-ad,.ad-banner,.sponsored,.sponsor,.news-ad{display:none!important}'
    )
    // 全局规则 everywhere 在非 example.com 站点生效（仅在显式打开通用规则时）。
    expect(cosmeticCssFor(engine, 'https://unrelated.net/a', withGeneric)).toBe(
      '.global-ad,.everywhere{display:none!important}'
    )
    // 后缀相同但不是子域：限定规则不能命中。
    expect(cosmeticCssFor(engine, 'https://example.com.evil.net/a', withGeneric)).toBe(
      '.global-ad,.everywhere{display:none!important}'
    )
  })

  it('非匹配 origin 返回空串', () => {
    const scoped = engineFrom('example.com##.ad-banner')
    expect(cosmeticCssFor(scoped, 'https://other.test/x')).toBe('')
    expect(cosmeticCssFor(scoped, '')).toBe('')
    expect(cosmeticCssFor(scoped, 'not a url')).toBe('')
    expect(cosmeticCssFor(engineFrom(''), 'https://example.com')).toBe('')
  })

  it('兼容直接传裸 hostname / host:port', () => {
    const scoped = engineFrom('example.com##.ad-banner')
    expect(cosmeticCssFor(scoped, 'example.com')).toBe('.ad-banner{display:none!important}')
    expect(cosmeticCssFor(scoped, 'example.com:8080')).toBe(
      '.ad-banner{display:none!important}'
    )
  })
})

describe('AdblockEngine 性能', () => {
  it('5000 条域名 + 200 条正则，2000 次 match 总耗时 < 500ms', () => {
    const domain: DomainRule[] = []
    for (let i = 0; i < 5000; i++) {
      domain.push({ rule: `||d${i}.example.com^`, domain: `d${i}.example.com`, exception: false })
    }
    const regex: RegexRule[] = []
    for (let i = 0; i < 200; i++) {
      const pattern = `adslot${i}\\.js`
      regex.push({ rule: `/${pattern}/`, regex: new RegExp(pattern, 'i'), exception: false })
    }
    const parsed: ParsedFilterList = {
      domain,
      regex,
      cosmetic: [],
      stats: {
        total: 5200,
        accepted: 5200,
        skipped: 0,
        commentLines: 0,
        blankLines: 0,
        skippedReasons: { regexTooLong: 0, regexInvalid: 0, unsupported: 0, invalid: 0 }
      }
    }
    const engine = new AdblockEngine(parsed)

    const urls: string[] = []
    for (let i = 0; i < 2000; i++) {
      urls.push(
        i % 2 === 0
          ? `https://d${i % 5000}.example.com/pixel.gif?i=${i}`
          : `https://cdn${i}.unrelated.test/app.js?i=${i}`
      )
    }

    // 预热，避免把 JIT 编译时间算进断言。
    for (const url of urls.slice(0, 100)) engine.match(url)

    const started = performance.now()
    for (const url of urls) engine.match(url)
    const elapsed = performance.now() - started

    expect(elapsed).toBeLessThan(500)
    // 顺带确认高并发量下结果仍然正确。
    expect(engine.match('https://d7.example.com/a.js').blocked).toBe(true)
    expect(engine.match('https://cdn7.unrelated.test/a.js').reason).toBe('no-rule')
  })
})
