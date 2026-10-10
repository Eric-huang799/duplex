import { afterEach, describe, expect, it, vi } from 'vitest'
import { MirrorStore } from '../src/main/mirror'
import { SessionBus } from '../src/main/session-bus'

afterEach(() => vi.useRealTimers())

describe('message delivery across retries and session changes', () => {
  it('claims only one message and preserves the failed message identity', () => {
    const mirror = new MirrorStore()
    const first = mirror.addInjection('A', 'annotation')
    const second = mirror.addInjection('B', 'panel')
    expect(mirror.takeInjections({ id: 'worker', sessionID: 'A' })).toHaveLength(1)
    expect(mirror.pendingInjections().map((i) => i.id)).toEqual([second.id])
    expect(mirror.releaseInjection(first.id, 'worker')).toBe(true)
    expect(mirror.takeInjections({ id: 'worker', sessionID: 'A' })[0]).toMatchObject({
      id: first.id, text: 'A', source: 'annotation'
    })
    mirror.clearInjections()
  })

  it('does not let another session or consumer take a targeted message', () => {
    const mirror = new MirrorStore()
    const message = mirror.addInjection('A-only', 'panel', { sessionID: 'A', consumerID: 'project-A' })
    expect(mirror.takeInjections({ id: 'project-B', sessionID: 'A' })).toEqual([])
    expect(mirror.takeInjections({ id: 'project-A', sessionID: 'B' })).toEqual([])
    expect(mirror.takeInjections({ id: 'project-A', sessionID: 'A' })[0].id).toBe(message.id)
    mirror.clearInjections()
  })

  it('keeps a released auto-target message bound to the first receiving session', () => {
    const mirror = new MirrorStore()
    const message = mirror.addInjection('follow-up', 'panel')
    mirror.takeInjections({ id: 'worker', sessionID: 'A' })
    mirror.releaseInjection(message.id, 'worker')
    expect(mirror.takeInjections({ id: 'worker', sessionID: 'B' })).toEqual([])
    expect(mirror.takeInjections({ id: 'worker', sessionID: 'A' })[0].id).toBe(message.id)
    mirror.clearInjections()
  })

  it('rejects acknowledgment and release by a different consumer', () => {
    const mirror = new MirrorStore()
    const message = mirror.addInjection('message', 'panel')
    mirror.takeInjections({ id: 'owner', sessionID: 'A' })
    expect(mirror.ackInjection(message.id, 'stranger')).toBe(false)
    expect(mirror.releaseInjection(message.id, 'stranger')).toBe(false)
    expect(mirror.ackInjection(message.id, 'owner')).toBe(true)
    expect(mirror.releaseInjection(message.id, 'owner')).toBe(false)
  })

  it('emergency clear drops pending and claimed messages and rejects stale retries', () => {
    const mirror = new MirrorStore()
    const message = mirror.addInjection('claimed', 'panel')
    mirror.takeInjections({ id: 'worker', sessionID: 'A' })
    mirror.addInjection('pending', 'annotation')
    expect(mirror.clearInjections()).toBe(2)
    expect(mirror.releaseInjection(message.id, 'worker')).toBe(false)
    expect(mirror.pendingInjections()).toEqual([])
    const fresh = mirror.addInjection('fresh', 'panel')
    expect(fresh.generation).not.toBe(message.generation)
  })

  it('pause prevents immediate and already waiting consumers from taking messages', async () => {
    vi.useFakeTimers()
    const mirror = new MirrorStore()
    const waiting = mirror.waitForInjections(5000, { id: 'worker', sessionID: 'A' })
    mirror.setInjectionPaused(true)
    mirror.addInjection('paused', 'panel')
    expect(mirror.takeInjections({ id: 'worker', sessionID: 'A' })).toEqual([])
    await vi.advanceTimersByTimeAsync(5000)
    expect(await waiting).toEqual([])
    mirror.setInjectionPaused(false)
    expect(mirror.takeInjections({ id: 'worker', sessionID: 'A' })).toHaveLength(1)
    mirror.clearInjections()
  })

  it('a disconnected consumer lease expires and wakes another matching waiter', async () => {
    vi.useFakeTimers()
    const mirror = new MirrorStore()
    const message = mirror.addInjection('recover', 'panel', { sessionID: 'A' })
    mirror.takeInjections({ id: 'dead', sessionID: 'A' })
    await vi.advanceTimersByTimeAsync(40_000)
    const waiting = mirror.waitForInjections(30_000, { id: 'healthy', sessionID: 'A' })
    await vi.advanceTimersByTimeAsync(20_000)
    expect((await waiting)[0].id).toBe(message.id)
    expect(mirror.ackInjection(message.id, 'dead')).toBe(false)
    expect(mirror.ackInjection(message.id, 'healthy')).toBe(true)
  })

  it('a waiter for another session remains waiting when an unrelated message arrives', async () => {
    vi.useFakeTimers()
    const mirror = new MirrorStore()
    const waiting = mirror.waitForInjections(2000, { id: 'worker-B', sessionID: 'B' })
    mirror.addInjection('A', 'panel', { sessionID: 'A' })
    mirror.addInjection('B', 'panel', { sessionID: 'B' })
    expect((await waiting)[0].text).toBe('B')
    expect(mirror.pendingInjections()[0].text).toBe('A')
    mirror.clearInjections()
  })

  it('a live consumer can extend its claim but a canceled claim cannot be renewed', async () => {
    vi.useFakeTimers()
    const mirror = new MirrorStore()
    const message = mirror.addInjection('slow prompt', 'panel', { sessionID: 'A' })
    mirror.takeInjections({ id: 'worker', sessionID: 'A' })
    await vi.advanceTimersByTimeAsync(40_000)
    expect(mirror.renewInjection(message.id, 'stranger')).toBe(false)
    expect(mirror.renewInjection(message.id, 'worker')).toBe(true)
    await vi.advanceTimersByTimeAsync(40_000)
    expect(mirror.pendingInjections()).toEqual([])
    mirror.clearInjections()
    expect(mirror.renewInjection(message.id, 'worker')).toBe(false)
  })

  it('rebinds a reconnected consumer without moving messages into another session', () => {
    const mirror = new MirrorStore()
    const message = mirror.addInjection('A', 'panel', { sessionID: 'A', consumerID: 'old' })
    mirror.takeInjections({ id: 'old', sessionID: 'A' })
    mirror.addInjection('B', 'panel', { sessionID: 'B', consumerID: 'old' })
    expect(mirror.rebindConsumer('A', 'new')).toBe(1)
    expect(mirror.releaseInjection(message.id, 'old')).toBe(true)
    expect(mirror.takeInjections({ id: 'new', sessionID: 'B' })).toEqual([])
    expect(mirror.takeInjections({ id: 'new', sessionID: 'A' })[0].id).toBe(message.id)
    expect(mirror.pendingInjections()[0].consumerID).toBe('old')
    mirror.clearInjections()
  })
})

describe('session commands stay with the reporting consumer', () => {
  it('routes history to its reported owner and merges independent project lists', async () => {
    vi.useFakeTimers()
    const bus = new SessionBus()
    bus.report({ consumerID: 'project-A', sessions: [{ id: 'A', title: 'A', updated: 1 }] })
    bus.report({ consumerID: 'project-B', sessions: [{ id: 'B', title: 'B', updated: 2 }] })
    expect(bus.state.sessions.map((s) => s.id).sort()).toEqual(['A', 'B'])
    bus.select({ sessionID: 'A' })
    expect(bus.state.activeConsumerID).toBe('project-A')
    bus.push({ action: 'history', sessionID: 'A' })
    const wrong = bus.waitForCommands(1000, 'project-B')
    const right = await bus.waitForCommands(1000, 'project-A')
    expect(right[0]).toMatchObject({ action: 'history', sessionID: 'A' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(await wrong).toEqual([])
  })
})
