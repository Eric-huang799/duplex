/**
 * 广告拦截的规则来源：启动时联网拉取 + 本地缓存回退。
 *
 * 三条设计目标：
 *  1. **开箱能拦**——拉不到规则就等于没装广告拦截，所以必须联网取。
 *  2. **离线也不能崩**——断网/被墙时代码要退回上次缓存；连缓存都没有就返回空，
 *     调用方按"不拦截"处理，绝不抛错把启动流程带崩。
 *  3. **可诊断**——每个 URL 的成败都要能报出来（用户看到"0 条规则"时得知道为什么）。
 *
 * 注意：网络请求是注入的依赖（生产注入 Electron `net`，它跟随系统代理），
 * 所以这个模块不 import electron，可以直接单测。
 */
import fs from 'node:fs'
import path from 'node:path'
import { writeFileAtomic } from '../../shared/atomic'

export interface RuleFetchResult {
  url: string
  body: string
  etag?: string
  lastModified?: string
}

export type RuleFetcher = (url: string) => Promise<RuleFetchResult>

export interface RuleSourceOptions {
  /** 缓存目录（生产传 cobrowseDir()）。 */
  directory: string
  urls?: string[]
  /** 缓存有效期，默认 7 天。 */
  ttlMs?: number
  /** 单份规则体积上限，默认 8MB。 */
  maxBytes?: number
  timeoutMs?: number
  now?: () => number
}

export interface RuleLoadOutcome {
  /** 合并后的规则文本；空串表示不拦截。 */
  text: string
  source: 'network' | 'cache' | 'empty'
  perUrl: Array<{ url: string; ok: boolean; error?: string; bytes?: number }>
  fetchedAt?: number
}

const DEFAULT_URLS = [
  'https://easylist.to/easylist/easylist.txt',
  // 中国区规则：easylist.to 上没有这个文件（会 404），用 Adblock Plus 的下载站
  'https://easylist-downloads.adblockplus.org/easylistchina.txt'
]

interface CacheMeta {
  version: 1
  fetchedAt: number
  bytes: number
}

export class RuleSource {
  private cacheFile: string
  private metaFile: string
  private urls: string[]
  private ttlMs: number
  private maxBytes: number
  private timeoutMs: number
  private now: () => number

  constructor(
    options: RuleSourceOptions,
    private fetcher: RuleFetcher
  ) {
    this.cacheFile = path.join(options.directory, 'adblock-rules.txt')
    this.metaFile = path.join(options.directory, 'adblock-rules.meta.json')
    this.urls = options.urls ?? DEFAULT_URLS
    this.ttlMs = options.ttlMs ?? 7 * 24 * 60 * 60 * 1000
    this.maxBytes = options.maxBytes ?? 8 * 1024 * 1024
    this.timeoutMs = options.timeoutMs ?? 20_000
    this.now = options.now ?? Date.now
  }

  private readMeta(): CacheMeta | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.metaFile, 'utf8')) as Partial<CacheMeta>
      if (parsed?.version !== 1 || typeof parsed.fetchedAt !== 'number') return null
      return { version: 1, fetchedAt: parsed.fetchedAt, bytes: Number(parsed.bytes) || 0 }
    } catch {
      return null
    }
  }

  private readCache(): string | null {
    try {
      const text = fs.readFileSync(this.cacheFile, 'utf8')
      return text.length > 0 ? text : null
    } catch {
      return null
    }
  }

  private writeCache(text: string, fetchedAt: number): void {
    try {
      const meta: CacheMeta = { version: 1, fetchedAt, bytes: Buffer.byteLength(text, 'utf8') }
      writeFileAtomic(this.cacheFile, text)
      writeFileAtomic(this.metaFile, JSON.stringify(meta, null, 2))
    } catch (error) {
      // 只记错误本身，绝不把规则正文写进日志
      console.error('[adblock] 规则缓存写入失败：', (error as Error)?.message ?? error)
    }
  }

  private timeout(): Promise<never> {
    return new Promise((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`请求超时 ${this.timeoutMs}ms`)), this.timeoutMs)
      timer.unref?.()
    })
  }

  load(): Promise<RuleLoadOutcome> {
    return this.run(false)
  }

  refresh(): Promise<RuleLoadOutcome> {
    return this.run(true)
  }

  private async run(force: boolean): Promise<RuleLoadOutcome> {
    const meta = this.readMeta()
    const cached = this.readCache()

    if (!force && meta && cached && this.now() - meta.fetchedAt < this.ttlMs) {
      return { text: cached, source: 'cache', perUrl: [], fetchedAt: meta.fetchedAt }
    }

    const perUrl: RuleLoadOutcome['perUrl'] = []
    const parts: string[] = []
    for (const url of this.urls) {
      try {
        const result = await Promise.race([this.fetcher(url), this.timeout()])
        const body = (result?.body ?? '').replace(/^\uFEFF/, '')
        const bytes = Buffer.byteLength(body, 'utf8')
        if (bytes === 0) throw new Error('响应为空')
        if (bytes > this.maxBytes) throw new Error(`超过体积上限 ${this.maxBytes} 字节`)
        parts.push(body)
        perUrl.push({ url, ok: true, bytes })
      } catch (error) {
        perUrl.push({ url, ok: false, error: (error as Error)?.message ?? String(error) })
      }
    }

    if (parts.length > 0) {
      const text = parts.join('\n')
      const fetchedAt = this.now()
      this.writeCache(text, fetchedAt)
      return { text, source: 'network', perUrl, fetchedAt }
    }

    if (cached) return { text: cached, source: 'cache', perUrl, fetchedAt: meta?.fetchedAt }
    return { text: '', source: 'empty', perUrl }
  }
}
