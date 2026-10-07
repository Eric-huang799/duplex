/**
 * User-customizable browser shortcut definitions and validation.
 * Shared by the main process (tabs/preload event matching, settings, IPC)
 * and the renderer (shortcut settings dialog).
 */
import {
  buildCombo,
  isMacPlatform,
  normalizeBinding,
  parseBinding,
  type ParsedBinding
} from './hotkeys'

export type ShortcutAction =
  | 'focusAddress'
  | 'newTab'
  | 'reopenClosed'
  | 'closeTab'
  | 'reload'
  | 'bookmark'
  | 'find'
  | 'togglePanel'
  | 'annotationToggle'
  | 'nextTab'
  | 'prevTab'
  | 'zoomIn'
  | 'zoomOut'
  | 'zoomReset'
  | 'back'
  | 'forward'

export interface ShortcutDef {
  id: ShortcutAction
  label: string
}

/** Every customizable action, in the order shown in the settings dialog. */
export const SHORTCUT_DEFS: readonly ShortcutDef[] = [
  { id: 'focusAddress', label: '聚焦地址栏' },
  { id: 'newTab', label: '新建标签页' },
  { id: 'reopenClosed', label: '恢复关闭的标签页' },
  { id: 'closeTab', label: '关闭标签页' },
  { id: 'reload', label: '刷新' },
  { id: 'bookmark', label: '添加/移除书签' },
  { id: 'find', label: '页内查找' },
  { id: 'togglePanel', label: '开关 AI 面板' },
  { id: 'annotationToggle', label: '进入/退出标注' },
  { id: 'nextTab', label: '下一个标签页' },
  { id: 'prevTab', label: '上一个标签页' },
  { id: 'zoomIn', label: '放大' },
  { id: 'zoomOut', label: '缩小' },
  { id: 'zoomReset', label: '重置缩放' },
  { id: 'back', label: '后退' },
  { id: 'forward', label: '前进' }
]

export const DEFAULT_SHORTCUTS: Record<ShortcutAction, string> = {
  focusAddress: 'Ctrl+L',
  newTab: 'Ctrl+T',
  reopenClosed: 'Ctrl+Shift+T',
  closeTab: 'Ctrl+W',
  reload: 'Ctrl+R',
  bookmark: 'Ctrl+D',
  find: 'Ctrl+F',
  togglePanel: 'Ctrl+B',
  annotationToggle: 'Ctrl+Shift+A',
  nextTab: 'Ctrl+Tab',
  prevTab: 'Ctrl+Shift+Tab',
  zoomIn: 'Ctrl+=',
  zoomOut: 'Ctrl+-',
  zoomReset: 'Ctrl+0',
  back: 'Alt+ArrowLeft',
  forward: 'Alt+ArrowRight'
}

const ACTION_IDS = new Set<string>(SHORTCUT_DEFS.map((d) => d.id))

export function isShortcutAction(value: string): value is ShortcutAction {
  return ACTION_IDS.has(value)
}

export function shortcutLabel(action: ShortcutAction): string {
  return SHORTCUT_DEFS.find((d) => d.id === action)?.label ?? action
}

/**
 * Merge the defaults with the raw overrides persisted in settings.
 * Unknown actions and bindings that fail normalizeBinding are dropped;
 * null/undefined entries mean "use the default".
 */
export function effectiveShortcuts(
  overrides?: Record<string, string | null | undefined> | null
): Record<ShortcutAction, string> {
  const out: Record<ShortcutAction, string> = { ...DEFAULT_SHORTCUTS }
  if (!overrides) return out
  for (const [action, binding] of Object.entries(overrides)) {
    if (!isShortcutAction(action) || typeof binding !== 'string') continue
    const norm = normalizeBinding(binding)
    if (norm) out[action] = norm
  }
  return out
}

/**
 * All canonical forms a binding also represents on the given platform.
 * On macOS Ctrl and Cmd are interchangeable, so "Ctrl+L" and "Meta+L"
 * describe the same physical shortcut.
 */
function equivalentBindings(binding: string, platform?: string): string[] {
  const norm = normalizeBinding(binding)
  if (!norm) return []
  const forms = new Set<string>([norm])
  if (isMacPlatform(platform)) {
    const p = parseBinding(norm)
    if (p && p.ctrl !== p.meta) {
      forms.add(buildCombo({ ...p, ctrl: p.meta, meta: p.ctrl }, p.key))
    }
  }
  return [...forms]
}

