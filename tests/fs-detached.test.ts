import { describe, expect, it } from 'vitest'
import { isDetachedCommand } from '../src/main/agent/fs-tools'

describe('后台服务命令识别', () => {
  it('识别 Windows 的 start / Start-Process 启动方式', () => {
    expect(isDetachedCommand('start "" /min C:\\python.exe -m http.server 8765')).toBe(true)
    expect(isDetachedCommand('start /b node server.js')).toBe(true)
    expect(isDetachedCommand('Start-Process python -ArgumentList "-m","http.server"')).toBe(true)
  })

  it('普通命令仍然等待完成', () => {
    expect(isDetachedCommand('python -m http.server 8765')).toBe(false)
    expect(isDetachedCommand('node server.js &')).toBe(false)
    expect(isDetachedCommand('where python')).toBe(false)
    expect(isDetachedCommand('')).toBe(false)
  })
})
