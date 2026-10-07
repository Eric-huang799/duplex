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

const VERSION = '0.2.6'

/**
 * When the bridge runs from an installed (packaged) app it lives inside
 * `app.asar.unpacked`: there is no project root to build, so the app must be
 * located by its install path instead.
 */
const IS_PACKAGED_BRIDGE = __dirname.includes('app.asar.unpacked')

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
    '无法定位 Duplex 项目根目录（含 package.json 的文件夹）。请在开发模式下设置 COBROWSE_ROOT 环境变量指向项目根目录，或改用已安装的 Duplex 应用。'
  )
}

function isBuilt(root: string): boolean {
  return fs.existsSync(path.join(root, 'out', 'main', 'index.js'))
}

async function ensureBuilt(root: string): Promise<void> {
  if (IS_PACKAGED_BRIDGE) {
    throw new Error('已安装版应用的 bridge 不支持自动构建，请直接启动已安装的 Duplex 应用。')
  }
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
      reject(new Error('首次自动构建超时（180 秒）。请在项目目录手动运行 npm run build，然后重试。'))
    }, 180_000)
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`自动构建失败（退出码 ${code}）。请在项目目录运行 npm run build 查看具体错误。`))
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
  })
  if (!isBuilt(root)) {
    throw new Error('构建完成后仍未找到 out/main/index.js。请在项目目录手动运行 npm run build 并检查错误。')
  }
}

function electronBinary(root: string): string {
  const base = path.join(root, 'node_modules', 'electron', 'dist')
  if (process.platform === 'win32') return path.join(base, 'electron.exe')
  if (process.platform === 'darwin') {
    return path.join(base, 'Electron.app', 'Contents', 'MacOS', 'Electron')
  }
  return path.join(base, 'electron')
}

/** Per-user install location written by the NSIS installer (Windows) / drag-install (macOS). */
function installedAppPath(): string | null {
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA ?? ''
    if (!base) return null
    const candidate = path.join(base, 'Programs', 'Duplex', 'Duplex.exe')
    return fs.existsSync(candidate) ? candidate : null
  }
  if (process.platform === 'darwin') {
    const candidate = '/Applications/Duplex.app'
    return fs.existsSync(candidate) ? candidate : null
  }
  return null
}

function installedAppHint(): string {
  if (process.platform === 'win32') return '%LOCALAPPDATA%\\Programs\\Duplex\\Duplex.exe'
  if (process.platform === 'darwin') return '/Applications/Duplex.app'
  return '（当前系统暂不支持自动定位）'
}

function launchInstalledApp(): void {
  const installed = installedAppPath()
  if (!installed) {
    throw new Error(
      `未找到已安装的 Duplex 应用（预期位置：${installedAppHint()}）。请重新安装 Duplex，或手动启动 Duplex 后重试。`
    )
  }
  log(`launching installed Duplex (${installed})...`)
  if (process.platform === 'darwin') {
    const child = spawn('open', [installed], { detached: true, stdio: 'ignore' })
    child.unref()
    return
  }
  const child = spawn(installed, [], { detached: true, stdio: 'ignore' })
  child.unref()
}

/**
 * Launch an app instance. Installed builds win when present (packaged bridges
 * require one); dev mode falls back to the project-local electron binary.
 */
function launchApp(root: string | null): void {
  if (installedAppPath()) {
    launchInstalledApp()
    return
  }
  if (!root) {
    // packaged bridge with no installed app: report the expected install path
    launchInstalledApp()
    return
  }
  const bin = electronBinary(root)
  if (!fs.existsSync(bin)) {
    throw new Error(
      `未找到 Duplex 应用：既没有已安装版本，也没有开发版 electron（${bin}）。请在项目目录运行 npm install 后重试。`
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
  if (IS_PACKAGED_BRIDGE) {
    // Installed build: nothing to locate or compile, only launch the app.
    launchApp(null)
  } else {
    const root = findRoot()
    await ensureBuilt(root)
    launchApp(root)
  }

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
    'Duplex 在 30 秒内未就绪。请手动启动 Duplex 应用查看具体错误，或确认端口未被防火墙拦截，然后重试。'
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
    if (def.internal) continue
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
                text: `Duplex bridge 调用失败：${(e as Error)?.message ?? String(e)}`
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
