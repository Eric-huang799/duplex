/**
 * Shared SSE transport for LLM streaming clients: sends a streaming POST
 * request, merges multi-line `data:` events and forwards parsed JSON
 * payloads. HTTP/network failures are translated into actionable Chinese
 * messages (original text kept in parentheses). The idle watchdog lives here
 * so every protocol aborts a stalled stream instead of hanging the agent
 * forever.
 */

export const DEFAULT_IDLE_TIMEOUT_MS = 120_000

export interface SseRequestOptions {
  signal?: AbortSignal
  idleTimeoutMs?: number
  onJson: (payload: Record<string, unknown>) => void
  /**
   * Protocol-specific completion marker (e.g. `message_stop`). `[DONE]` is
   * always recognized. When the stream ends without any marker we log to
   * stderr — the response may have been truncated mid-flight.
   */
  isCompletionEvent?: (payload: Record<string, unknown>) => boolean
}

/** Chinese attribution for an HTTP status, based on the common failure modes. */
function httpStatusHint(status: number): string {
  if (status === 401 || status === 403) return '凭据无效或无权访问'
  if (status === 404) return 'Base URL 或模型名不存在'
  if (status === 429) return '请求被限流，请稍后重试'
  if (status >= 500) return '服务端错误'
  return '请求失败'
}

/** Best-effort one-line description of a fetch/socket failure (cause included). */
function errorDetail(e: unknown): string {
  if (!(e instanceof Error)) return String(e)
  const cause = (e as { cause?: unknown }).cause
  if (cause instanceof Error) {
    const code = (cause as NodeJS.ErrnoException).code
    return code ? `${e.message} (${code})` : `${e.message}: ${cause.message}`
  }
  if (typeof cause === 'string' && cause) return `${e.message} (${cause})`
  return e.message
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

  const timeoutError = (): Error =>
    new Error(`模型响应超时（${Math.round(idleMs / 1000)} 秒无数据），已中断`)

  try {
    let res: Response
    try {
      res = await fetch(url, { ...init, signal: ctl.signal })
    } catch (e) {
      if (idleTimedOut) throw timeoutError()
      if (opts.signal?.aborted) throw e
      throw new Error(`连接失败，请检查网络或代理（${errorDetail(e)}）`)
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(
        `模型接口错误：${httpStatusHint(res.status)}（HTTP ${res.status}: ${body.slice(0, 300)}）`
      )
    }
    if (!res.body) throw new Error('模型接口未返回流式响应')

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    let dataLines: string[] = []
    let sawCompletion = false

    // SSE spec: multiple `data:` lines in one event are joined with '\n' and
    // dispatched on a blank line. Many LLM gateways (and simple mock streams)
    // omit the blank separator, so a data line that already forms complete
    // JSON is dispatched immediately instead of waiting.
    const payloadComplete = (payload: string): boolean => {
      if (payload === '[DONE]') return true
      try {
        const v = JSON.parse(payload) as unknown
        return !!v && typeof v === 'object'
      } catch {
        return false
      }
    }

    const dispatch = (): void => {
      if (dataLines.length === 0) return
      const payload = dataLines.join('\n').trim()
      dataLines = []
      if (!payload) return
      if (payload === '[DONE]') {
        sawCompletion = true
        return
      }
      let json: unknown
      try {
        json = JSON.parse(payload)
      } catch {
        return
      }
      if (!json || typeof json !== 'object') return
      if (opts.isCompletionEvent?.(json as Record<string, unknown>)) sawCompletion = true
      opts.onJson(json as Record<string, unknown>)
    }

    const processLine = (rawLine: string): void => {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
      if (line === '') {
        dispatch()
        return
      }
      if (!line.startsWith('data:')) return
      if (dataLines.length > 0 && payloadComplete(dataLines.join('\n').trim())) {
        dispatch()
      }
      const value = line.slice(5)
      dataLines.push(value.startsWith(' ') ? value.slice(1) : value)
    }

    for (;;) {
      let read: { done: boolean; value?: Uint8Array }
      try {
        read = await reader.read()
      } catch (e) {
        if (idleTimedOut) throw timeoutError()
        if (opts.signal?.aborted) throw e
        throw new Error(`连接失败，请检查网络或代理（${errorDetail(e)}）`)
      }
      if (read.done) break
      bump()
      buf += decoder.decode(read.value, { stream: true })
      if (buf.length > 16 * 1024 * 1024) {
        throw new Error('SSE 响应异常（单行数据超限）')
      }
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) processLine(line)
    }
    // flush a final event that never got its trailing blank line
    if (buf) processLine(buf)
    dispatch()
    if (!sawCompletion) {
      console.error(
        `[llm] SSE 流在未收到完成标记（[DONE]/完成事件）的情况下结束，响应可能被截断（${url}）`
      )
    }
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
