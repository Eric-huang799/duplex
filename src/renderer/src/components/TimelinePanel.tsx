import { useCallback, useEffect, useState } from 'react'
import { useI18n } from '../i18n'
import './timeline.css'

interface Entry {
  ts: number
  kind: string
  tabId?: number
  name?: string
  ok?: boolean
  detail?: string
}

/**
 * AI 操作时间线面板：把 `~/.cobrowse/timeline.jsonl` 的最近记录列出来，并支持导出。
 *
 * 这是"可回看、可审计"的落点——信任不是靠承诺，而是靠能查到 AI 到底点了什么。
 */
export function TimelinePanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const { t } = useI18n()
  const [entries, setEntries] = useState<Entry[]>([])
  const [note, setNote] = useState('')

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setEntries(await window.cobrowse.timelineRecent(120))
    } catch {
      setEntries([])
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const exportMarkdown = async (): Promise<void> => {
    const result = await window.cobrowse.timelineExport()
    setNote(
      result.ok && result.file
        ? t('timeline.exported', { path: result.file })
        : t('timeline.failed', { err: result.error ?? '?' })
    )
  }

  return (
    <div className="tlp">
      <div className="tlp-head">
        <span className="tlp-title">{t('timeline.title')}</span>
        <span className="tlp-actions">
          <button className="tlp-btn ghost" title="refresh" onClick={() => void refresh()}>
            ↻
          </button>
          <button className="tlp-btn" onClick={() => void exportMarkdown()}>
            {t('timeline.export')}
          </button>
          <button className="tlp-btn" onClick={onClose}>
            ✕
          </button>
        </span>
      </div>

      {note && <div className="tlp-note">{note}</div>}

      {entries.length === 0 ? (
        <div className="tlp-empty">{t('timeline.empty')}</div>
      ) : (
        <div className="tlp-list">
          {entries.map((entry, i) => (
            <div className="tlp-row" key={`${entry.ts}-${i}`}>
              <span className="tlp-time">{new Date(entry.ts).toLocaleTimeString()}</span>
              <span className={`tlp-kind ${entry.kind}`}>
                {entry.kind === 'tool' ? (entry.name ?? 'tool') : entry.kind}
              </span>
              <span className={entry.ok === false ? 'tlp-res bad' : 'tlp-res'}>
                {entry.ok == null ? (entry.detail ?? '') : entry.ok ? '✓' : `✗ ${entry.detail ?? ''}`}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
