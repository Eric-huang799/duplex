/**
 * 功能插件（Feature）的共享契约：主进程宿主、preload、渲染层共用。
 *
 * 这里只放**可跨进程序列化**的纯数据结构与校验，不引入 Node/Electron：
 *  - `FeatureManifest` 是插件作者写在 `manifest.json` 里的唯一声明；
 *  - `FeatureInfo` 是宿主在运行时补上 enabled/builtin/dir 后返回给 UI 的视图；
 *  - 校验函数重建对象，只接受白名单字段，避免把外部 JSON 的原型/额外属性带进宿主。
 *
 * 约定：manifest 的 `id` 必须与安装目录名一致（`<cobrowseDir>/features/<id>/`），
 * 否则扫描时会被拒绝——这样"哪个目录属于哪个插件"永远没有歧义。
 */

export interface FeatureToolbarContribution {
  /** 同一插件内唯一；用于 React key / 测试定位。 */
  id: string
  /** 按钮文字（插件声明的展示名，不强制走应用 i18n）。 */
  label: string
  /** 可选图标字符（如 "✦"）；宿主只做字符渲染，不解析图片。 */
  icon?: string
  /** 点击按钮时调用的命令名，由插件在 activate 里 registerCommand。 */
  command: string
}

export interface FeatureContributions {
  /** 顶部工具栏按钮。 */
  toolbar?: FeatureToolbarContribution[]
  /** 本插件向 agent/MCP 提供的工具名；未声明的工具处理器注册会被拒绝。 */
  tools?: string[]
  /** 是否在对话里显示状态卡（数据来自 ctx.setStatus）。 */
  statusCard?: boolean
}

export interface FeatureManifest {
  id: string
  name: string
  version: string
  description: string
  contributes: FeatureContributions
}

export interface FeatureInfo {
  manifest: FeatureManifest
  enabled: boolean
  builtin: boolean
  /** 外部插件的安装目录；内置插件没有。 */
  dir?: string
}

/** 状态卡上的一个动作按钮：调用宿主命令。 */
export interface FeatureStatusAction {
  id: string
  label: string
  command: string
}

/** 插件通过 ctx.setStatus 发布的运行时状态（对话内状态卡的数据源）。 */
export interface FeatureStatus {
  text: string
  detail?: string
  tone?: 'info' | 'ok' | 'warn' | 'error'
  actions?: FeatureStatusAction[]
}

/** `features:status` 的一行；只包含已启用、active 且声明 statusCard 的插件。 */
export interface FeatureStatusEntry {
  id: string
  name: string
  status: FeatureStatus
}

export type FeatureValidation<T> =
  | { ok: true; value: T }
  | { ok: false; error: string }

export const FEATURE_ID_PATTERN = /^[a-z][a-z0-9-]{0,39}$/
export const FEATURE_TOOLBAR_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/
export const FEATURE_TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/
export const FEATURE_COMMAND_PATTERN = /^[a-z][a-z0-9]*(?:[.:-][a-z0-9]+){0,15}$/
export const FEATURE_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/

const MAX_NAME = 80
const MAX_DESCRIPTION = 500
const MAX_TOOLBAR = 8
const MAX_TOOLS = 64
const MAX_ICON = 16
const MAX_COMMAND = 128

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fail<T>(error: string): FeatureValidation<T> {
  return { ok: false, error }
}

/** 功能 id 还要求不能以 '-' 结尾（正则已允许）且不能出现 '--'。 */
export function isFeatureId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    FEATURE_ID_PATTERN.test(value) &&
    !value.includes('--') &&
    !value.endsWith('-')
  )
}

/** 工具栏/命令/工具名的基础约束（外部插件也必须遵守）。 */
export function isFeatureToolbarId(value: unknown): value is string {
  return typeof value === 'string' && FEATURE_TOOLBAR_ID_PATTERN.test(value)
}

export function isFeatureToolName(value: unknown): value is string {
  return typeof value === 'string' && FEATURE_TOOL_NAME_PATTERN.test(value)
}

export function isFeatureCommand(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= MAX_COMMAND &&
    FEATURE_COMMAND_PATTERN.test(value)
  )
}

function optionalString(value: unknown, field: string, max: number): FeatureValidation<string | undefined> {
  if (value === undefined || value === null) return { ok: true, value: undefined }
  if (typeof value !== 'string') return fail(`${field} 必须是字符串`)
  const trimmed = value.trim()
  if (!trimmed) return fail(`${field} 不能为空`)
  if (trimmed.length > max) return fail(`${field} 超过 ${max} 个字符`)
  return { ok: true, value: trimmed }
}

