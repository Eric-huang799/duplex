import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SHORTCUTS,
  SHORTCUT_DEFS,
  bindingConflicts,
  effectiveShortcuts,
  sameShortcut,
  shortcutLabel,
  validateShortcuts
} from '../src/shared/shortcuts'
import { normalizeBinding } from '../src/shared/hotkeys'

describe('SHORTCUT_DEFS / DEFAULT_SHORTCUTS', () => {
  it('covers every action with a Chinese label and a canonical default', () => {
    expect(SHORTCUT_DEFS.length).toBe(16)
    const ids = SHORTCUT_DEFS.map((d) => d.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const def of SHORTCUT_DEFS) {
      expect(def.label.length).toBeGreaterThan(0)
      const binding = DEFAULT_SHORTCUTS[def.id]
      expect(binding).toBeTruthy()
      expect(normalizeBinding(binding)).toBe(binding)
    }
  })

  it('maps the previous hardcoded behaviour', () => {
    expect(DEFAULT_SHORTCUTS.focusAddress).toBe('Ctrl+L')
    expect(DEFAULT_SHORTCUTS.newTab).toBe('Ctrl+T')
    expect(DEFAULT_SHORTCUTS.reopenClosed).toBe('Ctrl+Shift+T')
    expect(DEFAULT_SHORTCUTS.closeTab).toBe('Ctrl+W')
    expect(DEFAULT_SHORTCUTS.reload).toBe('Ctrl+R')
    expect(DEFAULT_SHORTCUTS.bookmark).toBe('Ctrl+D')
    expect(DEFAULT_SHORTCUTS.find).toBe('Ctrl+F')
    expect(DEFAULT_SHORTCUTS.togglePanel).toBe('Ctrl+B')
    expect(DEFAULT_SHORTCUTS.annotationToggle).toBe('Ctrl+Shift+A')
    expect(DEFAULT_SHORTCUTS.nextTab).toBe('Ctrl+Tab')
    expect(DEFAULT_SHORTCUTS.prevTab).toBe('Ctrl+Shift+Tab')
    expect(DEFAULT_SHORTCUTS.zoomIn).toBe('Ctrl+=')
    expect(DEFAULT_SHORTCUTS.zoomOut).toBe('Ctrl+-')
    expect(DEFAULT_SHORTCUTS.zoomReset).toBe('Ctrl+0')
    expect(DEFAULT_SHORTCUTS.back).toBe('Alt+ArrowLeft')
    expect(DEFAULT_SHORTCUTS.forward).toBe('Alt+ArrowRight')
  })
})

describe('effectiveShortcuts', () => {
  it('returns the defaults without overrides', () => {
    expect(effectiveShortcuts()).toEqual(DEFAULT_SHORTCUTS)
    expect(effectiveShortcuts(null)).toEqual(DEFAULT_SHORTCUTS)
    expect(effectiveShortcuts({})).toEqual(DEFAULT_SHORTCUTS)
  })

  it('merges valid overrides and keeps the other defaults', () => {
    const map = effectiveShortcuts({ closeTab: 'ctrl+shift+q' })
    expect(map.closeTab).toBe('Ctrl+Shift+Q')
    expect(map.newTab).toBe(DEFAULT_SHORTCUTS.newTab)
    expect(map.zoomReset).toBe(DEFAULT_SHORTCUTS.zoomReset)
  })

  it('drops unknown actions and unparseable bindings', () => {
    const map = effectiveShortcuts({
      notAnAction: 'Ctrl+Q',
      reload: 'Ctrl+Shift',
      find: ''
    } as Record<string, string>)
    expect(map.reload).toBe(DEFAULT_SHORTCUTS.reload)
    expect(map.find).toBe(DEFAULT_SHORTCUTS.find)
    expect(Object.keys(map)).not.toContain('notAnAction')
  })

  it('treats null as "use the default"', () => {
    const map = effectiveShortcuts({ zoomIn: null, closeTab: undefined })
    expect(map.zoomIn).toBe(DEFAULT_SHORTCUTS.zoomIn)
    expect(map.closeTab).toBe(DEFAULT_SHORTCUTS.closeTab)
  })
})

