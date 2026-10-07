/** Shared hotkey parsing/matching for emergency-stop keys (e.g. "F2", "Ctrl+Shift+K"). */

export interface KeyEventLike {
  key: string
  ctrlKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
  metaKey?: boolean
}

export interface ParsedBinding {
  ctrl: boolean
  alt: boolean
  shift: boolean
  meta: boolean
  key: string
}

const MOD_ALIAS: Record<string, 'ctrl' | 'alt' | 'shift' | 'meta'> = {
  ctrl: 'ctrl',
  control: 'ctrl',
  alt: 'alt',
  option: 'alt',
  shift: 'shift',
  meta: 'meta',
  win: 'meta',
  windows: 'meta',
  cmd: 'meta',
  command: 'meta'
}

const CANONICAL_NAMES = [
  'Escape',
  'Tab',
  'Enter',
  'Backspace',
  'Delete',
  'Insert',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Space',
  'CapsLock',
  'Control',
  'Alt',
  'Shift',
  'Meta'
]

/** Browser shortcuts already handled by the app; binding them as emergency keys would fight. */
export const BUILTIN_SHORTCUTS = [
  'Ctrl+L',
  'Ctrl+T',
  'Ctrl+Shift+T',
  'Ctrl+W',
  'Ctrl+R',
  'Ctrl+D',
  'Ctrl+F',
  'Ctrl+B',
  'Ctrl+Shift+A',
  'Ctrl+Tab',
  'Ctrl+Shift+Tab',
  'F12'
]

export function isModifierKey(key: string): boolean {
  return ['Control', 'Alt', 'Shift', 'Meta'].includes(key)
}

export function normalizeKeyName(key: string): string {
  if (key === ' ' || key === 'Spacebar') return 'Space'
  for (const name of CANONICAL_NAMES) {
    if (name.toLowerCase() === key.toLowerCase()) return name
  }
  const fkey = /^f(\d{1,2})$/i.exec(key)
  if (fkey) return `F${Number(fkey[1])}`
  if (key.length === 1) return key.toUpperCase()
  return key
}

export function buildCombo(
  mods: { ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean },
  key: string
): string {
  const parts: string[] = []
  if (mods.ctrl) parts.push('Ctrl')
  if (mods.alt) parts.push('Alt')
  if (mods.shift) parts.push('Shift')
  if (mods.meta) parts.push('Meta')
  parts.push(normalizeKeyName(key))
  return parts.join('+')
}

export function comboFromEvent(e: KeyEventLike): string | null {
  if (!e.key || isModifierKey(e.key)) return null
  return buildCombo(
    { ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey },
    e.key
  )
}

export function parseBinding(binding: string): ParsedBinding | null {
  const raw = binding.trim()
  if (!raw) return null
  const segments = raw.split('+').map((s) => s.trim()).filter(Boolean)
  if (segments.length === 0) return null
  const parsed: ParsedBinding = { ctrl: false, alt: false, shift: false, meta: false, key: '' }
  for (const seg of segments) {
    const mod = MOD_ALIAS[seg.toLowerCase()]
    if (mod) {
      parsed[mod] = true
      continue
    }
    if (parsed.key) return null
    parsed.key = normalizeKeyName(seg)
  }
  if (!parsed.key || isModifierKey(parsed.key)) return null
  return parsed
}

export function normalizeBinding(binding: string): string | null {
  const p = parseBinding(binding)
  if (!p) return null
  return buildCombo(p, p.key)
}

export function sameBinding(a: string, b: string): boolean {
  const na = normalizeBinding(a)
  const nb = normalizeBinding(b)
  return !!na && !!nb && na === nb
}

export function matchesBinding(binding: string, e: KeyEventLike): boolean {
  const p = parseBinding(binding)
  if (!p) return false
  const key = e.key ? normalizeKeyName(e.key) : ''
  if (key !== p.key) return false
  return (
    !!e.ctrlKey === p.ctrl &&
    !!e.altKey === p.alt &&
    !!e.shiftKey === p.shift &&
    !!e.metaKey === p.meta
  )
}

export function validateBinding(
  binding: string
): { ok: true; combo: string } | { ok: false; reason: string } {
  const p = parseBinding(binding)
  if (!p) return { ok: false, reason: '无法识别的按键' }
  const combo = buildCombo(p, p.key)
  if (p.meta) {
    return { ok: false, reason: 'Win 键组合会被系统占用，无法用作急停键' }
  }
  if (combo === 'Alt+F4') {
    return { ok: false, reason: 'Alt+F4 是系统保留按键（会直接关闭窗口）' }
  }
  if (BUILTIN_SHORTCUTS.some((b) => sameBinding(b, combo))) {
    return { ok: false, reason: `与浏览器快捷键 ${combo} 冲突` }
  }
  const hasMod = p.ctrl || p.alt || p.shift || p.meta
  const bareAllowed = /^F\d{1,2}$/.test(p.key) || p.key === 'Escape'
  if (!hasMod && !bareAllowed) {
    return { ok: false, reason: '请配合 Ctrl / Alt / Shift 使用（F1–F12、Esc 可单用）' }
  }
  return { ok: true, combo }
}

const DISPLAY_KEY: Record<string, string> = {
  Escape: 'Esc',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  PageUp: 'PgUp',
  PageDown: 'PgDn',
  Backspace: '⌫',
  Delete: 'Del',
  Enter: 'Enter',
  Space: '空格',
  CapsLock: 'Caps',
  Meta: 'Win'
}

export function displayParts(binding: string): string[] {
  const p = parseBinding(binding)
  if (!p) return [binding]
  const parts: string[] = []
  if (p.ctrl) parts.push('Ctrl')
  if (p.alt) parts.push('Alt')
  if (p.shift) parts.push('Shift')
  if (p.meta) parts.push('Win')
  parts.push(DISPLAY_KEY[p.key] ?? p.key)
  return parts
}
