/**
 * AI 访问授权表。
 *
 * 语义刻意做窄：
 *  - `session` 授权只活在本次运行（内存），重启即失效；
 *  - `always` 授权落盘，用户可以随时在设置里撤销。
 *
 * 为什么必须有它：提示词只能"要求"模型先问，能绕过提示词的方式太多了
 * （换个措辞、换个标签、改写 URL）。真正不可绕过的唯一一处，是主进程在执行
 * 动作之前自己判一次——那张表就是这个判定依据。
 */
import fs from 'node:fs'
import path from 'node:path'
import { writeFileAtomic } from '../shared/atomic'
import { accessOrigin } from '../shared/access-policy'

export type ConsentScope = 'session' | 'always'

interface ConsentFile {
  version: 1
  /** 长期授权（落盘）。 */
  always: string[]
}

export class SiteConsentStore {
  private file: string
  private always = new Set<string>()
  private session = new Set<string>()

  constructor(directory: string) {
    this.file = path.join(directory, 'site-consent.json')
    this.load()
  }

  private load(): void {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<ConsentFile>
      if (parsed?.version !== 1 || !Array.isArray(parsed.always)) return
      for (const entry of parsed.always) {
        const origin = accessOrigin(typeof entry === 'string' ? entry : '')
        if (origin) this.always.add(origin)
      }
    } catch {
      /* 首次运行 / 文件损坏：按空表开始（宁可多问一次，也不错误放行） */
    }
  }

  private save(): void {
    try {
      const data: ConsentFile = { version: 1, always: [...this.always].sort() }
      writeFileAtomic(this.file, JSON.stringify(data, null, 2))
    } catch (error) {
      console.error('[consent] 授权表保存失败：', (error as Error)?.message ?? error)
    }
  }

  /** 当前所有已授权的 origin（session + always，供策略判定使用）。 */
  list(): string[] {
    return [...new Set([...this.always, ...this.session])]
  }

  isAuthorized(rawUrlOrOrigin: string): boolean {
    const origin = accessOrigin(rawUrlOrOrigin)
    if (!origin) return false
    return this.always.has(origin) || this.session.has(origin)
  }

  authorize(rawUrlOrOrigin: string, scope: ConsentScope): { ok: boolean; origin?: string } {
    const origin = accessOrigin(rawUrlOrOrigin)
    if (!origin) return { ok: false }
    if (scope === 'always') {
      this.always.add(origin)
      this.save()
    } else {
      this.session.add(origin)
    }
    return { ok: true, origin }
  }

  revoke(rawUrlOrOrigin: string): { ok: boolean; removed: boolean } {
    const origin = accessOrigin(rawUrlOrOrigin)
    if (!origin) return { ok: false, removed: false }
    const removedAlways = this.always.delete(origin)
    const removedSession = this.session.delete(origin)
    if (removedAlways) this.save()
    return { ok: true, removed: removedAlways || removedSession }
  }

  clear(): void {
    this.always.clear()
    this.session.clear()
    this.save()
  }
}
