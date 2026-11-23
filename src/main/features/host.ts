/**
 * 通用功能插件宿主。
 *
 * 职责：
 *  - **内置插件**：由主进程显式 `registerBuiltin()`，默认启用（除非用户禁用过）；
 *  - **外部插件**：扫描 `<cobrowseDir>/features/<id>/`（manifest.json + index.mjs），
 *    默认禁用，用户在设置里启用后才 import 并 activate；
 *  - **命令**：插件 activate 时 `ctx.registerCommand(name, handler)`，工具栏按钮/
 *    状态卡动作通过 `features:invoke` 调用；
 *  - **工具**：`ctx.registerToolHandler(name, handler)`，必须先在 manifest 的
 *    `contributes.tools` 里声明；agent 通过 `host.runTool()` 路由；
 *  - **状态卡**：`ctx.setStatus()` 发布运行时状态，对话里按 features 列表渲染；
 *  - **持久化**：启用/禁用写入 `<cobrowseDir>/features.json`（原子写）。
 *
 * 安全边界（诚实说明）：外部 index.mjs 在**主进程**里执行，拥有完整 Node 权限。
 * 这里的校验只保证 manifest/目录结构合法、命令/工具声明自洽，不是沙箱。
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { BrowserWindow, WebContents } from 'electron'
import { writeFileAtomic } from '../../shared/atomic'
import {
  FEATURE_ID_PATTERN,
  isFeatureCommand,
  isFeatureToolName,
  parseFeatureManifestJson,
  validateFeatureManifest,
  type FeatureInfo,
  type FeatureManifest,
  type FeatureStatus,
  type FeatureStatusAction,
  type FeatureStatusEntry,
  type FeatureValidation
} from '../../shared/features'
import type { ToolResult } from '../tool-handlers'

/** 插件可用的本地资产库子集（导出时复制资产、插入图片时查名字）。 */
export interface FeatureAssets {
  copy(id: string, targetDir: string): string | null
  get?(id: string): { id: string; name: string } | null
}

export type FeatureCommandHandler = (
  args: Record<string, unknown>
) => unknown | Promise<unknown>

export type FeatureToolHandler = (
  args: Record<string, unknown>
) => ToolResult | Promise<ToolResult>

/**
 * activate 收到的上下文。窗口/调用者/画布都可能随窗口重建而变，所以是 getter，
 * 插件不要在 activate 时把值缓存下来。
 */
export interface FeatureContext {
  win: () => BrowserWindow | null
  log: (message: string) => void
  caller: () => string
  openCanvasTab: () => WebContents | null
  assets?: FeatureAssets
  registerCommand: (name: string, handler: FeatureCommandHandler) => void
  registerToolHandler: (name: string, handler: FeatureToolHandler) => void
  setStatus: (status: FeatureStatus | null) => void
}

export interface FeatureActivation {
  /** 禁用插件/窗口关闭时调用；返回的 Promise 会被等待（有超时保护见 deactivateRecord）。 */
  deactivate?: () => unknown
}

export interface BuiltinFeature {
  manifest: FeatureManifest
  activate: (ctx: FeatureContext) => FeatureActivation | void | unknown | Promise<FeatureActivation | void | unknown>
  deactivate?: () => unknown
}

export interface FeatureHostDeps {
  /** cobrowse 数据目录：features/ 子目录与 features.json 都放这里。 */
  dir: string
  win: () => BrowserWindow | null
  log: (message: string) => void
  /** 当前 agent 身份；由调用方在 withCaller 内提供。 */
  caller: () => string
  /** 打开画布标签并返回其 webContents（宿主只负责转发，具体标签由 app 管理）。 */
  openCanvasTab: () => WebContents | null
  assets?: FeatureAssets
  /** 列表/状态变更时通知（app 用它给渲染层发 features:changed）。 */
  onChange?: () => void
}

export interface FeatureToggleResult {
  ok: boolean
  error?: string
  feature?: FeatureInfo
  features: FeatureInfo[]
}

export interface FeatureInstallResult {
  ok: boolean
  error?: string
  feature?: FeatureInfo
  features: FeatureInfo[]
}

export interface FeatureCommandResult {
  ok: boolean
  result?: unknown
  error?: string
}

export interface FeatureToolOwner {
  id: string
  name: string
  enabled: boolean
  active: boolean
}

export interface FeatureHostOptions {
  /** 测试/嵌入时覆盖状态文件路径。 */
  statePath?: string
}

