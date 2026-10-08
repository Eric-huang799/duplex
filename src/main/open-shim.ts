/**
 * Helpers that route URL-opening from CLI tools to Duplex (feedback FB-001).
 *
 * No Electron imports here on purpose: the built-in agent's command tools also
 * import this module. Strategy (part B of the plan):
 *  - spawn external CLIs / commands with `BROWSER=duplex-open` and a shim
 *    directory prepended to PATH;
 *  - the shim reads ~/.cobrowse/endpoint.json and POSTs the URL to /api/open.
 *
 * Tools that ignore $BROWSER (e.g. node-open → `start`) are covered by the
 * separate candidate-browser registration in browser-registration.ts.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cobrowseDir } from '../shared/endpoint'

/** First http(s) URL found in a process argv list (or null). */
export function extractHttpUrl(args: readonly string[]): string | null {
  for (const a of args) {
    const m = /https?:\/\/[^\s"']+/i.exec(String(a ?? ''))
    if (m) return m[0]
  }
  return null
}

export function shimDir(): string {
  return path.join(cobrowseDir(), 'shims')
}

const SHIM_JS = `#!/usr/bin/env node
const fs=require('fs'),os=require('os'),path=require('path')
const url=(process.argv.slice(2).find(a=>/^https?:\\/\\//i.test(a))||'').trim()
if(!url) process.exit(0)
try{
  const ep=JSON.parse(fs.readFileSync(path.join(os.homedir(),'.cobrowse','endpoint.json'),'utf8'))
  fetch('http://127.0.0.1:'+ep.port+'/api/open',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+ep.token},body:JSON.stringify({url})}).catch(()=>{})
}catch(e){}
process.exit(0)
`

let cachedDir: string | null = null

/** Write (once) the `duplex-open` shim; returns its directory. Best effort. */
export function ensureOpenShim(): string {
  if (cachedDir) return cachedDir
  const dir = shimDir()
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'duplex-open.js'), SHIM_JS, 'utf8')
    if (process.platform === 'win32') {
      fs.writeFileSync(
        path.join(dir, 'duplex-open.cmd'),
        '@echo off\r\nnode "%~dp0duplex-open.js" %*\r\n',
        'utf8'
      )
    } else {
      const p = path.join(dir, 'duplex-open')
      fs.writeFileSync(p, '#!/bin/sh\nexec node "$(dirname "$0")/duplex-open.js" "$@"\n', 'utf8')
      fs.chmodSync(p, 0o755)
    }
  } catch {
    /* best effort: the caller can still spawn without the shim */
  }
  cachedDir = dir
  return dir
}

/** Child env with BROWSER=duplex-open and the shim dir first on PATH. */
export function duplexShimEnv(dir: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, BROWSER: 'duplex-open' }
  // Windows env vars are case-insensitive: accept either spelling of PATH
  const cur = env['Path'] ?? env['PATH'] ?? env['path'] ?? ''
  const next = dir + path.delimiter + cur
  env.PATH = next
  env.Path = next
  return env
}
