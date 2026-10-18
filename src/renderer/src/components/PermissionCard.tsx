import { useEffect, useRef, useState } from 'react'
import { useI18n } from '../i18n'
import type { I18nKey } from '../../../shared/i18n'

type TFn = (key: I18nKey, vars?: Record<string, string | number>) => string

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

function kindLabel(t: TFn, kind: NonNullable<PermissionRequest['kind']>): string {
  if (kind === 'write') return t('permission.kindWrite')
  if (kind === 'script') return t('permission.kindScript')
  return t('permission.kindCommand')
}

function pendingTitle(t: TFn, tool: string | undefined, kind: PermissionRequest['kind']): string {
  if (kind === 'write') return t('permission.requestWrite')
  if (kind === 'script') return t('permission.requestScript')
  if (kind === 'command') return t('permission.requestCommand')
  if (tool === 'write_file') return t('permission.requestWrite')
  if (tool === 'run_skill_script') return t('permission.requestScript')
  return t('permission.requestCommand')
}

function resolvedMeta(
  t: TFn,
  state: Exclude<PermissionState, 'pending'>
): { cls: string; text: string } {
  if (state === 'allowed') return { cls: 'ok', text: t('permission.allowed') }
  if (state === 'denied') return { cls: 'dim', text: t('permission.denied') }
  if (state === 'expired') return { cls: 'dim', text: t('permission.expired') }
  return { cls: 'warn', text: t('permission.stopped') }
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
  const { t } = useI18n()
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
    const meta = resolvedMeta(t, req.state)
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
      aria-label={t('permission.aria', { title: pendingTitle(t, req.tool, req.kind) })}
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
        <span className="permission-title">{pendingTitle(t, req.tool, req.kind)}</span>
        {req.kind && <span className="permission-chip kind">{kindLabel(t, req.kind)}</span>}
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
            {cmdExpanded ? t('permission.collapseCmd') : t('permission.expandCmd')}
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
            {showPreview ? t('permission.collapseContent') : t('permission.showContent')}
          </button>
          {showPreview && <pre className="permission-preview">{req.preview}</pre>}
        </div>
      )}
      {req.cwd && <div className="permission-cwd">{t('permission.cwd', { cwd: req.cwd })}</div>}
      <div className="permission-actions">
        <span className="permission-hint">
          {remaining != null
            ? t('permission.autoReject', { n: remaining })
            : t('permission.escReject')}
        </span>
        <button type="button" className="permission-btn" onClick={() => onRespond(req.id, false)}>
          {t('permission.deny')}
        </button>
        <button
          type="button"
          className="permission-btn primary"
          onClick={() => onRespond(req.id, true)}
        >
          {t('permission.allow')}
        </button>
      </div>
    </div>
  )
}
