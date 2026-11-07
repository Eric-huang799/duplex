/**
 * 站点权限规则的持久化。
 *
 * 独立文件 `permissions.json`（不塞进 settings.json：那是含 API key、整体重写的
 * 配置对象，站点列表会随使用增长，需要自己的原子写、备份与容量上限）。
 *
 * 可靠性要求（与 browser-session.ts / settings.ts 同等级别）：
 *  - 原子写：tmp → rename
 *  - 备份：写前把上一版复制成 .bak；读取失败依次回退「主文件 → .bak → 空」
 *  - **损坏时回退成空规则，绝不回退成"全部允许"**
 *  - 上限 500 个 origin，超出按 updatedAt 淘汰最旧
 *  - 只存与内置默认不同的项（稀疏），将来调整默认值能自动继承
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  ALL_CATEGORIES,
  defaultDecision,
  emptyStore,
  isKnownCategory,
  metaOf,
  normalizeOrigin,
  type Decision,
  type OriginRule,
  type PermissionCategory,
  type PermissionStoreFile
} from '../shared/permissions'

const MAX_ORIGINS = 500
const SAVE_DEBOUNCE_MS = 400

type SetResult = { ok: true; changed: boolean } | { ok: false; error: string }

function isDecision(value: unknown): value is Decision {
  return value === 'allow' || value === 'ask' || value === 'deny'
}

export class PermissionStore {
  private file: string
  private backup: string
  private data: PermissionStoreFile
  private timer: ReturnType<typeof setTimeout> | null = null
  /** 「仅本次允许」——只在内存里，进程结束即失效。 */
  private sessionGrants = new Map<string, Set<PermissionCategory>>()

  constructor(directory: string) {
    this.file = path.join(directory, 'permissions.json')
    this.backup = `${this.file}.bak`
    this.data = this.load()
  }

  // ── 读取 ────────────────────────────────────────────────────────────────

  private static sanitize(raw: unknown): PermissionStoreFile | null {
    if (!raw || typeof raw !== 'object') return null
    const parsed = raw as Partial<PermissionStoreFile>
    if (parsed.version !== 1) return null
    const store = emptyStore()

    if (parsed.global && typeof parsed.global === 'object') {
      for (const [key, value] of Object.entries(parsed.global)) {
        if (isKnownCategory(key) && isDecision(value) && value !== defaultDecision(key)) {
          store.global[key] = value
        }
      }
    }

    if (parsed.origins && typeof parsed.origins === 'object') {
      for (const [key, value] of Object.entries(parsed.origins)) {
        const origin = normalizeOrigin(key)
        if (!origin || !value || typeof value !== 'object') continue
        const entry = value as Partial<OriginRule>
        const decisions: Partial<Record<PermissionCategory, Decision>> = {}
        for (const [cat, decision] of Object.entries(entry.decisions ?? {})) {
          if (!isKnownCategory(cat) || !isDecision(decision)) continue
          if (decision === defaultDecision(cat)) continue
          decisions[cat] = decision
        }
        if (Object.keys(decisions).length === 0) continue
        store.origins[origin] = {
          origin,
          decisions,
          updatedAt: Number.isFinite(entry.updatedAt) ? (entry.updatedAt as number) : Date.now(),
          source: entry.source === 'agent' ? 'agent' : 'user'
        }
      }
    }
    return store
  }

  private load(): PermissionStoreFile {
    for (const candidate of [this.file, this.backup]) {
      try {
        const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8')) as unknown
        const store = PermissionStore.sanitize(parsed)
        if (store) return store
        console.error(`[permissions] ${path.basename(candidate)} 结构不合法，已跳过`)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code
        if (code !== 'ENOENT') {
          console.error(`[permissions] 读取 ${path.basename(candidate)} 失败：`, (error as Error).message)
        }
      }
    }
    return emptyStore()
  }

  // ── 写入 ────────────────────────────────────────────────────────────────

  private scheduleSave(): void {
    if (this.timer) return
    this.timer = setTimeout(() => this.flushNow(), SAVE_DEBOUNCE_MS)
    this.timer.unref?.()
  }

  flushNow(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const tmp = `${this.file}.${process.pid}.tmp`
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8')
      try {
        if (fs.existsSync(this.file)) fs.copyFileSync(this.file, this.backup)
      } catch {
        /* 备份失败不阻断主文件写入 */
      }
      fs.renameSync(tmp, this.file)
    } catch (error) {
      try {
        fs.unlinkSync(tmp)
      } catch {
        /* nothing was written */
      }
      console.error('[permissions] 保存失败：', (error as Error).message)
    }
  }

  private evictIfNeeded(): void {
    const keys = Object.keys(this.data.origins)
    if (keys.length <= MAX_ORIGINS) return
    const ordered = keys
      .map((key) => this.data.origins[key])
      .sort((a, b) => a.updatedAt - b.updatedAt)
    const drop = ordered.slice(0, ordered.length - MAX_ORIGINS)
    for (const rule of drop) delete this.data.origins[rule.origin]
    console.error(`[permissions] 规则超过 ${MAX_ORIGINS} 条，已按最久未修改淘汰 ${drop.length} 条`)
  }

  // ── 对外 API ────────────────────────────────────────────────────────────

  globalDecisions(): Partial<Record<PermissionCategory, Decision>> {
    return { ...this.data.global }
  }

  ruleFor(origin: string | null | undefined): OriginRule | null {
    const key = normalizeOrigin(origin)
    if (!key) return null
    return this.data.origins[key] ?? null
  }

  /** 设置一条规则；`decision` 等于内置默认时视为"恢复默认"（删除该键）。 */
  set(origin: string, category: PermissionCategory, decision: Decision, source: 'user' | 'agent'): SetResult {
    const key = normalizeOrigin(origin)
    if (!key) return { ok: false, error: 'invalid origin' }
    if (!isKnownCategory(category)) return { ok: false, error: 'invalid category' }
    if (!isDecision(decision)) return { ok: false, error: 'invalid decision' }

    const existing = this.data.origins[key]
    const current = existing?.decisions[category] ?? defaultDecision(category)
    if (current === decision && existing) return { ok: true, changed: false }

    if (!existing) {
      if (decision === defaultDecision(category)) return { ok: true, changed: false }
      this.data.origins[key] = { origin: key, decisions: { [category]: decision }, updatedAt: Date.now(), source }
      this.evictIfNeeded()
      this.scheduleSave()
      return { ok: true, changed: true }
    }

    if (decision === defaultDecision(category)) delete existing.decisions[category]
    else existing.decisions[category] = decision
    existing.updatedAt = Date.now()
    existing.source = source
    if (Object.keys(existing.decisions).length === 0) delete this.data.origins[key]
    this.scheduleSave()
    return { ok: true, changed: true }
  }

  /** 删除某 origin 的某条规则；省略 category 则清空该 origin 全部规则。 */
  remove(origin: string, category?: PermissionCategory): { ok: boolean; removed: number } {
    const key = normalizeOrigin(origin)
    if (!key) return { ok: false, removed: 0 }
    const existing = this.data.origins[key]
    if (!existing) return { ok: true, removed: 0 }
    if (category) {
      const had = existing.decisions[category] !== undefined
      delete existing.decisions[category]
      if (Object.keys(existing.decisions).length === 0) delete this.data.origins[key]
      if (had) this.scheduleSave()
      return { ok: true, removed: had ? 1 : 0 }
    }
    const removed = Object.keys(existing.decisions).length
    delete this.data.origins[key]
    if (removed > 0) this.scheduleSave()
    return { ok: true, removed }
  }

  clearAll(): void {
    this.data = emptyStore()
    this.sessionGrants.clear()
    this.flushNow()
  }

  /** 管理界面/agent 用的只读视图，按最近修改倒序。 */
  list(): OriginRule[] {
    return Object.values(this.data.origins)
      .map((rule) => ({ ...rule, decisions: { ...rule.decisions } }))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** 某 origin 的完整生效视图（含未设置的类别 → 内置默认）。 */
  effective(origin: string): Array<{ category: PermissionCategory; decision: Decision; source: 'default' | 'user' | 'agent' | 'session' }> {
    const rule = this.ruleFor(origin)
    const key = normalizeOrigin(origin)
    const session = key ? this.sessionGrants.get(key) : undefined
    return ALL_CATEGORIES.map((category) => {
      if (session?.has(category)) return { category, decision: 'allow' as Decision, source: 'session' as const }
      const explicit = rule?.decisions[category] ?? this.data.global[category]
      if (explicit) {
        return { category, decision: explicit, source: rule?.decisions[category] ? rule.source : ('user' as const) }
      }
      return { category, decision: metaOf(category).default, source: 'default' as const }
    })
  }

  // ── 「仅本次」────────────────────────────────────────────────────────────

  grantForSession(origin: string, category: PermissionCategory): void {
    const key = normalizeOrigin(origin)
    if (!key) return
    let set = this.sessionGrants.get(key)
    if (!set) {
      set = new Set()
      this.sessionGrants.set(key, set)
    }
    set.add(category)
  }

  isSessionGranted(origin: string | null | undefined, category: PermissionCategory): boolean {
    const key = normalizeOrigin(origin)
    if (!key) return false
    return this.sessionGrants.get(key)?.has(category) === true
  }

  clearSessionGrants(): void {
    this.sessionGrants.clear()
  }

  /** 仅用于测试/诊断。 */
  sessionGrantCount(): number {
    let total = 0
    for (const set of this.sessionGrants.values()) total += set.size
    return total
  }
}
