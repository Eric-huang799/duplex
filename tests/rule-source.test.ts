import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RuleSource, type RuleFetchResult } from '../src/main/adblock/rule-source'

const DAY = 24 * 60 * 60 * 1000
const BODY = '||ads.example.com^\n||tracker.example.org^'

describe('RuleSource', () => {
  let dir = ''
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplex-rules-'))
  })
  afterEach(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  })

  const okFetcher = (body = BODY, calls?: string[]) => async (url: string): Promise<RuleFetchResult> => {
    calls?.push(url)
    return { url, body }
  }

  it('无缓存时联网拉取并写缓存', async () => {
    const urls: string[] = []
    const source = new RuleSource({ directory: dir, urls: ['https://x/list.txt'] }, okFetcher(BODY, urls))
    const outcome = await source.load()
    expect(outcome.source).toBe('network')
    expect(outcome.text).toContain('ads.example.com')
    expect(urls).toEqual(['https://x/list.txt'])
    expect(fs.existsSync(path.join(dir, 'adblock-rules.txt'))).toBe(true)
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'adblock-rules.meta.json'), 'utf8'))
    expect(meta.version).toBe(1)
    expect(meta.bytes).toBe(Buffer.byteLength(BODY, 'utf8'))
  })

  it('新鲜缓存不发请求', async () => {
    const urls: string[] = []
    const source = new RuleSource({ directory: dir, urls: ['https://x/list.txt'] }, okFetcher(BODY, urls))
    await source.load()
    urls.length = 0
    const second = new RuleSource({ directory: dir, urls: ['https://x/list.txt'] }, okFetcher(BODY, urls))
    const outcome = await second.load()
    expect(outcome.source).toBe('cache')
    expect(outcome.text).toContain('tracker')
    expect(urls).toEqual([])
  })

  it('缓存过期会重新拉取', async () => {
    let clock = 1_000_000
    const urls: string[] = []
    const first = new RuleSource(
      { directory: dir, urls: ['https://x/list.txt'], now: () => clock },
      okFetcher(BODY, urls)
    )
    await first.load()
    clock += 8 * DAY
    const second = new RuleSource(
      { directory: dir, urls: ['https://x/list.txt'], now: () => clock },
      okFetcher(BODY, urls)
    )
    const outcome = await second.load()
    expect(outcome.source).toBe('network')
    expect(urls).toHaveLength(2)
  })

  it('全部失败时回退旧缓存', async () => {
    const good = new RuleSource({ directory: dir, urls: ['https://x/list.txt'] }, okFetcher(BODY))
    await good.load()
    const failing = new RuleSource({ directory: dir, urls: ['https://x/list.txt'] }, async () => {
      throw new Error('ECONNRESET')
    })
    const outcome = await failing.refresh()
    expect(outcome.source).toBe('cache')
    expect(outcome.text).toContain('ads.example.com')
    expect(outcome.perUrl[0]).toMatchObject({ ok: false })
    expect(outcome.perUrl[0]?.error).toContain('ECONNRESET')
  })

  it('全部失败且无缓存时返回空，不抛错', async () => {
    const source = new RuleSource({ directory: dir, urls: ['https://x/list.txt'] }, async () => {
      throw new Error('offline')
    })
    const outcome = await source.load()
    expect(outcome).toMatchObject({ text: '', source: 'empty' })
  })

  it('超过体积上限视为失败', async () => {
    const big = 'x'.repeat(2048)
    const source = new RuleSource({ directory: dir, urls: ['https://x/list.txt'], maxBytes: 1024 }, okFetcher(big))
    const outcome = await source.load()
    expect(outcome.source).toBe('empty')
    expect(outcome.perUrl[0]?.error).toContain('上限')
  })

  it('请求超时计为该 URL 失败', async () => {
    const source = new RuleSource(
      { directory: dir, urls: ['https://x/slow.txt'], timeoutMs: 30 },
      () => new Promise<RuleFetchResult>(() => undefined)
    )
    const outcome = await source.load()
    expect(outcome.source).toBe('empty')
    expect(outcome.perUrl[0]?.error).toContain('超时')
  })

  it('多份规则合并并去掉 BOM', async () => {
    const source = new RuleSource(
      { directory: dir, urls: ['https://a/1.txt', 'https://b/2.txt'] },
      (url) => Promise.resolve({ url, body: url.includes('a/1') ? '\uFEFF||a.example^' : '||b.example^' })
    )
    const outcome = await source.load()
    expect(outcome.text.startsWith('||a.example^')).toBe(true)
    expect(outcome.text).toContain('||b.example^')
    expect(outcome.text).not.toContain('\uFEFF')
  })

  it('元数据损坏时按无缓存处理', async () => {
    fs.writeFileSync(path.join(dir, 'adblock-rules.meta.json'), '{broken', 'utf8')
    fs.writeFileSync(path.join(dir, 'adblock-rules.txt'), '||cached.example^', 'utf8')
    const urls: string[] = []
    const source = new RuleSource({ directory: dir, urls: ['https://x/list.txt'] }, okFetcher(BODY, urls))
    const outcome = await source.load()
    expect(outcome.source).toBe('network')
    expect(urls).toHaveLength(1)
  })
})