/** True when two bindings would fire on the same physical key combination. */
export function sameShortcut(a: string, b: string, platform?: string): boolean {
  const nb = normalizeBinding(b)
  if (!nb) return false
  return equivalentBindings(a, platform).some((form) => form === nb)
}

/** Ctrl/Cmd+1..9 stay reserved for fixed tab switching. */
function isReservedTabSwitch(p: ParsedBinding): boolean {
  return /^[1-9]$/.test(p.key) && (p.ctrl || p.meta) && !p.alt
}

export interface ShortcutConflict {
  action: ShortcutAction
  label: string
  binding: string
}

export interface ValidateShortcutsOptions {
  platform?: string
  emergencyKeys?: readonly string[]
  ignoreAction?: ShortcutAction
}

export type ShortcutValidation = { ok: true } | { ok: false; error: string }

/**
 * Validate a full effective shortcut map (every action → canonical binding).
 * Checks parseability, forbidden/reserved keys, duplicates between actions and
 * conflicts with the current emergency-stop keys.
 */
export function validateShortcuts(
  map: Record<string, string>,
  opts: ValidateShortcutsOptions = {}
): ShortcutValidation {
  const platform = opts.platform
  const entries: Array<{ def: ShortcutDef; combo: string }> = []
  for (const def of SHORTCUT_DEFS) {
    if (opts.ignoreAction === def.id) continue
    const raw = map[def.id]
    if (typeof raw !== 'string' || !raw.trim()) continue
    const parsed = parseBinding(raw)
    if (!parsed) return { ok: false, error: `「${def.label}」的按键无法识别` }
    const combo = normalizeBinding(raw) ?? raw.trim()
    if (parsed.key === 'F12') {
      return { ok: false, error: `「${def.label}」不能使用 F12（系统保留）` }
    }
    if (combo === 'Alt+F4') {
      return { ok: false, error: `「${def.label}」不能使用 Alt+F4（系统保留）` }
    }
    if (parsed.meta && !isMacPlatform(platform)) {
      return { ok: false, error: `「${def.label}」使用 Win 键组合会被系统占用` }
    }
    const hasMod = parsed.ctrl || parsed.alt || parsed.shift || parsed.meta
    const bareAllowed = /^F([1-9]|1[0-2])$/.test(parsed.key) || parsed.key === 'Escape'
    if (!hasMod && !bareAllowed) {
      return {
        ok: false,
        error: `「${def.label}」需要配合 Ctrl / Alt / Shift 使用（F1–F12、Esc 可单用）`
      }
    }
    if (isReservedTabSwitch(parsed)) {
      return { ok: false, error: `「${def.label}」不能使用 Ctrl+1–9（已保留给标签页切换）` }
    }
    entries.push({ def, combo })
  }
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      if (sameShortcut(entries[i].combo, entries[j].combo, platform)) {
        return {
          ok: false,
          error: `快捷键重复：「${entries[i].def.label}」与「${entries[j].def.label}」都使用了 ${entries[i].combo}`
        }
      }
    }
  }
  for (const key of opts.emergencyKeys ?? []) {
    if (typeof key !== 'string' || !key.trim()) continue
    for (const entry of entries) {
      if (sameShortcut(entry.combo, key, platform)) {
        return {
          ok: false,
          error: `「${entry.def.label}」与急停键 ${normalizeBinding(key) ?? key} 冲突`
        }
      }
    }
  }
  return { ok: true }
}

/**
 * Find an action in `map` already using `binding` (platform-aware).
 * Reused by the emergency-stop key validation in the main process.
 */
export function bindingConflicts(
  binding: string,
  map: Record<string, string>,
  opts: { platform?: string; ignoreAction?: ShortcutAction } = {}
): ShortcutConflict | null {
  const norm = normalizeBinding(binding)
  if (!norm) return null
  for (const def of SHORTCUT_DEFS) {
    if (opts.ignoreAction === def.id) continue
    const other = map[def.id]
    if (typeof other !== 'string' || !other) continue
    if (sameShortcut(norm, other, opts.platform)) {
      return { action: def.id, label: def.label, binding: normalizeBinding(other) ?? other }
    }
  }
  return null
}
