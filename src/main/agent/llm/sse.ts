/**
 * Shared SSE transport for LLM streaming clients: sends a streaming POST
 * request, splits `data:` lines and forwards parsed JSON payloads. The idle
 * watchdog lives here so every protocol aborts a stalled stream instead of
 * hanging the agent forever.
 */

export const DEFAULT_IDLE_TIMEOUT_MS = 120_000

export interface SseRequestOptions {
  signal?: AbortSignal
  idleTimeoutMs?: number
  onJson: (payload: Record<string, unknown>) => void
}

export async function sseRequest(
  url: string,
  init: RequestInit,
  opts: SseRequestOptions
): Promise<void> {
  const idleMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
  const ctl = new AbortController()
  let idleTimedOut = false
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  const bump = (): void => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      idleTimedOut = true
      ctl.abort()
    }, idleMs)
  }
  const onOuterAbort = (): void => ctl.abort()
  opts.signal?.addEventListener('abort', onOuterAbort, { once: true })
  bump()

  if (opts.signal?.aborted) {
    throw new Error('已取消')
  }
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`模型接口返回 ${res.status}: ${body.slice(0, 300)}`)
    }
    if (!res.body) throw new Error('模型接口未返回流式响应')

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bump()
      buf += decoder.decode(value, { stream: true })
      if (buf.length > 16 * 1024 * 1024) {
        throw new Error('SSE 响应异常（单行数据超限）')
      }
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        const t = line.trim()
        if (!t.startsWith('data:')) continue
        const payload = t.slice(5).trim()
        if (!payload || payload === '[DONE]') continue
        let json: unknown
        try {
          json = JSON.parse(payload)
        } catch {
          continue
        }
        if (json && typeof json === 'object') opts.onJson(json as Record<string, unknown>)
      }
    }
  } catch (e) {
    if (idleTimedOut) {
      throw new Error(`模型响应超时（${Math.round(idleMs / 1000)} 秒无数据），已中断`)
    }
    throw e
  } finally {
    if (idleTimer) clearTimeout(idleTimer)
    opts.signal?.removeEventListener('abort', onOuterAbort)
    // release the connection if we bail out early (e.g. onJson threw)
    try {
      ctl.abort()
    } catch {
      /* ignore */
    }
  }
}
