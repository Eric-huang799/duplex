import { describe, expect, it } from 'vitest'
import { isAiPaused, markAiActive, pauseAi, resumeAi } from '../src/main/overlay'

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
