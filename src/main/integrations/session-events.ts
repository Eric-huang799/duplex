/** Read only the CLI's startup identity; transcript rendering stays separate. */
export class StartedSessionTracker {
  sessionId: string | undefined
  private line = ''
  private skipping = false
  constructor(private kind: string) {}

  feed(chunk: string): void {
    for (const part of chunk.split(/(?<=\n)/)) {
      if (!this.skipping) this.line += part
      if (this.line.length > 65536) { this.line = ''; this.skipping = true }
      if (!part.endsWith('\n')) continue
      if (!this.skipping && !this.sessionId) {
        try {
          const event = JSON.parse(this.line)
          const id = this.kind === 'codex' && event.type === 'thread.started' ? event.thread_id
            : this.kind === 'claude' && event.type === 'system' && event.subtype === 'init' ? event.session_id : undefined
          if (typeof id === 'string' && id.length > 0 && id.length <= 256) this.sessionId = id
        } catch { /* output unrelated to startup identity */ }
      }
      this.line = ''; this.skipping = false
    }
  }
}
