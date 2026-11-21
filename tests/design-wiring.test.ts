import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { findNode } from '../src/shared/design/model'
import { createDesignWiring, type DesignWiring } from '../src/main/design-wiring'
import { removeTestDir } from './fs-cleanup'

const electron = vi.hoisted(() => {
  const listeners = new Map<string, (...args: unknown[]) => void>()
  return {
    listeners,
    ipcMain: {
      on(channel: string, listener: (...args: unknown[]) => void) {
        listeners.set(channel, listener)
      },
      removeAllListeners(channel: string) {
        listeners.delete(channel)
      },
      handle() {},
      removeHandler() {}
    }
  }
})

vi.mock('electron', () => ({
  ipcMain: electron.ipcMain,
  dialog: { showSaveDialog: async () => ({ canceled: true }) }
}))

interface SentMessage {
  type?: string
  actor?: string
  ops?: unknown[]
  doc?: unknown
}

let root: string
let previousDataDir: string | undefined
let wiring: DesignWiring | null
let sent: SentMessage[]

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'design-wiring-'))
  previousDataDir = process.env['DUPLEX_DATA_DIR']
  process.env['DUPLEX_DATA_DIR'] = root
  sent = []
  const canvas = {
    isDestroyed: () => false,
    send: (_channel: string, payload: SentMessage) => sent.push(payload)
  }
  wiring = createDesignWiring({
    win: () => null,
    log: () => undefined,
    caller: () => 'agent-test',
    openCanvas: () => canvas as never
  })
  electron.listeners.get('design:canvas-ready')?.({ sender: canvas })
  sent = []
})

afterEach(() => {
  wiring?.dispose()
  wiring = null
  electron.listeners.clear()
  if (previousDataDir === undefined) delete process.env['DUPLEX_DATA_DIR']
  else process.env['DUPLEX_DATA_DIR'] = previousDataDir
  removeTestDir(root)
})

describe('设计画布主进程接线', () => {
  it('部分 patch 被拒时只发布最终文档一次，不重放原始 ops', () => {
    electron.listeners.get('design:canvas-msg')?.({}, {
      type: 'user-ops',
      ops: [
        { op: 'insert', parentId: 'root', node: { id: 'accepted', type: 'box' } },
        { op: 'remove', targetId: 'missing' }
      ]
    })

    expect(findNode(wiring!.service.current().root, 'accepted')).not.toBeNull()
    expect(sent.filter((message) => message.type === 'document')).toHaveLength(1)
    expect(sent.filter((message) => message.type === 'patch')).toHaveLength(0)
    expect(sent.filter((message) => message.type === 'state')).toHaveLength(1)
  })

  it('agent patch 只发布一次文档和一次带真实 actor 的状态', async () => {
    const result = await wiring!.runTool('design_patch', {
      ops: [{ op: 'insert', parentId: 'root', node: { id: 'from-agent', type: 'box' } }]
    })

    expect(result.isError).not.toBe(true)
    expect(sent.filter((message) => message.type === 'document')).toHaveLength(1)
    expect(sent.filter((message) => message.type === 'state')).toEqual([
      expect.objectContaining({ type: 'state', actor: 'agent-test' })
    ])
  })

  it('非法 projectId 返回工具错误，不抛出且不破坏当前项目', async () => {
    const before = wiring!.service.current()
    const result = await wiring!.runTool('design_patch', { projectId: '../escape', ops: [] })

    expect(result.isError).toBe(true)
    expect(wiring!.service.current()).toBe(before)
    expect(wiring!.service.state().projectId).toBe('design-1')
  })
})
