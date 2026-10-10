import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startHttpServer, type RunningHttpServer } from '../src/main/http-server'
import { MirrorStore } from '../src/main/mirror'
import { SessionBus } from '../src/main/session-bus'
import { currentCaller } from '../src/main/collaboration'
import type { TabManager } from '../src/main/tabs'

vi.mock('electron', () => ({ app: { isPackaged: false }, BrowserWindow: { getAllWindows: () => [] } }))

let server: RunningHttpServer
let mirror: MirrorStore
let bus: SessionBus
let userActions: number
let activeTab: number
let opened: Array<{ url?: string; background?: boolean }>
const headers = { authorization: 'Bearer test-token', 'content-type': 'application/json' }

const request = async (route: string, body?: unknown): Promise<Response> => fetch(
  `http://127.0.0.1:${server.port}${route}`, {
    headers, ...(body !== undefined ? { method: 'POST', body: JSON.stringify(body) } : {})
  }
)
const json = async (route: string, body?: unknown): Promise<any> => (await request(route, body)).json()

beforeEach(async () => {
  mirror = new MirrorStore()
  bus = new SessionBus()
  userActions = 0
  activeTab = 7
  opened = []
  server = await startHttpServer({
    token: 'test-token', version: '0.2.9-test', mirror, sessionBus: bus,
    tabs: { createTab: (url?: string, options?: { background?: boolean }) => {
      opened.push({ url, background: options?.background })
      if (!options?.background) activeTab = 8
      return { id: 8 }
    } } as unknown as TabManager,
    executeTool: async () => {
      await Promise.resolve()
      return { content: [{ type: 'text', text: currentCaller() }] }
    },
    onUserActivity: () => { userActions++ }
  })
})

afterEach(() => {
  mirror.clearInjections()
  server.close()
})

describe('HTTP delivery uses the actual claimed message', () => {
  it('captures the selected session before a later user selection and enforces receipt ownership', async () => {
    await json('/api/session/report', { consumerID: 'worker-A', sessions: [{ id: 'A', title: 'A', updated: 1 }] })
    await json('/api/session/report', { consumerID: 'worker-B', sessions: [{ id: 'B', title: 'B', updated: 2 }] })
    await json('/api/session/command', { action: 'select', sessionID: 'A' })
    const queued = await json('/api/chat', { text: 'for A' })
    await json('/api/session/command', { action: 'select', sessionID: 'B' })
    expect(await json('/api/injections?consumerID=worker-B&sessionID=B')).toEqual([])
    const [claimed] = await json('/api/injections?consumerID=worker-A&sessionID=A')
    expect(claimed).toMatchObject({ id: queued.id, text: 'for A', targetSessionID: 'A' })
    expect(await json('/api/injections/renew', { id: claimed.id, consumerID: 'worker-A' })).toEqual({ ok: true })
    expect(await json('/api/injections/ack', { id: claimed.id, consumerID: 'worker-B' })).toEqual({ ok: false })
    expect(await json('/api/injections/requeue', { id: claimed.id, consumerID: 'worker-A' })).toEqual({ ok: true })
    const [retried] = await json('/api/injections?consumerID=worker-A&sessionID=A')
    expect(retried.id).toBe(queued.id)
    expect(await json('/api/injections/ack', { id: claimed.id, consumerID: 'worker-A' })).toEqual({ ok: true })
    expect(userActions).toBe(1)
  })

  it('rejects canceled claims and legacy text-only retries without resuming AI', async () => {
    const message = mirror.addInjection('cancel me', 'annotation')
    await json('/api/injections?consumerID=worker&sessionID=A')
    mirror.clearInjections()
    for (const operation of ['renew', 'requeue', 'ack']) {
      expect(await json(`/api/injections/${operation}`, { id: message.id, consumerID: 'worker' })).toEqual({ ok: false })
    }
    expect((await request('/api/injections/requeue', { text: 'old retry' })).status).toBe(400)
    expect(userActions).toBe(0)
    expect(mirror.pendingInjections()).toEqual([])
  })

  it('routes history commands and waiting message polls to the reporting consumer', async () => {
    await json('/api/session/report', { consumerID: 'owner', sessions: [{ id: 'A', title: 'A', updated: 1 }] })
    await json('/api/session/command', { action: 'select', sessionID: 'A' })
    expect(await json('/api/session/command?wait=1&consumerID=other')).toEqual([])
    expect((await json('/api/session/command?wait=1&consumerID=owner'))[0]).toMatchObject({ action: 'history', sessionID: 'A' })
    await json('/api/chat', { text: 'queued' })
    expect(await json('/api/injections?wait=1&consumerID=other&sessionID=B')).toEqual([])
    expect((await json('/api/injections?wait=1&consumerID=owner&sessionID=A'))[0].text).toBe('queued')
  })

  it('reconnect reports move the consumer identity while preserving the message session', async () => {
    mirror.addInjection('reconnect', 'panel', { sessionID: 'A', consumerID: 'old-worker' })
    await json('/api/session/report', { consumerID: 'new-worker', sessions: [{ id: 'A', title: 'A', updated: 1 }] })
    expect((await json('/api/injections?consumerID=new-worker&sessionID=A'))[0].text).toBe('reconnect')
  })

  it('opens a CLI requested page in the background without switching the active tab', async () => {
    expect(await json('/api/open', { url: 'https://example.com/research' })).toMatchObject({ ok: true })
    expect(opened).toEqual([{ url: 'https://example.com/research', background: true }])
    expect(activeTab).toBe(7)
  })
})

describe('MCP caller context across actual HTTP requests', () => {
  it('keeps concurrent caller identities separate through awaited tool execution', async () => {
    const call = async (caller?: string): Promise<string> => {
      const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`), {
        requestInit: { headers: { authorization: headers.authorization, ...(caller ? { 'duplex-caller-id': caller } : {}) } }
      })
      const client = new Client({ name: 'http-regression', version: '1' })
      try {
        await client.connect(transport)
        const result = await client.callTool({ name: 'list_tabs', arguments: {} })
        return (result.content as Array<{ type: string; text: string }>)[0].text
      } finally { await client.close() }
    }
    expect(await Promise.all([call('mcp:one'), call('mcp:two'), call()])).toEqual(['mcp:one', 'mcp:two', 'mcp:direct'])
  })

  it('rejects an oversized caller identity before executing an MCP request', async () => {
    const response = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: 'POST', headers: { ...headers, 'duplex-caller-id': 'x'.repeat(129) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_tabs', arguments: {} } })
    })
    expect(response.status).toBe(400)
  })
})
