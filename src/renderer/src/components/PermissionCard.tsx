import { useEffect, useRef, useState } from 'react'

export type PermissionState = 'pending' | 'allowed' | 'denied' | 'expired' | 'stopped'

export interface PermissionRequest {
  id: number
  command: string
  cwd: string
  skill: string
  tool?: string
  kind?: 'write' | 'command' | 'script'
  preview?: string
  state: PermissionState
  /** Optional absolute deadline (epoch ms) supplied by the main process. */
  expiresAt?: number
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

const KIND_LABEL: Record<NonNullable<PermissionRequest['kind']>, string> = {
  write: '写入文件',
  command: '执行命令',
  script: '运行脚本'
}

function pendingTitle(tool: string | undefined, kind: PermissionRequest['kind']): string {
  if (kind === 'write') return 'AI 请求写入文件'
  if (kind === 'script') return 'AI 请求运行脚本'
  if (kind === 'command') return 'AI 请求执行命令'
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
  const [cmdExpanded, setCmdExpanded] = useState(false)
  const [showPreview, setShowPreview] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const isPending = req.state === 'pending'
  const expiresAt = req.expiresAt

  useEffect(() => {
    if (!isPending) return
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    ref.current?.scrollIntoView({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' })
    // only when this card first appears as pending
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!isPending || !expiresAt) return
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [isPending, expiresAt])

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

  const cmdLong = req.command.length > 120 || req.command.split('\n').length > 3
  const remaining = expiresAt ? Math.max(0, Math.ceil((expiresAt - now) / 1000)) : null

  return (
    <div
      className="permission-card pending"
      role="group"
      aria-label={`权限请求：${pendingTitle(req.tool, req.kind)}，等待你的许可`}
      tabIndex={0}
      ref={ref}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          onRespond(req.id, false)
        }
      }}
    >
      <div className="permission-head">
        <ShieldIcon className="permission-shield" />
        <span className="permission-title">{pendingTitle(req.tool, req.kind)}</span>
        {req.kind && <span className="permission-chip kind">{KIND_LABEL[req.kind]}</span>}
        {req.tool && <span className="permission-chip">{req.tool}</span>}
      </div>
      <div className="permission-cmd-wrap">
        <pre className={`permission-cmd${cmdExpanded ? ' expanded' : ''}`}>{req.command}</pre>
        {cmdLong && (
          <button
            type="button"
            className="permission-more"
            onClick={() => setCmdExpanded((v) => !v)}
          >
            {cmdExpanded ? '收起全文' : '展开全文'}
          </button>
        )}
      </div>
      {req.preview != null && req.preview !== '' && (
        <div className="permission-preview-wrap">
          <button
            type="button"
            className="permission-more"
            onClick={() => setShowPreview((v) => !v)}
          >
            {showPreview ? '收起内容' : '查看内容'}
          </button>
          {showPreview && <pre className="permission-preview">{req.preview}</pre>}
        </div>
      )}
      {req.cwd && <div className="permission-cwd">工作目录 · {req.cwd}</div>}
      <div className="permission-actions">
        <span className="permission-hint">
          {remaining != null
            ? `剩余 ${remaining} 秒自动拒绝 · 按 Esc 快速拒绝`
            : '按 Esc 快速拒绝'}
        </span>
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