describe('validateShortcuts', () => {
  const base = (): Record<string, string> => effectiveShortcuts()

  it('accepts the defaults on Windows and macOS', () => {
    expect(validateShortcuts(base(), { platform: 'win32' })).toEqual({ ok: true })
    expect(validateShortcuts(base(), { platform: 'darwin' })).toEqual({ ok: true })
  })

  it('rejects bare printable keys but allows bare F1–F12 / Escape', () => {
    const bare = validateShortcuts({ ...base(), reload: 'R' }, { platform: 'win32' })
    expect(bare.ok).toBe(false)
    if (!bare.ok) expect(bare.error).toContain('刷新')

    expect(validateShortcuts({ ...base(), find: 'F3' }, { platform: 'win32' }).ok).toBe(true)
    expect(validateShortcuts({ ...base(), find: 'Escape' }, { platform: 'win32' }).ok).toBe(true)
  })

  it('rejects system-reserved bindings (F12 / Alt+F4 / Win key off macOS)', () => {
    const f12 = validateShortcuts({ ...base(), find: 'F12' }, { platform: 'win32' })
    expect(f12.ok).toBe(false)
    if (!f12.ok) expect(f12.error).toContain('F12')

    const altF4 = validateShortcuts({ ...base(), find: 'Alt+F4' }, { platform: 'win32' })
    expect(altF4.ok).toBe(false)
    if (!altF4.ok) expect(altF4.error).toContain('Alt+F4')

    const win = validateShortcuts({ ...base(), find: 'Meta+K' }, { platform: 'win32' })
    expect(win.ok).toBe(false)
    if (!win.ok) expect(win.error).toContain('页内查找')
  })

  it('rejects duplicates between two actions and names both labels', () => {
    const r = validateShortcuts(
      { ...base(), zoomIn: DEFAULT_SHORTCUTS.zoomOut },
      { platform: 'win32' }
    )
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toContain('放大')
      expect(r.error).toContain('缩小')
    }
  })

  it('rejects conflicts with the emergency-stop keys', () => {
    const r = validateShortcuts(
      { ...base(), find: 'F2' },
      { platform: 'win32', emergencyKeys: ['F2'] }
    )
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toContain('页内查找')
      expect(r.error).toContain('急停')
    }
  })

  it('rejects Ctrl/Cmd+1–9 (reserved for fixed tab switching)', () => {
    const r = validateShortcuts({ ...base(), find: 'Ctrl+1' }, { platform: 'win32' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('页内查找')
  })

  it('skips the action named by ignoreAction', () => {
    const r = validateShortcuts({ ...base(), reload: 'R' }, { ignoreAction: 'reload' })
    expect(r.ok).toBe(true)
  })

  it('treats Ctrl and Cmd as the same shortcut on macOS', () => {
    const r = validateShortcuts({ ...base(), newTab: 'Meta+L' }, { platform: 'darwin' })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toContain('聚焦地址栏')
      expect(r.error).toContain('新建标签页')
    }
  })
})

describe('bindingConflicts / sameShortcut / shortcutLabel', () => {
  it('finds the action already using a binding', () => {
    const conflict = bindingConflicts('ctrl+w', effectiveShortcuts(), { platform: 'win32' })
    expect(conflict?.action).toBe('closeTab')
    expect(conflict?.label).toBe('关闭标签页')
    expect(conflict?.binding).toBe('Ctrl+W')
  })

  it('returns null when the binding is free', () => {
    expect(bindingConflicts('F2', effectiveShortcuts(), { platform: 'win32' })).toBeNull()
    expect(bindingConflicts('not a binding', effectiveShortcuts())).toBeNull()
  })

  it('applies the macOS Ctrl/Cmd equivalence', () => {
    expect(sameShortcut('Ctrl+L', 'Meta+L', 'darwin')).toBe(true)
    expect(sameShortcut('Ctrl+L', 'Meta+L', 'win32')).toBe(false)
    expect(
      bindingConflicts('Meta+L', effectiveShortcuts(), { platform: 'darwin' })?.action
    ).toBe('focusAddress')
  })

  it('resolves Chinese labels by action id', () => {
    expect(shortcutLabel('closeTab')).toBe('关闭标签页')
    expect(shortcutLabel('focusAddress')).toBe('聚焦地址栏')
  })
})
