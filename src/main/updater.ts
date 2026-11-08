/**
 * 应用内自动更新的最小包装。
 *
 * 为什么依赖注入而不是直接 import electron-updater：后者是运行时依赖，开发构建、
 * 未配置发布源的构建、以及缺包的机器上都可能拿不到。把接口收窄成 UpdaterLike 后，
 * 主进程可以在启动时用 load() 决定"有没有"，单测也能模拟事件与失败而不联网。
 *
 * 本模块不 import electron-updater / electron，保持纯逻辑。
 */

export interface UpdaterLike {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  checkForUpdates(): Promise<{ updateInfo?: { version?: string } } | null>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
  on(event: string, listener: (...args: any[]) => void): void
}

export interface UpdateStatus {
  /** idle | checking | available | downloading | ready | none | error | disabled */
  state: string
  version?: string
  error?: string
}

export interface UpdaterDeps {
  /** 返回注入的 updater；返回 null 表示当前环境不支持（例如未配置 feed 的开发构建）。 */
  load: () => UpdaterLike | null
  /** 是否有可用的更新源（生产由主进程传 false 关闭）。 */
  feedConfigured: boolean
  log?: (message: string) => void
}

function versionOf(info: unknown): string | undefined {
  if (!info || typeof info !== 'object') return undefined
  const value = (info as { version?: unknown }).version
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string' && error.trim()) return error.trim()
  return '未知错误'
}

export class AppUpdater {
  private readonly log: (message: string) => void
  private updater: UpdaterLike | null = null
  private current: UpdateStatus = { state: 'idle' }

  constructor(private readonly deps: UpdaterDeps) {
    this.log = deps.log ?? (() => {})
    this.init()
  }

  private init(): void {
    if (!this.deps.feedConfigured) {
      this.current = { state: 'disabled' }
      this.log('[updater] 没有配置更新源（feed），自动更新关闭')
      return
    }
    let loaded: UpdaterLike | null
    try {
      loaded = this.deps.load()
    } catch (error) {
      // 缺包 / 打包漏文件是启动期错误，不能让它把主进程带崩
      this.setError(`加载 electron-updater 失败：${describeError(error)}`)
      return
    }
    if (!loaded) {
      this.current = { state: 'disabled' }
      this.log('[updater] 当前环境不支持自动更新（未安装 electron-updater 或未配置发布源），已关闭')
      return
    }
    this.updater = loaded
    try {
      // 后台先下好：用户点「重启并更新」时才有现成的包；
      // 退出时自动装上，避免用户永远停在下载当天的版本。
      loaded.autoDownload = true
      loaded.autoInstallOnAppQuit = true
      this.listen(loaded)
    } catch (error) {
      this.updater = null
      this.setError(`初始化自动更新失败：${describeError(error)}`)
    }
  }

  private listen(updater: UpdaterLike): void {
    updater.on('update-available', (info: unknown) => {
      const version = versionOf(info)
      this.current = version ? { state: 'available', version } : { state: 'available' }
      this.log(`[updater] 发现新版本：${version ?? '版本未知'}`)
    })
    updater.on('update-downloaded', (info: unknown) => {
      const version = versionOf(info)
      this.current = version ? { state: 'ready', version } : { state: 'ready' }
      this.log(`[updater] 新版本 ${version ?? ''} 已下载，等待重启安装`)
    })
    updater.on('error', (error: unknown) => {
      this.setError(`更新出错：${describeError(error)}`)
    })
  }

  private setError(message: string): void {
    this.current = { state: 'error', error: message }
    this.log(`[updater] ${message}`)
  }

  status(): UpdateStatus {
    // 返回副本：调用方拿到的状态不应该能反向改掉内部状态机
    return { ...this.current }
  }

  /** 启动后延迟调用；失败不抛，写入 status。 */
  async check(): Promise<UpdateStatus> {
    const updater = this.updater
    if (!updater) {
      // disabled / 加载失败：只回状态，绝不发请求
      this.log('[updater] 跳过检查：自动更新不可用')
      return this.status()
    }
    if (this.current.state === 'ready' || this.current.state === 'downloading') {
      // 已经下载/正在下载时再查一次只会把界面状态打回上一个阶段
      return this.status()
    }
    this.current = { state: 'checking' }
    this.log('[updater] 检查更新…')
    try {
      await updater.checkForUpdates()
      // update-available / update-downloaded / error 事件会先改写状态；
      // 仍是 checking 才说明这次检查没有发现更新。
      // 注意不能用 resolve 出来的 updateInfo.version 判断：electron-updater
      // 无论有没有新版本都会返回"线上最新版本号"（无更新时等于当前版本）。
      if (this.current.state === 'checking') {
        this.current = { state: 'none' }
        this.log('[updater] 已是最新版本')
      }
    } catch (error) {
      this.setError(`检查更新失败：${describeError(error)}`)
    }
    return this.status()
  }

  /** 用户点"重启并更新"。没有 ready 状态时返回 false。 */
  install(): boolean {
    const updater = this.updater
    if (!updater || this.current.state !== 'ready') {
      this.log('[updater] 忽略安装请求：还没有下载完成的更新')
      return false
    }
    try {
      this.log('[updater] 重启并安装更新')
      updater.quitAndInstall()
      return true
    } catch (error) {
      this.setError(`启动更新安装失败：${describeError(error)}`)
      return false
    }
  }
}
