import { describe, expect, it } from 'vitest'
import { StartedSessionTracker } from '../src/main/integrations/session-events'
import { buildStartPlan } from '../src/main/integrations/agents'

describe('external CLI startup identity', () => {
  it('reads split JSONL startup records and keeps the original thread identity', () => {
    const tracker = new StartedSessionTracker('codex')
    tracker.feed('unrelated output\n{"type":"thread.started","thread_')
    expect(tracker.sessionId).toBeUndefined()
    tracker.feed('id":"created-thread"}\n{"type":"thread.started","thread_id":"other"}\n')
    expect(tracker.sessionId).toBe('created-thread')
  })
  it('accepts only Claude initialization identity, ignoring other message session fields', () => {
    const tracker = new StartedSessionTracker('claude')
    tracker.feed('{"type":"assistant","session_id":"old"}\n{"type":"system","subtype":"init","session_id":"new"}\n')
    expect(tracker.sessionId).toBe('new')
  })
  it('skips oversized output and resumes at the next record', () => {
    const tracker = new StartedSessionTracker('codex')
    tracker.feed('x'.repeat(70000))
    tracker.feed('\n{"type":"thread.started","thread_id":"new"}\n')
    expect(tracker.sessionId).toBe('new')
  })
  it('requests structured stdout from Codex and Claude without adding a shell prompt', () => {
    const codex = buildStartPlan({ kind: 'codex' }, 'hello')
    const claude = buildStartPlan({ kind: 'claude' }, 'hello')
    if ('error' in codex || 'error' in claude) throw new Error('plans failed')
    expect(codex.args).toContain('--json')
    expect(claude.args).toContain('stream-json')
    expect(claude.args).toContain('--verbose')
    expect(codex.useStdin && claude.useStdin).toBe(true)
  })
})
