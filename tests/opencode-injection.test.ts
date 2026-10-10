import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CobrowseMirror } from '../integrations/opencode/plugins/cobrowse-mirror'
import { MirrorStore } from '../src/main/mirror'

vi.mock('node:fs', () => ({ default: {
  readFileSync: () => JSON.stringify({ port: 19229, token: 'local-test-token' }),
  existsSync: () => true
} }))

const never = (): Promise<Response> => new Promise(() => {})
const tick = async (): Promise<void> => {
  for (let i = 0; i < 40; i++) await Promise.resolve()
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('OpenCode message delivery at the HTTP boundary', () => {
  it('does not claim messages for a session belonging to another OpenCode client', async () => {
    let claims = 0
    vi.stubGlobal('fetch', async (input: string) => {
      const url = new URL(input)
      if (url.pathname === '/api/session/state') return Response.json({ activeSessionID: 'foreign' })
      if (url.pathname === '/api/injections') claims++
      return never()
    })
    await CobrowseMirror({ client: { session: {
      get: async () => ({ error: { message: 'Session not found' } })
    } } })
    await tick()
    expect(claims).toBe(0)
  })

  it('releases the failed and unprocessed messages using their original ids and one consumer identity', async () => {
    const released: Array<{ id?: string; consumerID?: string; text?: string }> = []
    const queries: URL[] = []
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
      const url = new URL(input)
      if (url.pathname === '/api/session/state') return Response.json({ activeSessionID: 'A' })
      if (url.pathname === '/api/injections/renew') return Response.json({ ok: true })
      if (url.pathname === '/api/injections') {
        queries.push(url)
        return queries.length === 1
          ? Response.json([{ id: 'first', text: 'first' }, { id: 'second', text: 'second' }])
          : never()
      }
      if (url.pathname === '/api/injections/requeue') {
        released.push(JSON.parse(String(init?.body)))
        return Response.json({ ok: true })
      }
      return never()
    })
    await CobrowseMirror({ client: { session: {
      get: async () => ({ data: { id: 'A' } }),
      promptAsync: async () => { throw new Error('temporarily unavailable') }
    } } })
    await tick()
    expect(released.map((item) => item.id).sort()).toEqual(['first', 'second'])
    const consumerID = queries[0].searchParams.get('consumerID')
    expect(consumerID).toBeTruthy()
    expect(queries[0].searchParams.get('sessionID')).toBe('A')
    expect(released.every((item) => item.consumerID === consumerID && item.text === undefined)).toBe(true)
  })

  it('awaits fallback prompt acceptance and never acknowledges a rejected prompt', async () => {
    const acknowledgments: string[] = []
    const releases: string[] = []
    let claimed = false
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
      const url = new URL(input)
      if (url.pathname === '/api/session/state') return Response.json({ activeSessionID: 'A' })
      if (url.pathname === '/api/injections/renew') return Response.json({ ok: true })
      if (url.pathname === '/api/injections' && !claimed) {
        claimed = true
        return Response.json([{ id: 'fallback', text: 'fallback' }])
      }
      if (url.pathname === '/api/injections/ack') {
        acknowledgments.push(JSON.parse(String(init?.body)).id)
        return Response.json({ ok: true })
      }
      if (url.pathname === '/api/injections/requeue') {
        releases.push(JSON.parse(String(init?.body)).id)
        return Response.json({ ok: true })
      }
      return never()
    })
    await CobrowseMirror({ client: { session: {
      get: async () => ({ data: { id: 'A' } }),
      prompt: async () => { throw new Error('rejected') }
    } } })
    await tick()
    expect(acknowledgments).toEqual([])
    expect(releases).toEqual(['fallback'])
  })

  it('renews a slow fallback prompt claim until real completion and then acknowledges it', async () => {
    const mirror = new MirrorStore()
    const injection = mirror.addInjection('slow', 'panel', { sessionID: 'A' })
    let resolvePrompt!: () => void
    const prompt = new Promise<void>((resolve) => { resolvePrompt = resolve })
    let renewals = 0
    let claims = 0
    let acknowledgments = 0
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
      const url = new URL(input)
      if (url.pathname === '/api/session/state') return Response.json({ activeSessionID: 'A' })
      if (url.pathname === '/api/injections') {
        claims++
        return claims === 1 ? Response.json(mirror.takeInjections({
          id: url.searchParams.get('consumerID') ?? undefined, sessionID: 'A'
        })) : never()
      }
      if (url.pathname === '/api/injections/renew') {
        renewals++
        const body = JSON.parse(String(init?.body))
        return Response.json({ ok: mirror.renewInjection(body.id, body.consumerID) })
      }
      if (url.pathname === '/api/injections/ack') {
        acknowledgments++
        const body = JSON.parse(String(init?.body))
        return Response.json({ ok: mirror.ackInjection(body.id, body.consumerID) })
      }
      return never()
    })
    await CobrowseMirror({ client: { session: {
      get: async () => ({ data: { id: 'A' } }), prompt: () => prompt
    } } })
    await tick()
    await vi.advanceTimersByTimeAsync(70_000)
    expect(renewals).toBeGreaterThanOrEqual(3)
    expect(mirror.pendingInjections()).toEqual([])
    expect(acknowledgments).toBe(0)
    resolvePrompt()
    await tick()
    expect(acknowledgments).toBe(1)
    expect(mirror.releaseInjection(injection.id)).toBe(false)
    mirror.clearInjections()
  })

  it('retries a lost acknowledgment without submitting the accepted prompt again', async () => {
    let claims = 0
    let acknowledgments = 0
    let prompts = 0
    vi.stubGlobal('fetch', async (input: string) => {
      const url = new URL(input)
      if (url.pathname === '/api/session/state') return Response.json({ activeSessionID: 'A' })
      if (url.pathname === '/api/injections/renew') return Response.json({ ok: true })
      if (url.pathname === '/api/injections') {
        claims++
        return claims === 1 ? Response.json([{ id: 'accepted', text: 'accepted' }]) : never()
      }
      if (url.pathname === '/api/injections/ack') {
        acknowledgments++
        if (acknowledgments === 1) throw new Error('response lost')
        return Response.json({ ok: true })
      }
      return never()
    })
    await CobrowseMirror({ client: { session: {
      get: async () => ({ data: { id: 'A' } }),
      promptAsync: async () => { prompts++ }
    } } })
    await tick()
    await vi.advanceTimersByTimeAsync(2500)
    expect(prompts).toBe(1)
    expect(acknowledgments).toBe(2)
  })

  it('releases a prompt whose SDK result contains an error without throwing', async () => {
    const released: string[] = []
    let claimed = false
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
      const url = new URL(input)
      if (url.pathname === '/api/session/state') return Response.json({ activeSessionID: 'A' })
      if (url.pathname === '/api/injections/renew') return Response.json({ ok: true })
      if (url.pathname === '/api/injections' && !claimed) {
        claimed = true
        return Response.json([{ id: 'error-result', text: 'error-result' }])
      }
      if (url.pathname === '/api/injections/requeue') {
        released.push(JSON.parse(String(init?.body)).id)
        return Response.json({ ok: true })
      }
      return never()
    })
    await CobrowseMirror({ client: { session: {
      get: async () => ({ data: { id: 'A' } }),
      promptAsync: async () => ({ error: { message: 'rejected' } })
    } } })
    await tick()
    expect(released).toEqual(['error-result'])
  })
})
