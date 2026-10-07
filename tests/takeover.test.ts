import { describe, expect, it } from 'vitest'
import { formatTakeoverHint, isAiPaused, markAiActive, pauseAi, resumeAi } from '../src/main/overlay'
import { DEFAULT_STOP_KEYS } from '../src/main/settings'

describe('emergency-stop latch ("neutral gear")', () => {
  it('latches on pauseAi and clears on resumeAi', () => {
    resumeAi()
    expect(isAiPaused()).toBe(false)
    expect(pauseAi()).toBe(true)
    expect(isAiPaused()).toBe(true)
    // pausing again while already paused is a no-op
    expect(pauseAi()).toBe(false)
    expect(isAiPaused()).toBe(true)
    expect(resumeAi()).toBe(true)
    expect(isAiPaused()).toBe(false)
    // resuming while not paused is a no-op
    expect(resumeAi()).toBe(false)
  })

  it('AI activity marking alone never pauses', () => {
    resumeAi()
    markAiActive(1000)
    expect(isAiPaused()).toBe(false)
  })

  it('stays paused until an explicit resume', () => {
    resumeAi()
    pauseAi()
    markAiActive(10_000)
    expect(isAiPaused()).toBe(true)
    resumeAi()
    expect(isAiPaused()).toBe(false)
  })
})

describe('takeover hotkeys (Esc is UI-only by default)', () => {
  it('does not bind Esc as a default emergency-stop key', () => {
    // Esc resolves the annotation UI (close card / exit annotation mode);
    // emergency stop is triggered only by the configured hotkeys.
    expect(DEFAULT_STOP_KEYS).not.toContain('Escape')
  })

  it('shows a configured, non-Esc key in the status hint', () => {
    expect(formatTakeoverHint(['F2', 'Ctrl+Shift+K'])).toBe('F2 急停')
    expect(formatTakeoverHint(['Ctrl+Shift+K'])).toBe('Ctrl+Shift+K 急停')
    // Esc can still be bound explicitly — then it is shown as-is
    expect(formatTakeoverHint(['Escape'])).toBe('Esc 急停')
  })

  it('falls back gracefully when no keys are configured', () => {
    expect(formatTakeoverHint([])).toContain('未设置')
  })
})
