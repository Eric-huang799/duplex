/**
 * Tests for the built-in agent's filesystem/shell tools: confirmation gating,
 * protected-path refusal, and process-tree timeout handling.
 */
import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createFsToolHandlers } from '../src/main/agent/fs-tools'

function makeConfirm(allow: boolean) {
  const calls: Array<{ kind: string; detail: string; cwd: string }> = []
  const fn = vi.fn(
    async (payload: { kind: 'write' | 'command'; detail: string; cwd: string }): Promise<boolean> => {
      calls.push(payload)
      return allow
    }
  )
  return { fn, calls }
}

describe('fs-tools write_file', () => {
  it('writes a file (creating parents) after approval', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplex-fs-'))
    try {
      const { fn, calls } = makeConfirm(true)
      const handlers = createFsToolHandlers(fn)
      const target = path.join(dir, 'sub', 'a.txt')
      const res = await handlers.write_file({ path: target, content: 'hello' })
      expect(res.isError).toBeFalsy()
      expect(fs.readFileSync(target, 'utf8')).toBe('hello')
      expect(calls[0].kind).toBe('write')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not write when the user denies', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplex-fs-'))
    try {
      const { fn } = makeConfirm(false)
      const handlers = createFsToolHandlers(fn)
      const target = path.join(dir, 'b.txt')
      const res = await handlers.write_file({ path: target, content: 'x' })
      expect(fs.existsSync(target)).toBe(false)
      expect(JSON.stringify(res.content)).toContain('拒绝')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses protected system targets without even asking', async () => {
    const { fn, calls } = makeConfirm(true)
    const handlers = createFsToolHandlers(fn)
    const target = process.platform === 'win32' ? 'C:\\Windows\\evil.txt' : '/etc/evil.txt'
    const res = await handlers.write_file({ path: target, content: 'x' })
    expect(res.isError).toBe(true)
    expect(calls.length).toBe(0)
  })

  it('refuses ~/.ssh even when the user would approve', async () => {
    const { fn, calls } = makeConfirm(true)
    const handlers = createFsToolHandlers(fn)
    const res = await handlers.write_file({
      path: path.join(os.homedir(), '.ssh', 'authorized_keys'),
      content: 'k'
    })
    expect(res.isError).toBe(true)
    expect(calls.length).toBe(0)
  })

  it('rejects missing arguments', async () => {
    const { fn } = makeConfirm(true)
    const handlers = createFsToolHandlers(fn)
    const res = await handlers.write_file({ path: '' })
    expect(res.isError).toBe(true)
  })
})

describe('fs-tools run_command', () => {
  it('runs a command after approval and returns its output', async () => {
    const { fn, calls } = makeConfirm(true)
    const handlers = createFsToolHandlers(fn)
    const res = await handlers.run_command({ command: 'echo duplex-test-ok', timeout_ms: 10_000 })
    expect(res.isError).toBeFalsy()
    expect(JSON.stringify(res.content)).toContain('duplex-test-ok')
    expect(calls[0].kind).toBe('command')
  })

  it('does not run when the user denies', async () => {
    const { fn } = makeConfirm(false)
    const handlers = createFsToolHandlers(fn)
    const res = await handlers.run_command({ command: 'echo nope' })
    expect(JSON.stringify(res.content)).toContain('拒绝')
  })

  it('reports nonzero exit codes as errors', async () => {
    const { fn } = makeConfirm(true)
    const handlers = createFsToolHandlers(fn)
    const res = await handlers.run_command({ command: 'cmd /c exit 3', timeout_ms: 10_000 })
    expect(res.isError).toBe(true)
    expect(JSON.stringify(res.content)).toContain('退出码')
  })

  it('kills a stuck command on timeout and returns promptly', async () => {
    const { fn } = makeConfirm(true)
    const handlers = createFsToolHandlers(fn)
    const start = Date.now()
    const res = await handlers.run_command({
      command: 'node -e "setTimeout(()=>{}, 30000)"',
      timeout_ms: 1500
    })
    const elapsed = Date.now() - start
    expect(res.isError).toBe(true)
    expect(JSON.stringify(res.content)).toContain('超时')
    expect(elapsed).toBeLessThan(8000)
  }, 15_000)
})