const MAX_MANIFEST_BYTES = 256 * 1024
const MAX_ERRORS = 50
const DEACTIVATE_TIMEOUT_MS = 5000

interface FeatureStateFile {
  version: 1
  enabled: Record<string, boolean>
}

interface FeatureRecord {
  info: FeatureInfo
  builtin?: BuiltinFeature
  module?: unknown
  active: boolean
  commands: Map<string, FeatureCommandHandler>
  tools: Map<string, FeatureToolHandler>
  status: FeatureStatus | null
  deactivate?: () => unknown
  order: number
}

interface ResolvedActivation {
  activate: (ctx: FeatureContext) => unknown
  deactivate?: () => unknown
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function readManifestFile(dir: string): FeatureValidation<FeatureManifest> {
  const file = path.join(dir, 'manifest.json')
  let stat: fs.Stats
  try {
    stat = fs.statSync(file)
  } catch {
    return { ok: false, error: '缺少 manifest.json' }
  }
  if (!stat.isFile()) return { ok: false, error: 'manifest.json 不是文件' }
  if (stat.size > MAX_MANIFEST_BYTES) {
    return { ok: false, error: `manifest.json 过大（上限 ${MAX_MANIFEST_BYTES} 字节）` }
  }
  let raw: string
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (error) {
    return { ok: false, error: `读取 manifest.json 失败：${errorMessage(error)}` }
  }
  return parseFeatureManifestJson(raw)
}

/** 校验外部插件目录（扫描与安装共用；安装时不要求目录名等于 id）。 */
export function validateFeatureDir(
  dir: string,
  options: { requireDirMatch?: boolean } = {}
): FeatureValidation<{ manifest: FeatureManifest; indexPath: string }> {
  const manifest = readManifestFile(dir)
  if (!manifest.ok) return manifest
  if (options.requireDirMatch !== false && manifest.value.id !== path.basename(dir)) {
    return {
      ok: false,
      error: `manifest.id（${manifest.value.id}）必须与目录名（${path.basename(dir)}）一致`
    }
  }
  const indexPath = path.join(dir, 'index.mjs')
  try {
    const stat = fs.statSync(indexPath)
    if (!stat.isFile()) return { ok: false, error: 'index.mjs 不是文件' }
  } catch {
    return { ok: false, error: '缺少 index.mjs' }
  }
  return { ok: true, value: { manifest: manifest.value, indexPath } }
}

function resolveModuleActivation(mod: unknown, featureId: string): ResolvedActivation {
  if (typeof mod === 'function') {
    return { activate: mod as (ctx: FeatureContext) => unknown }
  }
  if (!isPlainObject(mod)) {
    throw new Error(`功能 ${featureId} 的 index.mjs 没有可用的导出`)
  }
  const def = mod['default']
  let activate: unknown
  let deactivate: unknown
  let thisArg: unknown = mod
  if (typeof def === 'function') {
    activate = def
    thisArg = undefined
    deactivate = mod['deactivate']
  } else if (isPlainObject(def)) {
    activate = def['activate'] ?? mod['activate']
    deactivate = def['deactivate'] ?? mod['deactivate']
    thisArg = def
  } else {
    activate = mod['activate']
    deactivate = mod['deactivate']
  }
  if (typeof activate !== 'function') {
    throw new Error(`功能 ${featureId} 的 index.mjs 必须导出 activate(ctx) 或 default`)
  }
  const activateFn = activate as (ctx: FeatureContext) => unknown
  const deactivateFn = typeof deactivate === 'function' ? (deactivate as () => unknown) : undefined
  return {
    activate: (ctx) => activateFn.call(thisArg, ctx),
    ...(deactivateFn ? { deactivate: () => deactivateFn.call(thisArg) } : {})
  }
}

/** activate 可以直接返回 cleanup 函数，或返回 `{ deactivate() {} }`。 */
function cleanupFromOutcome(outcome: unknown): (() => unknown) | undefined {
  if (typeof outcome === 'function') return outcome as () => unknown
  if (isPlainObject(outcome) && typeof outcome['deactivate'] === 'function') {
    return outcome['deactivate'] as () => unknown
  }
  return undefined
}

function normalizeStatus(value: unknown): FeatureStatus | null {
  if (value === null || value === undefined) return null
  if (!isPlainObject(value)) return null
  const text = typeof value['text'] === 'string' ? value['text'].trim() : ''
  if (!text) return null
  const status: FeatureStatus = { text: text.slice(0, 240) }
  if (typeof value['detail'] === 'string' && value['detail'].trim()) {
    status.detail = value['detail'].trim().slice(0, 500)
  }
  const tone = value['tone']
  if (tone === 'info' || tone === 'ok' || tone === 'warn' || tone === 'error') {
    status.tone = tone
  }
  if (Array.isArray(value['actions'])) {
    const actions: FeatureStatusAction[] = []
    for (const raw of value['actions'].slice(0, 8)) {
      if (!isPlainObject(raw)) continue
      if (typeof raw['id'] !== 'string' || !raw['id'].trim()) continue
      if (typeof raw['label'] !== 'string' || !raw['label'].trim()) continue
      if (!isFeatureCommand(raw['command'])) continue
      actions.push({
        id: raw['id'].trim().slice(0, 40),
        label: raw['label'].trim().slice(0, 80),
        command: raw['command']
      })
    }
    if (actions.length > 0) status.actions = actions
  }
  return status
}

function isToolResult(value: unknown): value is ToolResult {
  if (!isPlainObject(value) || !Array.isArray(value['content'])) return false
  return value['content'].every((item) => {
    if (!isPlainObject(item)) return false
    if (item['type'] === 'text') return typeof item['text'] === 'string'
    if (item['type'] === 'image') {
      return typeof item['data'] === 'string' && typeof item['mimeType'] === 'string'
    }
    return false
  })
}

function cloneInfo(info: FeatureInfo): FeatureInfo {
  return {
    manifest: info.manifest,
    enabled: info.enabled,
    builtin: info.builtin,
    ...(info.dir ? { dir: info.dir } : {})
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}超时（${ms}ms）`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

export class FeatureHost {
  private readonly deps: FeatureHostDeps
  private readonly statePath: string
  private readonly featuresRoot: string
  private readonly records = new Map<string, FeatureRecord>()
  private readonly persisted = new Map<string, boolean>()
  private readonly errors: string[] = []
  private nextOrder = 1
  private scanned = false
  private loading = false
  private stopPromise: Promise<void> | null = null

  constructor(deps: FeatureHostDeps, options: FeatureHostOptions = {}) {
    this.deps = deps
    this.statePath = options.statePath ?? path.join(deps.dir, 'features.json')
    this.featuresRoot = path.join(deps.dir, 'features')
    this.loadState()
  }

  /** 注册内置插件。必须在 start() 之前调用（或至少在激活前）。 */
  registerBuiltin(feature: BuiltinFeature): FeatureInfo {
    const checked = validateFeatureManifest(feature.manifest)
    if (!checked.ok) {
      throw new Error(`内置插件 manifest 无效：${checked.error}`)
    }
    const manifest = checked.value
    if (this.records.has(manifest.id)) {
      throw new Error(`功能 id 已被占用：${manifest.id}`)
    }
    const enabled = this.persisted.has(manifest.id) ? this.persisted.get(manifest.id) === true : true
    const record: FeatureRecord = {
      info: { manifest, enabled, builtin: true },
      builtin: feature,
      active: false,
      commands: new Map(),
      tools: new Map(),
      status: null,
      order: this.nextOrder++
    }
    this.records.set(manifest.id, record)
    return cloneInfo(record.info)
  }

  /** 加载持久化状态 + 扫描外部目录，然后激活所有已启用的插件。可重复调用（窗口重建）。 */
  async start(): Promise<void> {
    // 窗口刚关就重新 activate 时，先等上一轮停用清理完，否则会重复注册 IPC。
    if (this.stopPromise) await this.stopPromise
    if (this.loading) return
    this.loading = true
    try {
      if (!this.scanned) {
        this.scanned = true
        this.scanExternal()
      }
      for (const record of this.sortedRecords()) {
        if (!record.info.enabled || record.active) continue
        try {
          await this.activateRecord(record)
        } catch (error) {
          this.addError(`功能 ${record.info.manifest.id} 启动失败：${errorMessage(error)}`)
          this.deps.log(`[feature] ${record.info.manifest.id} 启动失败：${errorMessage(error)}`)
          // 启动失败不保留"已启用"假象：写成禁用，用户可在设置里重试。
          record.info.enabled = false
          this.persisted.set(record.info.manifest.id, false)
          this.saveState()
        }
      }
      this.notify()
    } finally {
      this.loading = false
    }
  }

  list(): FeatureInfo[] {
    return this.sortedRecords().map((record) => cloneInfo(record.info))
  }

  /** 最近的扫描/启动/安装错误（设置页用来解释"为什么没出现"）。 */
  errorList(): string[] {
    return [...this.errors]
  }

  /** 只返回已启用、active、声明 statusCard 且有状态的插件。 */
  statuses(): FeatureStatusEntry[] {
    const out: FeatureStatusEntry[] = []
    for (const record of this.sortedRecords()) {
      if (!record.info.enabled || !record.active) continue
      if (!record.info.manifest.contributes.statusCard) continue
      if (!record.status) continue
      out.push({
        id: record.info.manifest.id,
        name: record.info.manifest.name,
        status: { ...record.status, ...(record.status.actions ? { actions: [...record.status.actions] } : {}) }
      })
    }
    return out
  }

  /** 内置 agent 的 tools schema 用它过滤：声明了该工具但被禁用的插件 → false。 */
  isToolAvailable(name: string): boolean {
    const owners = [...this.records.values()].filter((record) =>
      record.info.manifest.contributes.tools?.includes(name)
    )
    if (owners.length === 0) return true
    return owners.some((record) => record.info.enabled && record.active)
  }

  /** 工具路由前用：知道工具归谁、是否 active，才能给出"插件已禁用"而不是"unknown tool"。 */
  resolveToolOwner(name: string): FeatureToolOwner | null {
    for (const record of this.sortedRecords()) {
      const declared = record.info.manifest.contributes.tools?.includes(name) ?? false
      if (!declared && !record.tools.has(name)) continue
      return {
        id: record.info.manifest.id,
        name: record.info.manifest.name,
        enabled: record.info.enabled,
        active: record.active
      }
    }
    return null
  }

  /** agent 工具入口。工具不存在/插件未启用/结果形状非法都返回 isError 的 ToolResult。 */
  async runTool(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    // 先找已注册处理器（active），再回落到 manifest 声明：
    // 这样被禁用插件的工具会得到"已禁用"，而不是含混的"未知工具"。
    const record =
      [...this.records.values()].find((candidate) => candidate.tools.has(name)) ??
      [...this.records.values()].find((candidate) =>
        candidate.info.manifest.contributes.tools?.includes(name)
      )
    if (!record) {
      return toolError(`未知功能工具：${name}`)
    }
    if (!record.info.enabled || !record.active) {
      return toolError(`功能「${record.info.manifest.name}」已禁用或未激活，工具 ${name} 不可用。请在设置 → 功能插件中启用。`)
    }
    if (!record.tools.has(name)) {
      return toolError(`功能「${record.info.manifest.name}」没有注册工具 ${name}`)
    }
    try {
      const result = await record.tools.get(name)!(args ?? {})
      if (!isToolResult(result)) {
        return toolError(`功能「${record.info.manifest.name}」的工具 ${name} 返回了非法结果`)
      }
      return result
    } catch (error) {
      return toolError(`功能「${record.info.manifest.name}」的工具 ${name} 执行失败：${errorMessage(error)}`)
    }
  }

  /**
   * 调用插件命令。`featureId` 可选：命令名全局唯一，省略时按注册表查找；
   * 指定后可给出更准确的"未启用/命令不存在"错误。
   */
  async invokeCommand(
    command: string,
    args: Record<string, unknown> = {},
    featureId?: string
  ): Promise<FeatureCommandResult> {
    if (!isFeatureCommand(command)) {
      return { ok: false, error: `命令名无效：${String(command)}` }
    }
    let record: FeatureRecord | undefined
    if (featureId) {
      record = this.records.get(featureId)
      if (!record) return { ok: false, error: `功能不存在：${featureId}` }
      if (!record.info.enabled || !record.active) {
        return { ok: false, error: `功能「${record.info.manifest.name}」未启用` }
      }
      if (!record.commands.has(command)) {
        return { ok: false, error: `功能「${record.info.manifest.name}」没有注册命令 ${command}` }
      }
    } else {
      record = [...this.records.values()].find((candidate) => candidate.commands.has(command))
      if (!record) return { ok: false, error: `未知功能命令：${command}` }
    }
    try {
      const result = await record.commands.get(command)!(args ?? {})
      return { ok: true, result }
    } catch (error) {
      return { ok: false, error: `命令 ${command} 执行失败：${errorMessage(error)}` }
    }
  }

  /** 启用/禁用并持久化。启用失败（模块导入/activate 抛错）会回滚到禁用。 */
  async setEnabled(id: string, enabled: boolean): Promise<FeatureToggleResult> {
    const record = this.records.get(id)
    if (!record) {
      return { ok: false, error: `功能不存在：${id}`, features: this.list() }
    }
    const target = enabled === true
    if (record.info.enabled !== target) {
      if (target) {
        try {
          await this.activateRecord(record)
        } catch (error) {
          const message = `启用失败：${errorMessage(error)}`
          this.addError(`功能 ${id} ${message}`)
          return { ok: false, error: message, features: this.list() }
        }
        record.info.enabled = true
      } else {
        record.info.enabled = false
        await this.deactivateRecord(record)
      }
      this.persisted.set(id, target)
      this.saveState()
      this.deps.log(`[feature] ${id} ${target ? '已启用' : '已禁用'}`)
      this.notify()
    }
    return { ok: true, feature: cloneInfo(record.info), features: this.list() }
  }

  /**
   * 从本地目录安装外部插件：校验 → 复制到 features/<id>/ → 启用。
   * 任一步失败都会清掉半成品目录，不会留下"看起来装好了但打不开"的状态。
   */
  async installFolder(sourceDir: string): Promise<FeatureInstallResult> {
    const features = (): FeatureInfo[] => this.list()
    let source: string
    try {
      source = path.resolve(String(sourceDir))
      const lstat = fs.lstatSync(source)
      if (lstat.isSymbolicLink()) {
        return { ok: false, error: '安装目录不能是符号链接', features: features() }
      }
      if (!lstat.isDirectory()) {
        return { ok: false, error: '选择的路径不是目录', features: features() }
      }
    } catch (error) {
      return { ok: false, error: `安装目录不可用：${errorMessage(error)}`, features: features() }
    }
    if (isInside(this.featuresRoot, source)) {
      return { ok: false, error: '安装目录不能位于功能插件目录内', features: features() }
    }

    const checked = validateFeatureDir(source, { requireDirMatch: false })
    if (!checked.ok) {
      return { ok: false, error: checked.error, features: features() }
    }
    const { manifest } = checked.value
    if (this.records.has(manifest.id)) {
      return { ok: false, error: `功能 ${manifest.id} 已安装`, features: features() }
    }
    const target = path.join(this.featuresRoot, manifest.id)
    if (fs.existsSync(target)) {
      return { ok: false, error: `目标目录已存在：${target}`, features: features() }
    }

    try {
      fs.mkdirSync(this.featuresRoot, { recursive: true })
      fs.cpSync(source, target, {
        recursive: true,
        force: false,
        errorOnExist: true,
        dereference: true
      })
    } catch (error) {
      this.removeDirQuietly(target)
      return { ok: false, error: `复制插件目录失败：${errorMessage(error)}`, features: features() }
    }

    // 复制后再校验一次：避免复制过程（磁盘错误/并发改动）留下损坏目录。
    const copied = validateFeatureDir(target)
    if (!copied.ok) {
      this.removeDirQuietly(target)
      return { ok: false, error: `安装后校验失败：${copied.error}`, features: features() }
    }
    const record: FeatureRecord = {
      info: {
        manifest: copied.value.manifest,
        enabled: true,
        builtin: false,
        dir: target
      },
      active: false,
      commands: new Map(),
      tools: new Map(),
      status: null,
      order: this.nextOrder++
    }
    try {
      await this.activateRecord(record)
    } catch (error) {
      this.removeDirQuietly(target)
      const message = `插件加载失败：${errorMessage(error)}`
      this.addError(`功能 ${manifest.id} ${message}`)
      return { ok: false, error: message, features: features() }
    }
    this.records.set(manifest.id, record)
    this.persisted.set(manifest.id, true)
    this.saveState()
    this.deps.log(`[feature] 已安装并启用 ${manifest.id}（${target}）`)
    this.notify()
    return { ok: true, feature: cloneInfo(record.info), features: features() }
  }

  /** 窗口关闭/macOS 休眠时停掉所有插件；start() 可重新激活。 */
  async deactivateAll(): Promise<void> {
    if (this.stopPromise) return this.stopPromise
    this.stopPromise = (async () => {
      for (const record of this.sortedRecords()) {
        if (record.active) await this.deactivateRecord(record)
      }
      this.notify()
    })().finally(() => {
      this.stopPromise = null
    })
    await this.stopPromise
  }

  /** 工具名 → 处理器注册表大小（测试/诊断用）。 */
  activeToolNames(): string[] {
    const names: string[] = []
    for (const record of this.records.values()) {
      if (!record.info.enabled || !record.active) continue
      names.push(...record.tools.keys())
    }
    return names
  }

  private sortedRecords(): FeatureRecord[] {
    return [...this.records.values()].sort((a, b) => {
      if (a.info.builtin !== b.info.builtin) return a.info.builtin ? -1 : 1
      if (a.order !== b.order) return a.order - b.order
      return a.info.manifest.id.localeCompare(b.info.manifest.id)
    })
  }

  private loadState(): void {
    let raw: string
    try {
      raw = fs.readFileSync(this.statePath, 'utf8')
    } catch {
      return
    }
    try {
      const parsed = JSON.parse(raw) as Partial<FeatureStateFile>
      const enabled = parsed?.enabled
      if (isPlainObject(enabled)) {
        for (const [id, value] of Object.entries(enabled)) {
          if (typeof value === 'boolean') this.persisted.set(id, value)
        }
      }
    } catch (error) {
      this.addError(`features.json 不是合法 JSON：${errorMessage(error)}`)
    }
  }

  private saveState(): void {
    const data: FeatureStateFile = {
      version: 1,
      enabled: Object.fromEntries(this.persisted)
    }
    try {
      writeFileAtomic(this.statePath, JSON.stringify(data, null, 2), { mode: 0o600 })
    } catch (error) {
      const message = `写入 features.json 失败：${errorMessage(error)}`
      this.addError(message)
      this.deps.log(`[feature] ${message}`)
    }
  }

  private scanExternal(): void {
    let entries: fs.Dirent[]
    try {
      fs.mkdirSync(this.featuresRoot, { recursive: true })
      entries = fs.readdirSync(this.featuresRoot, { withFileTypes: true })
    } catch (error) {
      this.addError(`扫描功能插件目录失败：${errorMessage(error)}`)
      return
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      if (!entry.isDirectory()) continue
      if (!FEATURE_ID_PATTERN.test(entry.name) || entry.name.includes('--') || entry.name.endsWith('-')) {
        this.addError(`跳过非法功能目录名：${entry.name}`)
        continue
      }
      if (this.records.has(entry.name)) {
        this.addError(`外部插件 ${entry.name} 与内置插件 id 冲突，已跳过`)
        continue
      }
      const dir = path.join(this.featuresRoot, entry.name)
      const checked = validateFeatureDir(dir, { requireDirMatch: true })
      if (!checked.ok) {
        this.addError(`跳过功能目录 features/${entry.name}：${checked.error}`)
        continue
      }
      const enabled = this.persisted.get(entry.name) === true
      this.records.set(entry.name, {
        info: { manifest: checked.value.manifest, enabled, builtin: false, dir },
        active: false,
        commands: new Map(),
        tools: new Map(),
        status: null,
        order: this.nextOrder++
      })
      this.deps.log(`[feature] 发现外部插件 ${entry.name} v${checked.value.manifest.version}（${enabled ? '已启用' : '未启用'}）`)
    }
  }

  private async loadModule(record: FeatureRecord): Promise<unknown> {
    if (record.module) return record.module
    const dir = record.info.dir
    if (!dir) throw new Error('内部错误：外部插件缺少安装目录')
    const indexPath = path.join(dir, 'index.mjs')
    const mod = await import(pathToFileURL(indexPath).href)
    record.module = mod
    return mod
  }

  private makeContext(record: FeatureRecord): FeatureContext {
    const id = record.info.manifest.id
    return {
      win: () => this.deps.win(),
      log: (message) => this.deps.log(`[feature:${id}] ${message}`),
      caller: () => this.deps.caller(),
      openCanvasTab: () => this.deps.openCanvasTab(),
      ...(this.deps.assets ? { assets: this.deps.assets } : {}),
      registerCommand: (name, handler) => {
        if (!isFeatureCommand(name)) throw new Error(`命令名无效：${String(name)}`)
        if (typeof handler !== 'function') throw new Error(`命令 ${name} 的处理器必须是函数`)
        if (record.commands.has(name)) throw new Error(`命令重复注册：${name}`)
        for (const other of this.records.values()) {
          if (other !== record && other.commands.has(name)) {
            throw new Error(`命令 ${name} 已被功能 ${other.info.manifest.id} 占用`)
          }
        }
        record.commands.set(name, handler)
      },
      registerToolHandler: (name, handler) => {
        if (!isFeatureToolName(name)) throw new Error(`工具名无效：${String(name)}`)
        if (typeof handler !== 'function') throw new Error(`工具 ${name} 的处理器必须是函数`)
        const declared = record.info.manifest.contributes.tools
        if (!declared || !declared.includes(name)) {
          throw new Error(`工具 ${name} 未在 manifest.contributes.tools 中声明`)
        }
        if (record.tools.has(name)) throw new Error(`工具重复注册：${name}`)
        for (const other of this.records.values()) {
          if (other !== record && other.tools.has(name)) {
            throw new Error(`工具 ${name} 已被功能 ${other.info.manifest.id} 占用`)
          }
        }
        record.tools.set(name, handler)
      },
      setStatus: (status) => {
        const normalized = normalizeStatus(status)
        if (status !== null && status !== undefined && !normalized) {
          this.deps.log(`[feature:${id}] 忽略非法状态卡数据`)
          return
        }
        record.status = normalized
        this.notify()
      }
    }
  }

  private async activateRecord(record: FeatureRecord): Promise<void> {
    const manifest = record.info.manifest
    const context = this.makeContext(record)
    let cleanup: (() => unknown) | undefined
    try {
      let activate: (ctx: FeatureContext) => unknown
      if (record.builtin) {
        activate = (ctx) => record.builtin!.activate(ctx)
        cleanup = record.builtin.deactivate ? () => record.builtin!.deactivate!() : undefined
      } else {
        const mod = await this.loadModule(record)
        const resolved = resolveModuleActivation(mod, manifest.id)
        activate = resolved.activate
        cleanup = resolved.deactivate
      }
      const outcome = await activate(context)
      const outcomeCleanup = cleanupFromOutcome(outcome)
      if (outcomeCleanup) cleanup = outcomeCleanup
      record.deactivate = cleanup
      record.active = true
    } catch (error) {
      record.active = false
      record.commands.clear()
      record.tools.clear()
      record.status = null
      record.deactivate = undefined
      throw error
    }

    for (const item of manifest.contributes.toolbar ?? []) {
      if (!record.commands.has(item.command)) {
        this.addError(`功能 ${manifest.id} 的工具栏按钮「${item.label}」引用了未注册命令 ${item.command}`)
      }
    }
    const declaredTools = manifest.contributes.tools ?? []
    for (const name of declaredTools) {
      if (!record.tools.has(name)) {
        this.deps.log(`[feature] ${manifest.id} 声明了工具 ${name} 但未注册处理器（调用会失败）`)
      }
    }
    this.deps.log(`[feature] ${manifest.id} 已激活（命令 ${record.commands.size}，工具 ${record.tools.size}）`)
    this.notify()
  }

  private async deactivateRecord(record: FeatureRecord): Promise<void> {
    const cleanup = record.deactivate
    // 先切断路由，再 await 清理：清理期间的新调用应明确失败，而不是半可用。
    record.active = false
    record.commands.clear()
    record.tools.clear()
    record.status = null
    record.deactivate = undefined
    if (cleanup) {
      try {
        await withTimeout(
          Promise.resolve().then(() => cleanup()),
          DEACTIVATE_TIMEOUT_MS,
          `功能 ${record.info.manifest.id} 停用`
        )
      } catch (error) {
        const message = `功能 ${record.info.manifest.id} 停用时报错：${errorMessage(error)}`
        this.addError(message)
        this.deps.log(`[feature] ${message}`)
      }
    }
    this.deps.log(`[feature] ${record.info.manifest.id} 已停用`)
    this.notify()
  }

  private notify(): void {
    try {
      this.deps.onChange?.()
    } catch (error) {
      this.deps.log(`[feature] onChange 回调失败：${errorMessage(error)}`)
    }
  }

  private addError(message: string): void {
    this.errors.push(message)
    if (this.errors.length > MAX_ERRORS) this.errors.splice(0, this.errors.length - MAX_ERRORS)
  }

  private removeDirQuietly(dir: string): void {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch (error) {
      this.deps.log(`[feature] 清理目录失败 ${dir}：${errorMessage(error)}`)
    }
  }
}

function toolError(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}
