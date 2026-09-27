/**
 * Duplex stdio MCP bridge.
 *
 * MCP clients (opencode etc.) run this via stdio. Tool listing is static so no
 * browser is needed to go through MCP startup; the first tool call lazily
 * auto-starts the Duplex browser app (installed build first, dev electron as
 * fallback; window comes to front) and then forwards every call to the app's
 * local HTTP MCP endpoint.
 *
 * stdout is reserved for JSON-RPC — all logs go to stderr.
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { readEndpoint } from '../shared/endpoint'
import { toolDefs } from '../shared/tools'
import type { EndpointInfo } from '../shared/protocol'

declare const __dirname: string

const VERSION = '0.1.0'

function log(...args: unknown[]): void {
  console.error('[duplex-bridge]', ...args)
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function findRoot(): string {
  const env = process.env.COBROWSE_ROOT
  if (env && fs.existsSync(path.join(env, 'package.json'))) return env
  const guess = path.resolve(__dirname, '..')
  if (fs.existsSync(path.join(guess, 'package.json'))) return guess
  throw new Error(
    'cannot locate the Duplex project root; set the COBROWSE_ROOT env var to the folder containing package.json'
  )
}

function isBuilt(root: string): boolean {
  return fs.existsSync(path.join(root, 'out', 'main', 'index.js'))
}

async function ensureBuilt(root: string): Promise<void> {
  if (isBuilt(root)) return
  log('app is not built yet; running `npm run build` (first time only, ~30s)...')
  await new Promise<void>((resolve, reject) => {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    const child = spawn(npm, ['run', 'build'], {
      cwd: root,
      stdio: ['ignore', 'ignore', 'pipe'],
      shell: process.platform === 'win32'
    })
    child.stderr.on('data', (d) => log('[build]', String(d).trim()))
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('build timed out after 180s'))
    }, 180_000)
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`build failed (exit code ${code})`))
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
  })
  if (!isBuilt(root)) throw new Error('build finished but out/main/index.js is still missing')
}

function electronBinary(root: string): string {
  const base = path.join(root, 'node_modules', 'electron', 'dist')
  if (process.platform === 'win32') return path.join(base, 'electron.exe')
  if (process.platform === 'darwin') {
    return path.join(base, 'Electron.app', 'Contents', 'MacOS', 'Electron')
  }
  return path.join(base, 'electron')
}

/** Per-user install location written by the NSIS installer. */
function installedAppBinary(): string | null {
  if (process.platform !== 'win32') return null
  const base = process.env.LOCALAPPDATA ?? ''
  if (!base) return null
  const candidate = path.join(base, 'Programs', 'Duplex', 'Duplex.exe')
  return fs.existsSync(candidate) ? candidate : null
}

function launchApp(root: string): void {
  const installed = installedAppBinary()
  if (installed) {
    log(`launching installed Duplex (${installed})...`)
    const child = spawn(installed, [], { cwd: root, detached: true, stdio: 'ignore' })
    child.unref()
    return
  }
  const bin = electronBinary(root)
  if (!fs.existsSync(bin)) {
    throw new Error(
      `no Duplex app found: no installed build and no dev electron binary at ${bin} — run \`npm install\` inside ${root}`
    )
  }
  log('launching Duplex browser (dev electron)...')
  const child = spawn(bin, [root], { cwd: root, detached: true, stdio: 'ignore' })
  child.unref()
}

async function ping(info: EndpointInfo): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${info.port}/health`, {
      signal: AbortSignal.timeout(1500)
    })
    return res.ok
  } catch {
    return false
  }
}

let client: Client | null = null
let clientFor: EndpointInfo | null = null

async function ensureEndpoint(): Promise<EndpointInfo> {
  const cur = readEndpoint()
  if (cur && (await ping(cur))) return cur

  const oldStartedAt = cur?.startedAt ?? null
  const root = findRoot()
  await ensureBuilt(root)
  launchApp(root)

  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    await sleep(800)
    const info = readEndpoint()
    if (info && info.startedAt !== oldStartedAt && (await ping(info))) {
      log(`browser is ready on 127.0.0.1:${info.port}`)
      return info
    }
  }
  throw new Error(
    'Duplex did not become ready within 30s. Try launching it manually to see the error.'
  )
}

async function getClient(): Promise<Client> {
  if (client && clientFor && (await ping(clientFor))) return client
  if (client) {
    try {
      await client.close()
    } catch {
      /* ignore */
    }
    client = null
    clientFor = null
  }
  const info = await ensureEndpoint()
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${info.port}/mcp`),
    { requestInit: { headers: { Authorization: `Bearer ${info.token}` } } }
  )
  const c = new Client({ name: 'duplex-bridge', version: VERSION })
  await c.connect(transport)
  client = c
  clientFor = info
  return c
}

async function callRemote(name: string, args: Record<string, unknown>): Promise<unknown> {
  let lastErr: unknown = null
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const c = await getClient()
      return await c.callTool({ name, arguments: args })
    } catch (e) {
      lastErr = e
      log(`call ${name} attempt ${attempt + 1} failed:`, (e as Error)?.message ?? e)
      if (client) {
        try {
          await client.close()
        } catch {
          /* ignore */
        }
        client = null
        clientFor = null
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

async function main(): Promise<void> {
  const server = new McpServer({ name: 'duplex', version: VERSION })
  for (const def of toolDefs) {
    server.registerTool(
      def.name,
      { description: def.description, inputSchema: def.input },
      async (args: Record<string, unknown>) => {
        try {
          const res = (await callRemote(def.name, args ?? {})) as {
            content: Array<{ type: string; text?: string }>
            isError?: boolean
          }
          return res as never
        } catch (e) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Duplex bridge error: ${(e as Error)?.message ?? String(e)}`
              }
            ],
            isError: true
          } as never
        }
      }
    )
  }
  await server.connect(new StdioServerTransport())
  log('bridge ready — waiting for tool calls')
}

main().catch((e) => {
  log('fatal:', e)
  process.exit(1)
})
