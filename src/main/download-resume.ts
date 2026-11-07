/**
 * 跨重启续传引擎。
 *
 * Chromium 的 `DownloadItem.resume()` 只在同一进程内有效；应用退出后未完成的
 * 下载就作废。这里用 `Range` 请求把剩下的字节续到临时文件，完成后改名成目标文件。
 *
 * 两个必须注意的点：
 *  - **走 Electron 的 `net`**，不是 Node 的 `http/https`。`net` 跟随系统代理；
 *    本机不启用代理根本到不了外网（这也是 ChatGPT 卡顿那条问题的根因）。
 *  - **服务端可能不理 Range**（返回 200）：那种情况只能从头下，这里直接覆盖临时
 *    文件重写，而不是把整份内容追加到半截后面造成文件损坏。
 */
import fs from 'node:fs'
import path from 'node:path'
import { net } from 'electron'
import type { PartialMeta } from './download-partials'

export interface ResumeResult {
  ok: boolean
  error?: string
  /** 服务端不支持分段，已改为整份重下。 */
  restarted?: boolean
}

function statSize(file: string): number {
  try {
    const stat = fs.statSync(file)
    return stat.isFile() ? stat.size : 0
  } catch {
    return 0
  }
}

export async function resumePartial(
  meta: PartialMeta,
  onProgress: (received: number) => void = () => undefined
): Promise<ResumeResult> {
  const offset = statSize(meta.temp)
  if (offset <= 0) return { ok: false, error: '临时文件不存在或为空' }
  if (meta.totalBytes > 0 && offset >= meta.totalBytes) {
    // 数据已齐，只是没来得及改名
    try {
      fs.renameSync(meta.temp, meta.target)
      return { ok: true }
    } catch (error) {
      return { ok: false, error: (error as Error)?.message ?? 'rename failed' }
    }
  }

  return new Promise<ResumeResult>((resolve) => {
    let settled = false
    const finish = (result: ResumeResult): void => {
      if (settled) return
      settled = true
      resolve(result)
    }

    let request: Electron.ClientRequest
    try {
      request = net.request({
        method: 'GET',
        url: meta.url,
        redirect: 'follow'
      })
    } catch (error) {
      finish({ ok: false, error: (error as Error)?.message ?? 'request failed' })
      return
    }

    request.setHeader('Range', `bytes=${offset}-`)
    // 文件变了就不能续：服务端据此返回 200 全量
    if (meta.etag) request.setHeader('If-Range', meta.etag)
    else if (meta.lastModified) request.setHeader('If-Range', meta.lastModified)

    request.on('response', (response) => {
      const status = response.statusCode
      const partial = status === 206
      if (status !== 206 && status !== 200) {
        response.on('error', () => undefined)
        finish({ ok: false, error: `服务器返回 ${status}` })
        return
      }
      // 200 = 服务端忽略了 Range：丢弃已下载的部分，整份重写
      const stream = fs.createWriteStream(meta.temp, { flags: partial ? 'a' : 'w' })
      let received = partial ? offset : 0
      response.on('data', (chunk: Buffer) => {
        received += chunk.length
        onProgress(received)
      })
      // Electron 的 IncomingMessage 类型里没有 pipe，但运行时就是 Readable；
      // 用 pipe 才能保留背压，避免大文件把内存吃满。
      const source = response as unknown as NodeJS.ReadableStream
      source.pipe(stream)
      stream.on('error', (error) => finish({ ok: false, error: error.message }))
      stream.on('finish', () => {
        try {
          fs.renameSync(meta.temp, meta.target)
          finish(partial ? { ok: true } : { ok: true, restarted: true })
        } catch (error) {
          finish({ ok: false, error: (error as Error)?.message ?? 'rename failed' })
        }
      })
      response.on('error', (error: Error) => finish({ ok: false, error: error.message }))
    })

    request.on('error', (error) => finish({ ok: false, error: error.message }))
    request.end()
  })
}

/** 下到一半时 Chromium 留下的 `.crdownload` 改名成我们自己的临时文件。 */
export function adoptChromiumPartial(target: string, id: string): string | null {
  const chromiumTemp = `${target}.crdownload`
  if (statSize(chromiumTemp) <= 0) return null
  const ours = path.join(path.dirname(target), `.${path.basename(target)}.${id}.duplexpart`)
  try {
    fs.renameSync(chromiumTemp, ours)
    return ours
  } catch {
    return null
  }
}
