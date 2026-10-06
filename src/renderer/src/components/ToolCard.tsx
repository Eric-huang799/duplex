import type { MirrorToolEvent } from '../../../shared/protocol'
import { ShieldIcon } from './PermissionCard'

const STATUS_ICON: Record<MirrorToolEvent['status'], string> = {
  pending: '⋯',
  running: '◌',
  completed: '✓',
  error: '✗'
}

function summarizeInput(input: unknown): string {
  if (input == null) return ''
  if (typeof input === 'string') return input.slice(0, 80)
  if (typeof input === 'object') {
    const obj = input as Record<string, unknown>
    for (const k of ['description', 'command', 'filePath', 'url', 'pattern', 'query', 'prompt', 'target']) {
      const v = obj[k]
      if (typeof v === 'string' && v) return v.slice(0, 80)
    }
    const s = JSON.stringify(input)
    return s.length > 80 ? s.slice(0, 80) + '…' : s
  }
  return String(input).slice(0, 80)
}

export function ToolCard({
  ev,
  open,
  onToggle,
  waiting = false
}: {
  ev: MirrorToolEvent
  open: boolean
  onToggle: () => void
  waiting?: boolean
}): React.JSX.Element {
  const summary = ev.title || summarizeInput(ev.input)
  return (
    <div className={`toolcard ${ev.status}${waiting ? ' waiting' : ''}`}>
      <div className="toolcard-head" onClick={onToggle}>
        {waiting ? (
          <span className="tool-status">
            <ShieldIcon className="tool-shield" />
          </span>
        ) : (
          <span className="tool-status">{STATUS_ICON[ev.status]}</span>
        )}
        <span className="tool-name">{ev.tool}</span>
        {waiting ? (
          <span className="tool-title">等待你的许可…</span>
        ) : (
          summary && <span className="tool-title">{summary}</span>
        )}
      </div>
      {open && (
        <div className="toolcard-body">
          {ev.input != null && (
            <pre className="tool-io">{JSON.stringify(ev.input, null, 1)}</pre>
          )}
          {ev.output && <pre className="tool-io">{ev.output.slice(0, 2500)}</pre>}
          {ev.error && <pre className="tool-io err">{ev.error.slice(0, 1500)}</pre>}
          {!ev.input && !ev.output && !ev.error && <div className="tool-io dim">（无详情）</div>}
        </div>
      )}
    </div>
  )
}
