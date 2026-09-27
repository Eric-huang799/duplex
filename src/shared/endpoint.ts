/** Endpoint file helpers (node-only; used by main process and the bridge). */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { EndpointInfo } from './protocol'

export function cobrowseDir(): string {
  return path.join(os.homedir(), '.cobrowse')
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
  const dir = cobrowseDir()
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(endpointFilePath(), JSON.stringify(info, null, 2), 'utf8')
}

export function removeEndpoint(pid: number): void {
  try {
    const cur = readEndpoint()
    if (cur && cur.pid === pid) fs.rmSync(endpointFilePath(), { force: true })
  } catch {
    /* ignore */
  }
}
