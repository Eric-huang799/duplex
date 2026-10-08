import { describe, expect, it } from 'vitest'
import {
  buildCombo,
  comboFromEvent,
  displayParts,
  isModifierKey,
  matchesBinding,
  normalizeBinding,
  normalizeKeyName,
  parseBinding,
  sameBinding,
  validateBinding
} from '../src/shared/hotkeys'

describe('normalizeKeyName', () => {
  it('canonicalizes letters and function keys', () => {
    expect(normalizeKeyName('k')).toBe('K')
    expect(normalizeKeyName('f2')).toBe('F2')
    expect(normalizeKeyName('escape')).toBe('Escape')
    expect(normalizeKeyName(' ')).toBe('Space')
  })
})

describe('parseBinding / normalizeBinding', () => {
  it('parses combos case-insensitively and canonicalizes order', () => {
    expect(parseBinding('ctrl+shift+k')).toEqual({ ctrl: true, alt: false, shift: true, meta: false, key: 'K' })
    expect(normalizeBinding('shift+ctrl+k')).toBe('Ctrl+Shift+K')
    expect(normalizeBinding('F2')).toBe('F2')
    expect(normalizeBinding('escape')).toBe('Escape')
  })

  it('rejects garbage and modifier-only bindings', () => {
    expect(parseBinding('ctrl+shift')).toBeNull()
    expect(parseBinding('')).toBeNull()
    expect(parseBinding('a+b+c')).toBeNull()
  })
})

describe('comboFromEvent / matchesBinding', () => {
  it('builds a canonical combo from an event', () => {
    expect(comboFromEvent({ key: 'k', ctrlKey: true, shiftKey: true })).toBe('Ctrl+Shift+K')
    expect(comboFromEvent({ key: 'Control' })).toBeNull()
  })

  it('matches exactly, including modifier set', () => {
    expect(matchesBinding('Ctrl+Shift+K', { key: 'K', ctrlKey: true, shiftKey: true })).toBe(true)
    expect(matchesBinding('Ctrl+Shift+K', { key: 'K', ctrlKey: true })).toBe(false)
    expect(matchesBinding('F2', { key: 'F2' })).toBe(true)
    expect(matchesBinding('F2', { key: 'F2', ctrlKey: true })).toBe(false)
    expect(matchesBinding('Escape', { key: 'Escape' })).toBe(true)
    expect(matchesBinding('Escape', { key: 'Escape', ctrlKey: true })).toBe(false)
  })

  it('sameBinding compares canonical forms', () => {
    expect(sameBinding('shift+ctrl+k', 'Ctrl+Shift+K')).toBe(true)
    expect(sameBinding('f2', 'F2')).toBe(true)
    expect(sameBinding('F2', 'F3')).toBe(false)
  })

  it('treats Ctrl and Cmd as interchangeable on macOS (platform parameter)', () => {
    expect(matchesBinding('Ctrl+L', { key: 'l', metaKey: true }, 'darwin')).toBe(true)
    expect(matchesBinding('Meta+L', { key: 'l', ctrlKey: true }, 'darwin')).toBe(true)
    expect(matchesBinding('Ctrl+L', { key: 'L', ctrlKey: true }, 'darwin')).toBe(true)
    expect(matchesBinding('Ctrl+L', { key: 'l', ctrlKey: true, shiftKey: true }, 'darwin')).toBe(false)
    // Windows keeps Ctrl and Meta strictly separate
    expect(matchesBinding('Ctrl+L', { key: 'l', metaKey: true }, 'win32')).toBe(false)
    expect(matchesBinding('Ctrl+L', { key: 'l', ctrlKey: true }, 'win32')).toBe(true)
  })
})

describe('validateBinding', () => {
  it('allows combos and bare function keys / Escape', () => {
    expect(validateBinding('Ctrl+Shift+K').ok).toBe(true)
    expect(validateBinding('F2').ok).toBe(true)
    expect(validateBinding('Escape').ok).toBe(true)
  })

  it('rejects bare printable keys and conflicts with built-in shortcuts', () => {
    expect(validateBinding('a').ok).toBe(false)
    expect(validateBinding('Ctrl+W').ok).toBe(false)
    expect(validateBinding('Ctrl+Shift+T').ok).toBe(false)
    expect(validateBinding('F12').ok).toBe(false)
  })

  it('rejects system-reserved bindings', () => {
    expect(validateBinding('Alt+F4', 'win32').ok).toBe(false)
    expect(validateBinding('Meta+K', 'win32').ok).toBe(false)
    // Cmd combinations are legitimate on macOS
    expect(validateBinding('Meta+K', 'darwin').ok).toBe(true)
  })
})

describe('helpers', () => {
  it('isModifierKey', () => {
    expect(isModifierKey('Control')).toBe(true)
    expect(isModifierKey('Control')).toBe(true)
    expect(isModifierKey('k')).toBe(false)
  })

  it('buildCombo / displayParts', () => {
    expect(buildCombo({ alt: true }, 'f4')).toBe('Alt+F4')
    // platform pinned so the expectations are identical on every CI runner
    expect(displayParts('Ctrl+Shift+ArrowUp', 'win32')).toEqual(['Ctrl', 'Shift', '↑'])
    expect(displayParts('Ctrl+Shift+ArrowUp', 'darwin')).toEqual(['⌃', '⇧', '↑'])
    expect(displayParts('Escape')).toEqual(['Esc'])
  })
})
