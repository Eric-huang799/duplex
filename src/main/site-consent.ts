/**
 * AI 访问授权表。
 *
 * 语义刻意做窄：
 *  - `session` 授权只活在本次运行（内存），重启即失效；
 *  - `always` 授权落盘，用户可以随时在设置里撤销。
 *
 * 授权键是 **(actor, origin)**，不是单个 origin：
 *  - `actor` 是发起请求的 agent 的稳定标识（主进程 `currentCaller()`，
 *    例如 `builtin`、`mcp:claude`；人类浏览不写进这张表）。
 *  - 浏览器是多个 agent 共用的，A 同意过的站点不能顺带放行 B；每个 agent
 *    必须各自取得授权。这是「未授权即不进入」在多 agent 场景下的完整含义。
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

/** 一条授权：某个 agent 对某个 origin 的许可。 */
export interface ConsentEntry {
  /** 请求方 agent 的稳定标识（`currentCaller()`）。 */
  actor: string
  /** 规范化后的 origin（scheme://host[:port]）。 */
  origin: string
}

/**
 * 磁盘格式 v2。v1 是 `{ version: 1, always: string[] }`，只有 origin、没有 actor。
 * v1 记录无法安全归属于任何 agent —— 归属给"所有 agent"正是本次要修的漏洞，
 * 所以加载时直接丢弃并在日志里说明（见 `load()`）。
 */
interface ConsentFileV2 {
  version: 2
  always: ConsentEntry[]
}

/** 同一条 (actor, origin) 在内存里的键；`\u0000` 不会出现在两者中。 */
function consentKey(actor: string, origin: string): string {
  return `${actor}\u0000${origin}`
}

/** 约束 actor：非空、去掉首尾空白、拒绝控制字符（日志/展示/键分隔都不该被污染）。 */
function normalizeActor(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const actor = raw.trim()
  if (!actor || actor.length > 128) return null
  if (/[\u0000-\u001f\u007f]/.test(actor)) return null
  return actor
}

export class SiteConsentStore {
  private file: string
  private logLine: (message: string) => void
  private always = new Map<string, ConsentEntry>()
  private session = new Map<string, ConsentEntry>()

  constructor(directory: string, log?: (message: string) => void) {
    this.file = path.join(directory, 'site-consent.json')
    this.logLine = log ?? ((message) => console.warn(message))
    this.load()
  }

  private load(): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'))
    } catch {
      /* 首次运行 / 文件损坏：按空表开始（宁可多问一次，也不错误放行） */
      return
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
    const file = parsed as { version?: unknown; always?: unknown }
    if (!Array.isArray(file.always)) return

    const entries: ConsentEntry[] = []
    const legacyOrigins: string[] = []
    for (const raw of file.always) {
      // v1：裸 origin 字符串，没有 actor —— 收起来统一丢弃并告知。
      if (typeof raw === 'string') {
        const origin = accessOrigin(raw)
        if (origin) legacyOrigins.push(origin)
        continue
      }
      if (!raw || typeof raw !== 'object') continue
      const record = raw as { actor?: unknown; origin?: unknown }
      const actor = normalizeActor(record.actor)
      const origin = accessOrigin(typeof record.origin === 'string' ? record.origin : '')
      // v2 里缺 actor 或 origin 的坏记录同样不猜归属，直接忽略。
      if (!actor || !origin) continue
      entries.push({ actor, origin })
    }

    for (const entry of entries) this.always.set(consentKey(entry.actor, entry.origin), entry)

    if (legacyOrigins.length > 0) {
      const preview = legacyOrigins.slice(0, 5).join('、')
      this.logLine(
        `[consent] 旧版授权缺少请求方（agent）标识，已丢弃 ${legacyOrigins.length} 条` +
          `${legacyOrigins.length > 5 ? `（${preview}…）` : `（${preview}）`}；` +
          '这些站点不会自动放行给任何 agent，需要时请让对应 agent 重新请求。'
      )
    }

    // 迁移到 v2：旧格式已丢弃、空文件也标记版本，避免每次启动重复告警。
    if (file.version !== 2 || legacyOrigins.length > 0) this.save()
  }

  private save(): void {
    try {
      const data: ConsentFileV2 = {
        version: 2,
        always: [...this.always.values()].sort(
          (a, b) => a.actor.localeCompare(b.actor) || a.origin.localeCompare(b.origin)
        )
      }
      writeFileAtomic(this.file, JSON.stringify(data, null, 2))
    } catch (error) {
      console.error('[consent] 授权表保存失败：', (error as Error)?.message ?? error)
    }
  }

  /** 当前所有授权（session + always，按 actor/origin 排序），供设置页与策略判定使用。 */
  list(): ConsentEntry[] {
    const merged = new Map<string, ConsentEntry>()
    for (const entry of this.always.values()) merged.set(consentKey(entry.actor, entry.origin), entry)
    for (const entry of this.session.values()) merged.set(consentKey(entry.actor, entry.origin), entry)
    return [...merged.values()].sort(
      (a, b) => a.actor.localeCompare(b.actor) || a.origin.localeCompare(b.origin)
    )
  }

  /** 某个 agent 已获授权的 origin；其他 agent 的授权不会出现在这里。 */
  listFor(rawActor: string): string[] {
    const actor = normalizeActor(rawActor)
    if (!actor) return []
    const origins = new Set<string>()
    for (const entry of this.list()) if (entry.actor === actor) origins.add(entry.origin)
    return [...origins].sort()
  }

  isAuthorized(rawActor: string, rawUrlOrOrigin: string): boolean {
    const actor = normalizeActor(rawActor)
    const origin = accessOrigin(rawUrlOrOrigin)
    if (!actor || !origin) return false
    const key = consentKey(actor, origin)
    return this.always.has(key) || this.session.has(key)
  }

  authorize(
    rawActor: string,
    rawUrlOrOrigin: string,
    scope: ConsentScope
  ): { ok: boolean; origin?: string } {
    const actor = normalizeActor(rawActor)
    const origin = accessOrigin(rawUrlOrOrigin)
    if (!actor || !origin) return { ok: false }
    const entry: ConsentEntry = { actor, origin }
    if (scope === 'always') {
      this.always.set(consentKey(actor, origin), entry)
      this.save()
    } else {
      this.session.set(consentKey(actor, origin), entry)
    }
    return { ok: true, origin }
  }

  /** 只撤销该 actor 在该 origin 上的授权；别的 agent 的授权不受影响。 */
  revoke(rawActor: string, rawUrlOrOrigin: string): { ok: boolean; removed: boolean } {
    const actor = normalizeActor(rawActor)
    const origin = accessOrigin(rawUrlOrOrigin)
    if (!actor || !origin) return { ok: false, removed: false }
    const key = consentKey(actor, origin)
    const removedAlways = this.always.delete(key)
    const removedSession = this.session.delete(key)
    if (removedAlways) this.save()
    return { ok: true, removed: removedAlways || removedSession }
  }

  clear(): void {
    this.always.clear()
    this.session.clear()
    this.save()
  }
}
