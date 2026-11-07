/** Endpoint file helpers (node-only; used by main process and the bridge). */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { EndpointInfo } from './protocol'
import { writeFileAtomic } from './atomic'

export function cobrowseDir(): string {
  return process.env['DUPLEX_DATA_DIR']
    ? path.resolve(process.env['DUPLEX_DATA_DIR'])
    : path.join(os.homedir(), '.cobrowse')
}

export function endpointFilePath(): string {
  return path.join(cobrowseDir(), 'endpoint.json')
}

export function readEndpoint(): EndpointInfo | null {
  try {
    const raw = fs.readFileSync(endpointFilePath(), 'utf8')
    const info = JSON.parse(raw) as EndpointInfo
    if (typeof info.port === 'number' && typeof info.token === 'string' && info.token.length > 0) {
      return info
    }
    return null
  } catch {
    return null
  }
}

export function writeEndpoint(info: EndpointInfo): void {
  // 这个文件里是本地 MCP/HTTP 的 Bearer token：原子写 + 0600（Windows 走 ACL）。
  // 原来直接 writeFileSync，崩溃可能留下截断的 JSON，bridge 会读不到端点。
  writeFileAtomic(endpointFilePath(), JSON.stringify(info, null, 2), { mode: 0o600 })
}

export function removeEndpoint(pid: number): void {
  try {
    const cur = readEndpoint()
    if (cur && cur.pid === pid) fs.rmSync(endpointFilePath(), { force: true })
  } catch {
    /* ignore */
  }
}
