import { describe, expect, it, vi } from 'vitest'
import { AppUpdater, type UpdaterLike } from '../src/main/updater'

type Listener = (...args: any[]) => void
type CheckResult = { updateInfo?: { version?: string } } | null

/** 用一张监听表模拟 EventEmitter，测试可以直接 emit 事件。 */
function fakeUpdater() {
  const listeners = new Map<string, Listener[]>()
  const checkForUpdates = vi.fn(async (): Promise<CheckResult> => null)
  const quitAndInstall = vi.fn()
  const on = vi.fn((event: string, listener: Listener) => {
    const bucket = listeners.get(event)
    if (bucket) bucket.push(listener)
    else listeners.set(event, [listener])
  })
  const emit = (event: string, ...args: any[]): void => {
    for (const listener of listeners.get(event) ?? []) listener(...args)
  }
  const updater: UpdaterLike = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    checkForUpdates,
    quitAndInstall,
    on
  }
  return { updater, checkForUpdates, quitAndInstall, on, emit }
}

describe('AppUpdater', () => {
  it('未配置 feed：直接 disabled，不加载 updater，check 不发请求', async () => {
    const load = vi.fn(() => {
      throw new Error('feed 关闭时不应该被加载')
    })
    const logs: string[] = []
    const app = new AppUpdater({ feedConfigured: false, load, log: (line) => logs.push(line) })
    expect(app.status()).toEqual({ state: 'disabled' })
    expect(load).not.toHaveBeenCalled()
    expect(logs.join('\n')).toContain('更新源')
    expect(await app.check()).toEqual({ state: 'disabled' })
    expect(load).not.toHaveBeenCalled()
  })

  it('load 返回 null：disabled，日志写明原因，check 不发请求', async () => {
    const load = vi.fn(() => null)
    const logs: string[] = []
    const app = new AppUpdater({ feedConfigured: true, load, log: (line) => logs.push(line) })
    expect(app.status()).toEqual({ state: 'disabled' })
    expect(load).toHaveBeenCalledTimes(1)
    expect(logs.join('\n')).toContain('不支持')
    expect(await app.check()).toEqual({ state: 'disabled' })
  })

  it('接管 updater：开启自动下载/退出安装，并订阅三类事件', () => {
    const { updater: fake, on } = fakeUpdater()
    new AppUpdater({ feedConfigured: true, load: () => fake })
    expect(fake.autoDownload).toBe(true)
    expect(fake.autoInstallOnAppQuit).toBe(true)
    const events = on.mock.calls.map((call) => call[0])
    expect(events).toEqual(expect.arrayContaining(['update-available', 'update-downloaded', 'error']))
  })

  it('check 成功但没有更新事件：none', async () => {
    const { updater: fake, checkForUpdates } = fakeUpdater()
    checkForUpdates.mockResolvedValue({ updateInfo: { version: '0.3.0' } })
    const app = new AppUpdater({ feedConfigured: true, load: () => fake })
    expect(await app.check()).toEqual({ state: 'none' })
    expect(checkForUpdates).toHaveBeenCalledTimes(1)
  })

  it('check 期间收到 update-available：available 并记录版本号', async () => {
    const { updater: fake, checkForUpdates, emit } = fakeUpdater()
    checkForUpdates.mockImplementation(async () => {
      emit('update-available', { version: '0.4.0' })
      return { updateInfo: { version: '0.4.0' } }
    })
    const app = new AppUpdater({ feedConfigured: true, load: () => fake })
    expect(await app.check()).toEqual({ state: 'available', version: '0.4.0' })
  })

  it('update-downloaded 后 ready，install 调用一次 quitAndInstall', () => {
    const { updater: fake, quitAndInstall, emit } = fakeUpdater()
    const app = new AppUpdater({ feedConfigured: true, load: () => fake })
    emit('update-downloaded', { version: '0.4.0' })
    expect(app.status()).toEqual({ state: 'ready', version: '0.4.0' })
    expect(app.install()).toBe(true)
    expect(quitAndInstall).toHaveBeenCalledTimes(1)
  })

  it('未 ready 时 install 返回 false 且不调用 quitAndInstall', () => {
    const { updater: fake, quitAndInstall, emit } = fakeUpdater()
    const app = new AppUpdater({ feedConfigured: true, load: () => fake })
    expect(app.install()).toBe(false)
    emit('update-available', { version: '0.4.0' })
    expect(app.status().state).toBe('available')
    expect(app.install()).toBe(false)
    expect(quitAndInstall).not.toHaveBeenCalled()
  })

  it('quitAndInstall 抛错时 install 返回 false 并进入 error', () => {
    const { updater: fake, quitAndInstall, emit } = fakeUpdater()
    quitAndInstall.mockImplementation(() => {
      throw new Error('安装器启动失败')
    })
    const app = new AppUpdater({ feedConfigured: true, load: () => fake })
    emit('update-downloaded', { version: '0.4.0' })
    expect(app.install()).toBe(false)
    expect(app.status().state).toBe('error')
    expect(app.status().error).toContain('安装器启动失败')
  })

  it('check 失败归一成 error，不抛', async () => {
    const { updater: fake, checkForUpdates } = fakeUpdater()
    checkForUpdates.mockRejectedValue(new Error('feed 404'))
    const app = new AppUpdater({ feedConfigured: true, load: () => fake })
    const status = await app.check()
    expect(status.state).toBe('error')
    expect(status.error).toContain('feed 404')
  })

  it('error 事件写入 status，监听本身不抛', () => {
    const { updater: fake, emit } = fakeUpdater()
    const app = new AppUpdater({ feedConfigured: true, load: () => fake })
    expect(() => emit('error', new Error('签名校验失败'))).not.toThrow()
    const status = app.status()
    expect(status.state).toBe('error')
    expect(status.error).toContain('签名校验失败')
  })

  it('load 抛错时构造不抛，状态归一成 error', () => {
    const create = (): AppUpdater =>
      new AppUpdater({
        feedConfigured: true,
        load: () => {
          throw new Error('electron-updater 未安装')
        }
      })
    expect(create).not.toThrow()
    const status = create().status()
    expect(status.state).toBe('error')
    expect(status.error).toContain('electron-updater 未安装')
  })
})
