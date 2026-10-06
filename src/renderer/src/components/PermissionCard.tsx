import { useEffect, useRef } from 'react'

export type PermissionState = 'pending' | 'allowed' | 'denied' | 'expired' | 'stopped'

export interface PermissionRequest {
  id: number
  command: string
  cwd: string
  skill: string
  tool?: string
  state: PermissionState
}

export function ShieldIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3 5 6v5c0 4.4 3 8.2 7 9.5 4-1.3 7-5.1 7-9.5V6l-7-3Z" />
      <path d="M9.2 12.2l2 2 3.6-4" />
    </svg>
  )
}

function pendingTitle(tool: string | undefined): string {
  if (tool === 'write_file') return 'AI 请求写入文件'
  if (tool === 'run_skill_script') return 'AI 请求运行脚本'
  return 'AI 请求执行命令'
}

const RESOLVED: Record<
  Exclude<PermissionState, 'pending'>,
  { cls: string; text: string }
> = {
  allowed: { cls: 'ok', text: '已允许执行' },
  denied: { cls: 'dim', text: '已拒绝' },
  expired: { cls: 'dim', text: '超时未确认 · 已自动拒绝' },
  stopped: { cls: 'warn', text: '已急停 · 自动拒绝' }
}

function firstLine(text: string): string {
  const line = text.split('\n')[0] ?? ''
  return line.length > 72 ? `${line.slice(0, 72)}…` : line
}

export function PermissionCard({
  req,
  onRespond
}: {
  req: PermissionRequest
  onRespond: (id: number, ok: boolean) => void
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const isPending = req.state === 'pending'

  useEffect(() => {
    if (!isPending) return
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    ref.current?.scrollIntoView({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' })
    // only when this card first appears as pending
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (req.state !== 'pending') {
    const meta = RESOLVED[req.state]
    return (
      <div className={`permission-card resolved ${meta.cls}`}>
        <ShieldIcon className="permission-shield" />
        <span className="permission-state">{meta.text}</span>
        <span className="permission-summary">{firstLine(req.command)}</span>
      </div>
    )
  }

  return (
    <div
      className="permission-card pending"
      role="group"
      aria-label={`权限请求：${pendingTitle(req.tool)}，等待你的许可`}
      ref={ref}
    >
      <div className="permission-head">
        <ShieldIcon className="permission-shield" />
        <span className="permission-title">{pendingTitle(req.tool)}</span>
        {req.tool && <span className="permission-chip">{req.tool}</span>}
      </div>
      <pre className="permission-cmd">{req.command}</pre>
      {req.cwd && <div className="permission-cwd">工作目录 · {req.cwd}</div>}
      <div className="permission-actions">
        <button type="button" className="permission-btn" onClick={() => onRespond(req.id, false)}>
          拒绝
        </button>
        <button
          type="button"
          className="permission-btn primary"
          onClick={() => onRespond(req.id, true)}
        >
          允许执行
        </button>
      </div>
    </div>
  )
}