function validateToolbar(value: unknown): FeatureValidation<FeatureToolbarContribution[]> {
  if (!Array.isArray(value)) return fail('contributes.toolbar 必须是数组')
  if (value.length > MAX_TOOLBAR) return fail(`contributes.toolbar 最多 ${MAX_TOOLBAR} 项`)
  const out: FeatureToolbarContribution[] = []
  const seen = new Set<string>()
  for (let i = 0; i < value.length; i++) {
    const raw = value[i]
    const where = `contributes.toolbar[${i}]`
    if (!isPlainObject(raw)) return fail(`${where} 必须是对象`)
    if (!isFeatureToolbarId(raw['id'])) return fail(`${where}.id 无效`)
    if (seen.has(raw['id'])) return fail(`${where}.id 重复：${raw['id']}`)
    seen.add(raw['id'])
    if (typeof raw['label'] !== 'string') return fail(`${where}.label 必须是字符串`)
    const label = raw['label'].trim()
    if (!label) return fail(`${where}.label 不能为空`)
    if (label.length > MAX_NAME) return fail(`${where}.label 超过 ${MAX_NAME} 个字符`)
    if (!isFeatureCommand(raw['command'])) return fail(`${where}.command 无效`)
    const icon = optionalString(raw['icon'], `${where}.icon`, MAX_ICON)
    if (!icon.ok) return fail(icon.error)
    out.push({
      id: raw['id'],
      label,
      command: raw['command'],
      ...(icon.value ? { icon: icon.value } : {})
    })
  }
  return { ok: true, value: out }
}

function validateTools(value: unknown): FeatureValidation<string[]> {
  if (!Array.isArray(value)) return fail('contributes.tools 必须是数组')
  if (value.length > MAX_TOOLS) return fail(`contributes.tools 最多 ${MAX_TOOLS} 项`)
  const out: string[] = []
  const seen = new Set<string>()
  for (let i = 0; i < value.length; i++) {
    const name = value[i]
    if (!isFeatureToolName(name)) return fail(`contributes.tools[${i}] 无效`)
    if (seen.has(name)) return fail(`contributes.tools 重复：${name}`)
    seen.add(name)
    out.push(name)
  }
  return { ok: true, value: out }
}

/**
 * 校验 manifest（未知字段会被忽略，已知字段逐项检查并重建）。
 * 这是扫描/安装/内置注册共同的入口：任何非法 manifest 都不会进入宿主的注册表。
 */
export function validateFeatureManifest(value: unknown): FeatureValidation<FeatureManifest> {
  if (!isPlainObject(value)) return fail('manifest 必须是对象')

  if (!isFeatureId(value['id'])) {
    return fail('id 无效：需为小写字母开头、仅含小写字母/数字/连字符，且不超过 40 字符')
  }
  const id = value['id']

  if (typeof value['name'] !== 'string') return fail('name 必须是字符串')
  const name = value['name'].trim()
  if (!name) return fail('name 不能为空')
  if (name.length > MAX_NAME) return fail(`name 超过 ${MAX_NAME} 个字符`)

  if (typeof value['version'] !== 'string' || !FEATURE_VERSION_PATTERN.test(value['version'])) {
    return fail('version 必须是形如 1.0.0 的语义化版本')
  }
  const version = value['version']

  if (typeof value['description'] !== 'string') return fail('description 必须是字符串')
  const description = value['description'].trim()
  if (!description) return fail('description 不能为空')
  if (description.length > MAX_DESCRIPTION) {
    return fail(`description 超过 ${MAX_DESCRIPTION} 个字符`)
  }

  const contributesRaw = value['contributes']
  if (!isPlainObject(contributesRaw)) return fail('contributes 必须是对象')

  const contributes: FeatureContributions = {}
  if (contributesRaw['toolbar'] !== undefined) {
    const toolbar = validateToolbar(contributesRaw['toolbar'])
    if (!toolbar.ok) return fail(toolbar.error)
    contributes.toolbar = toolbar.value
  }
  if (contributesRaw['tools'] !== undefined) {
    const tools = validateTools(contributesRaw['tools'])
    if (!tools.ok) return fail(tools.error)
    contributes.tools = tools.value
  }
  if (contributesRaw['statusCard'] !== undefined) {
    if (typeof contributesRaw['statusCard'] !== 'boolean') {
      return fail('contributes.statusCard 必须是布尔值')
    }
    contributes.statusCard = contributesRaw['statusCard']
  }

  return {
    ok: true,
    value: { id, name, version, description, contributes }
  }
}

/** manifest.json 的解析入口：JSON 语法错误与结构错误都变成同一种失败。 */
export function parseFeatureManifestJson(raw: string): FeatureValidation<FeatureManifest> {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return fail(`manifest.json 不是合法 JSON：${(error as Error).message}`)
  }
  return validateFeatureManifest(parsed)
}
