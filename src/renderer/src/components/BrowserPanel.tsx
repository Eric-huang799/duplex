import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import type { BrowserDataSnapshot, DownloadRecord, HistoryRecord } from '../../../shared/protocol'
import { filterHistoryByMonth, groupHistoryByDay, listHistoryMonths } from '../../../shared/omnibox'
import { useI18n } from '../i18n'

type Section = 'bookmarks' | 'history' | 'downloads'
type Bookmark = BrowserDataSnapshot['bookmarks'][number]
type BookmarkSort = 'recent' | 'title'

interface Props {
  section: Section
  data: BrowserDataSnapshot
  downloads: DownloadRecord[]
  onClose: () => void
  onNavigate: (url: string) => void
  onRemoveHistory: (url: string, visitedAt: number) => void
  onClearHistory: () => void
  onCancelDownload: (id: string) => void
  onClearDownloads: () => void
  onOpenDownload: (id: string) => void
  onRevealDownload: (id: string) => void
  onRefresh?: () => void
}


/** Never let a dirty record URL crash the whole panel. */
function faviconSrc(url: string, favicon?: string): string | null {
  if (favicon) return favicon
  try {
    return new URL('/favicon.ico', url).href
  } catch {
    return null
  }
}

const chipStyle = (active: boolean): React.CSSProperties => ({
  border: '1px solid var(--line)',
  borderRadius: 999,
  padding: '3px 10px',
  background: active ? 'var(--accent-soft)' : 'transparent',
  color: active ? 'var(--accent)' : 'var(--text-dim)',
  font: 'inherit',
  fontSize: 11,
  cursor: 'pointer'
})

const chipDeleteStyle: React.CSSProperties = {
  border: 0,
  background: 'transparent',
  color: 'var(--text-faint)',
  fontSize: 13,
  lineHeight: 1,
  padding: '0 2px',
  cursor: 'pointer'
}

const dangerBtnStyle: React.CSSProperties = {
  border: 0,
  borderRadius: 6,
  padding: '3px 8px',
  background: 'color-mix(in srgb, var(--err) 14%, transparent)',
  color: 'var(--err)',
  font: 'inherit',
  fontSize: 11,
  cursor: 'pointer'
}

const plainBtnStyle: React.CSSProperties = {
  border: 0,
  borderRadius: 6,
  padding: '3px 8px',
  background: 'transparent',
  color: 'var(--text-dim)',
  font: 'inherit',
  fontSize: 11,
  cursor: 'pointer'
}

const confirmBarStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  border: '1px dashed color-mix(in srgb, var(--err) 40%, transparent)',
  borderRadius: 999,
  padding: '2px 10px',
  color: 'var(--err)',
  fontSize: 11
}

const inputStyle: React.CSSProperties = {
  border: '1px solid var(--line)',
  borderRadius: 8,
  background: 'var(--bg-input)',
  color: 'var(--text-strong)',
  font: 'inherit',
  fontSize: 12,
  padding: '7px 10px',
  outline: 'none',
  userSelect: 'text'
}

const rowFormStyle: React.CSSProperties = {
  flex: 1,
  display: 'flex',
  flexWrap: 'wrap',
  gap: 6,
  alignItems: 'center',
  padding: '8px 0'
}

export function BrowserPanel(props: Props): React.JSX.Element {
  const { t, lang } = useI18n()
  const sectionLabel =
    props.section === 'bookmarks'
      ? t('lib.bookmarks')
      : props.section === 'history'
        ? t('lib.history')
        : t('lib.downloads')
  const [query, setQuery] = useState('')
  const [clearStage, setClearStage] = useState(0)
  const [sort, setSort] = useState<BookmarkSort>('recent')
  const [folderFilter, setFolderFilter] = useState<string | null>(null)
  const [monthFilter, setMonthFilter] = useState('all')
  const [yearFilter, setYearFilter] = useState('all')
  const [hovered, setHovered] = useState<string | null>(null)
  const [newOpen, setNewOpen] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newUrl, setNewUrl] = useState('')
  const [newFolder, setNewFolder] = useState('')
  const [editUrl, setEditUrl] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [editUrlValue, setEditUrlValue] = useState('')
  const [editFolder, setEditFolder] = useState('')
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [folderName, setFolderName] = useState('')
  const [renamingFolder, setRenamingFolder] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [deleteFolderConfirm, setDeleteFolderConfirm] = useState<string | null>(null)
  const confirmTimerRef = useRef<number | null>(null)
  const q = query.trim().toLowerCase()

  const items = useMemo(() => {
    if (props.section === 'history')
      return filterHistoryByMonth(props.data.history.slice().reverse(), monthFilter).filter((x) =>
        `${x.title} ${x.url}`.toLowerCase().includes(q)
      )
    if (props.section === 'downloads')
      return props.downloads.filter((x) => `${x.filename} ${x.url}`.toLowerCase().includes(q))
    return []
  }, [props.section, props.data, props.downloads, q, monthFilter])

  // Chrome-style day/month grouping for the full history page.
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set())
  const historyGroups = useMemo(
    () => (props.section === 'history' ? groupHistoryByDay(items as HistoryRecord[], new Date(), lang) : []),
    [props.section, items, lang]
  )

  // Year/month chips come from the full history so text search never reshuffles them.
  const historyMonths = useMemo(
    () => (props.section === 'history' ? listHistoryMonths(props.data.history, lang) : []),
    [props.section, props.data.history, lang]
  )

  const historyYears = useMemo(
    () => [...new Set(historyMonths.map((m) => m.key.slice(0, 4)))].sort((a, b) => (a < b ? 1 : -1)),
    [historyMonths]
  )

  const renderHistoryRow = (row: HistoryRecord): React.JSX.Element => {
    const when = row.visitedAt
    const icon = faviconSrc(row.url, row.favicon)
    return (
      <article className="library-row" key={`${row.url}-${when}`}>
        <button className="library-row-open" onClick={() => props.onNavigate(row.url)}>
          {icon && <img key={icon} src={icon} onError={(e) => { e.currentTarget.style.visibility = 'hidden' }} />}
          <span className="library-row-main"><strong>{row.title || row.url}</strong><small>{row.url}<i>{new Date(when).toLocaleString()}</i></small></span>
        </button>
        <button className="row-remove" title={t('lib.removeFromHistory')} onClick={() => props.onRemoveHistory(row.url, when)}>×</button>
      </article>
    )
  }

  const bookmarks = useMemo(() => {
    if (props.section !== 'bookmarks') return [] as Bookmark[]
    let list = props.data.bookmarks
    if (folderFilter === '') list = list.filter((b) => !b.folder)
    else if (folderFilter != null) list = list.filter((b) => b.folder === folderFilter)
    const filtered = list.filter((x) => `${x.title} ${x.url}`.toLowerCase().includes(q))
    const sorted = filtered.slice()
    if (sort === 'title') sorted.sort((a, b) => (a.title || a.url).localeCompare(b.title || b.url))
    else sorted.sort((a, b) => b.addedAt - a.addedAt)
    return sorted
  }, [props.section, props.data, folderFilter, q, sort])

  const folderCounts = useMemo(() => {
    const counts = new Map<string, number>()
    let root = 0
    for (const item of props.data.bookmarks) {
      if (item.folder) counts.set(item.folder, (counts.get(item.folder) ?? 0) + 1)
      else root++
    }
    return { counts, root }
  }, [props.data.bookmarks])

  useEffect(() => {
    setClearStage(0)
    setConfirmRemove(null)
    setDeleteFolderConfirm(null)
    setEditUrl(null)
    setNewOpen(false)
    setMonthFilter('all')
  }, [props.section])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') props.onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [props.onClose])

  useEffect(
    () => () => {
      if (confirmTimerRef.current != null) window.clearTimeout(confirmTimerRef.current)
    },
    []
  )

  const toast = (text: string): void => {
    window.dispatchEvent(new CustomEvent('duplex:toast', { detail: text }))
  }

  const [importing, setImporting] = useState(false)
  const [importingLocal, setImportingLocal] = useState(false)

  const refresh = (): void => {
    props.onRefresh?.()
  }

  const armConfirm = (): void => {
    if (confirmTimerRef.current != null) window.clearTimeout(confirmTimerRef.current)
    confirmTimerRef.current = window.setTimeout(() => {
      confirmTimerRef.current = null
      setConfirmRemove(null)
      setDeleteFolderConfirm(null)
    }, 5000)
  }

  const askClear = (run: () => void): void => {
    if (clearStage === 0) {
      setClearStage(1)
      window.setTimeout(() => setClearStage(0), 4000)
      return
    }
    setClearStage(0)
    run()
  }

  const openInNewTab = (url: string): void => {
    void window.cobrowse.tabAction({ type: 'newTab', url })
    props.onClose()
  }

  const openNewForm = (): void => {
    setNewOpen(true)
    setNewTitle('')
    setNewUrl('')
    setNewFolder(folderFilter && folderFilter !== '' ? folderFilter : '')
  }

  const saveNew = async (): Promise<void> => {
    const url = newUrl.trim()
    if (!url) {
      toast(t('lib.enterUrl'))
      return
    }
    const result = await window.cobrowse.bookmarkAdd({
      url,
      title: newTitle.trim() || url,
      folder: newFolder || undefined
    })
    if (!result.ok) {
      toast(result.error || t('lib.newBookmarkFailed'))
      return
    }
    setNewOpen(false)
    toast(t('lib.bookmarkAdded'))
    refresh()
  }

  const runImport = async (): Promise<void> => {
    if (importing) return
    setImporting(true)
    try {
      const result = await window.cobrowse.bookmarkImport()
      if (result.canceled) return
      if (!result.ok) {
        toast(result.error || t('lib.importFailed'))
        return
      }
      const skippedNote = result.skipped ? t('lib.skippedInvalid', { n: result.skipped }) : ''
      toast(t('lib.imported', { n: result.added ?? 0, extra: skippedNote }))
      refresh()
    } finally {
      setImporting(false)
    }
  }

  const runImportLocal = async (): Promise<void> => {
    if (importingLocal) return
    setImportingLocal(true)
    try {
      const result = await window.cobrowse.bookmarkImportLocal()
      if (!result.ok) {
        toast(result.error || t('lib.importLocalFailed'))
        return
      }
      const skippedNote = result.skipped ? t('lib.skippedDuplicate', { n: result.skipped }) : ''
      const src = result.sources?.map((s) => `${s.browser}(${s.count})`).join('、')
      toast(t('lib.imported', { n: result.added ?? 0, extra: skippedNote + (src ? t('lib.sourceSuffix', { src }) : '') }))
      refresh()
    } finally {
      setImportingLocal(false)
    }
  }

  const startEdit = (b: Bookmark): void => {
    setEditUrl(b.url)
    setEditTitle(b.title)
    setEditUrlValue(b.url)
    setEditFolder(b.folder ?? '')
    setConfirmRemove(null)
  }

  const saveEdit = async (originalUrl: string): Promise<void> => {
    const url = editUrlValue.trim()
    if (!url) {
      toast(t('lib.urlRequired'))
      return
    }
    const result = await window.cobrowse.bookmarkUpdate(originalUrl, {
      title: editTitle.trim() || url,
      url,
      folder: editFolder
    })
    if (!result.ok) {
      toast(result.error || t('lib.saveBookmarkFailed'))
      return
    }
    setEditUrl(null)
    refresh()
  }

  const removeBookmark = async (url: string): Promise<void> => {
    setConfirmRemove(null)
    await window.cobrowse.bookmarkRemove(url)
    if (editUrl === url) setEditUrl(null)
    toast(t('lib.bookmarkDeleted'))
    refresh()
  }

  const copyLink = async (url: string): Promise<void> => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable')
      await navigator.clipboard.writeText(url)
      toast(t('lib.linkCopied'))
    } catch {
      toast(t('lib.copyFailed'))
    }
  }

  const commitCreateFolder = async (): Promise<void> => {
    if (!creatingFolder) return
    setCreatingFolder(false)
    const name = folderName.trim()
    if (!name) return
    const result = await window.cobrowse.bookmarkFolderAdd(name)
    if (!result.ok) {
      toast(result.error || t('lib.newFolderFailed'))
      return
    }
    setFolderFilter(name)
    refresh()
  }

  const commitRename = async (oldName: string): Promise<void> => {
    setRenamingFolder(null)
    const name = renameValue.trim()
    if (!name || name === oldName) return
    const result = await window.cobrowse.bookmarkFolderRename(oldName, name)
    if (!result.ok) {
      toast(result.error || t('lib.renameFolderFailed'))
      return
    }
    if (folderFilter === oldName) setFolderFilter(name)
    refresh()
  }

  const confirmDeleteFolder = async (name: string): Promise<void> => {
    setDeleteFolderConfirm(null)
    await window.cobrowse.bookmarkFolderRemove(name)
    if (folderFilter === name) setFolderFilter(null)
    toast(t('lib.folderDeleted'))
    refresh()
  }

  const folderChip = (
    key: string,
    label: string,
    active: boolean,
    onClick: () => void
  ): React.JSX.Element => (
    <button key={key} style={chipStyle(active)} onClick={onClick}>
      {label}
    </button>
  )

  const renderFolderChip = (name: string): React.JSX.Element => {
    if (deleteFolderConfirm === name) {
      return (
        <span key={name} style={confirmBarStyle}>
          <span>{t('lib.deleteFolderConfirm', { name })}</span>
          <button style={dangerBtnStyle} onClick={() => void confirmDeleteFolder(name)}>
            {t('lib.delete')}
          </button>
          <button style={plainBtnStyle} onClick={() => setDeleteFolderConfirm(null)}>
            {t('common.cancel')}
          </button>
        </span>
      )
    }
    if (renamingFolder === name) {
      return (
        <input
          key={name}
          autoFocus
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          style={{ ...inputStyle, padding: '2px 10px', borderRadius: 999 }}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') {
              e.preventDefault()
              void commitRename(name)
            }
            if (e.key === 'Escape') setRenamingFolder(null)
          }}
          onBlur={() => void commitRename(name)}
        />
      )
    }
    return (
      <span key={name} style={{ display: 'inline-flex', alignItems: 'center' }}>
        <button
          style={chipStyle(folderFilter === name)}
          title={t('lib.renamable')}
          onClick={() => setFolderFilter(name)}
          onDoubleClick={() => {
            setRenamingFolder(name)
            setRenameValue(name)
          }}
        >
          {name} ({folderCounts.counts.get(name) ?? 0})
        </button>
        <button
          style={chipDeleteStyle}
          title={t('lib.deleteFolderTitle', { name })}
          onClick={() => {
            setDeleteFolderConfirm(name)
            armConfirm()
          }}
        >
          ×
        </button>
      </span>
    )
  }

  const renderBookmarkRow = (b: Bookmark): React.JSX.Element => {
    if (editUrl === b.url) {
      return (
        <article className="library-row" key={b.url}>
          <form
            style={rowFormStyle}
            onSubmit={(e) => {
              e.preventDefault()
              void saveEdit(b.url)
            }}
          >
            <input
              autoFocus
              style={{ ...inputStyle, flex: '1 1 180px', minWidth: 140 }}
              value={editTitle}
              placeholder={t('lib.titlePlaceholder')}
              onChange={(e) => setEditTitle(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Escape') setEditUrl(null)
              }}
            />
            <input
              style={{ ...inputStyle, flex: '1 1 220px', minWidth: 160 }}
              value={editUrlValue}
              placeholder={t('lib.url')}
              onChange={(e) => setEditUrlValue(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Escape') setEditUrl(null)
              }}
            />
            <select
              style={inputStyle}
              value={editFolder}
              onChange={(e) => setEditFolder(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Escape') setEditUrl(null)
              }}
            >
              <option value="">{t('lib.uncategorized')}</option>
              {props.data.bookmarkFolders.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
            <button type="submit" style={plainBtnStyle}>
              {t('lib.save')}
            </button>
            <button type="button" style={plainBtnStyle} onClick={() => setEditUrl(null)}>
              {t('common.cancel')}
            </button>
          </form>
        </article>
      )
    }
    const icon = faviconSrc(b.url, b.favicon)
    const active = hovered === b.url || confirmRemove === b.url
    return (
      <article
        className="library-row"
        key={b.url}
        onMouseEnter={() => setHovered(b.url)}
        onMouseLeave={() => setHovered((prev) => (prev === b.url ? null : prev))}
      >
        <button
          className="library-row-open"
          title={t('lib.openHint')}
          onClick={(e) => {
            if (e.ctrlKey || e.metaKey) openInNewTab(b.url)
            else props.onNavigate(b.url)
          }}
          onAuxClick={(e) => {
            if (e.button === 1) {
              e.preventDefault()
              openInNewTab(b.url)
            }
          }}
          onMouseDown={(e) => {
            if (e.button === 1) e.preventDefault()
          }}
        >
          {icon && (
            <img
              key={icon}
              src={icon}
              onError={(e) => {
                e.currentTarget.style.visibility = 'hidden'
              }}
            />
          )}
          <span className="library-row-main">
            <strong>{b.title || b.url}</strong>
            <small>
              {b.url}
              <i>{b.folder ?? t('lib.uncategorized')}</i>
              <i>{new Date(b.addedAt).toLocaleString()}</i>
            </small>
          </span>
        </button>
        {active && (
          <div className="library-row-actions">
            {confirmRemove === b.url ? (
              <>
                <button style={{ color: 'var(--err)' }} onClick={() => void removeBookmark(b.url)}>
                  {t('lib.confirmDelete')}
                </button>
                <button onClick={() => setConfirmRemove(null)}>{t('common.cancel')}</button>
              </>
            ) : (
              <>
                <button title={t('lib.openInCurrent')} onClick={() => props.onNavigate(b.url)}>
                  {t('lib.open')}
                </button>
                <button title={t('lib.openInNewTab')} onClick={() => openInNewTab(b.url)}>
                  {t('lib.newTab')}
                </button>
                <button title={t('lib.edit')} onClick={() => startEdit(b)}>
                  {t('lib.edit')}
                </button>
                <button title={t('lib.copyLink')} onClick={() => void copyLink(b.url)}>
                  {t('lib.copy')}
                </button>
                <button
                  title={t('lib.delete')}
                  onClick={() => {
                    setConfirmRemove(b.url)
                    armConfirm()
                  }}
                >
                  {t('lib.delete')}
                </button>
              </>
            )}
          </div>
        )}
      </article>
    )
  }

  const emptyState = q ? (
    <div className="library-empty"><span>⌕</span><strong>{t('lib.noMatch')}</strong><small>{t('lib.tryAnotherKeyword')}</small></div>
  ) : (
    <div className="library-empty"><span>✧</span><strong>{t('lib.emptyHere')}</strong><small>{t('lib.emptyDesc')}</small></div>
  )

  const bookmarkEmpty = q ? (
    <div className="library-empty"><span>⌕</span><strong>{t('lib.noMatch')}</strong><small>{t('lib.tryAnotherKeyword')}</small></div>
  ) : folderFilter != null ? (
    <div className="library-empty"><span>✧</span><strong>{folderFilter === '' ? t('lib.noBookmarksUncategorized') : t('lib.noBookmarksInFolder')}</strong><small>{t('lib.adjustFolderHint')}</small></div>
  ) : (
    <div className="library-empty"><span>✧</span><strong>{t('lib.noBookmarks')}</strong><small>{t('lib.addBookmarkHint')}</small></div>
  )

  return <section className="browser-panel">
    <header className="browser-panel-head">
      <div><span className="panel-eyebrow">DUPLEX LIBRARY</span><h2>{sectionLabel}</h2></div>
      <button className="panel-close" onClick={props.onClose} aria-label={t('common.close')}>×</button>
    </header>
    <label className="library-search"><span>⌕</span><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('lib.searchIn', { label: sectionLabel })} autoFocus /></label>
    {props.section === 'bookmarks' ? (
      <>
        <div className="library-tools">
          <span>{t('lib.items', { n: bookmarks.length })}</span>
          <span style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <button
              title={t('lib.sortToggle')}
              onClick={() => setSort((prev) => (prev === 'recent' ? 'title' : 'recent'))}
            >
              {t('lib.sortBy', { mode: sort === 'recent' ? t('lib.sortRecent') : t('lib.sortTitle') })}
            </button>
            <button onClick={openNewForm}>{t('lib.newBookmark')}</button>
            <button
              title={t('lib.importLocalTitle')}
              disabled={importingLocal}
              onClick={() => void runImportLocal()}
            >
              {importingLocal ? t('lib.reading') : t('lib.importLocal')}
            </button>
            <button
              title={t('lib.importHtmlTitle')}
              disabled={importing}
              onClick={() => void runImport()}
            >
              {importing ? t('lib.importing') : t('lib.importHtml')}
            </button>
          </span>
        </div>
        <div
          style={{
            width: 'min(850px, 100%)',
            margin: '0 auto 8px',
            display: 'flex',
            flexWrap: 'wrap',
            gap: 6,
            alignItems: 'center'
          }}
        >
          {folderChip('all', t('lib.allWithCount', { n: props.data.bookmarks.length }), folderFilter === null, () => setFolderFilter(null))}
          {folderChip('root', t('lib.uncategorizedWithCount', { n: folderCounts.root }), folderFilter === '', () => setFolderFilter(''))}
          {props.data.bookmarkFolders.map((name) => renderFolderChip(name))}
          {creatingFolder ? (
            <input
              autoFocus
              value={folderName}
              placeholder={t('lib.folderName')}
              style={{ ...inputStyle, padding: '2px 10px', borderRadius: 999 }}
              onChange={(e) => setFolderName(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void commitCreateFolder()
                }
                if (e.key === 'Escape') setCreatingFolder(false)
              }}
              onBlur={() => void commitCreateFolder()}
            />
          ) : (
            <button style={chipStyle(false)} onClick={() => { setCreatingFolder(true); setFolderName('') }}>
              {t('lib.newFolder')}
            </button>
          )}
        </div>
        {newOpen && (
          <form
            style={{ ...rowFormStyle, width: 'min(850px, 100%)', margin: '0 auto', borderBottom: '1px solid var(--line-soft)' }}
            onSubmit={(e) => {
              e.preventDefault()
              void saveNew()
            }}
          >
            <input
              autoFocus
              style={{ ...inputStyle, flex: '1 1 180px', minWidth: 140 }}
              value={newTitle}
              placeholder={t('lib.titlePlaceholder')}
              onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Escape') setNewOpen(false)
              }}
            />
            <input
              style={{ ...inputStyle, flex: '2 1 240px', minWidth: 180 }}
              value={newUrl}
              placeholder={t('lib.urlExample')}
              onChange={(e) => setNewUrl(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Escape') setNewOpen(false)
              }}
            />
            <select
              style={inputStyle}
              value={newFolder}
              onChange={(e) => setNewFolder(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Escape') setNewOpen(false)
              }}
            >
              <option value="">{t('lib.uncategorized')}</option>
              {props.data.bookmarkFolders.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
            <button type="submit" style={plainBtnStyle}>
              {t('lib.save')}
            </button>
            <button type="button" style={plainBtnStyle} onClick={() => setNewOpen(false)}>
              {t('common.cancel')}
            </button>
          </form>
        )}
        <div className="library-list">
          {bookmarks.length === 0 ? bookmarkEmpty : bookmarks.map(renderBookmarkRow)}
        </div>
      </>
    ) : (
      <>
        <div className="library-tools">
          <span>{t('lib.items', { n: items.length })}</span>
          {props.section === 'history' && (
            <button className={clearStage > 0 ? 'danger' : ''} onClick={() => askClear(props.onClearHistory)}>
              {clearStage > 0 ? t('lib.clearHistoryConfirm') : t('lib.clearHistory')}
            </button>
          )}
          {props.section === 'downloads' && (
            <button className={clearStage > 0 ? 'danger' : ''} onClick={() => askClear(props.onClearDownloads)}>
              {clearStage > 0 ? t('lib.clearListConfirm') : t('lib.clearList')}
            </button>
          )}
        </div>
        {props.section === 'history' && historyYears.length > 1 && (
          <div className="month-chips year-chips">
            <button
              type="button"
              className={yearFilter === 'all' ? 'on' : ''}
              onClick={() => setYearFilter('all')}
            >
              {t('lib.allYears')}
            </button>
            {historyYears.map((y) => (
              <button
                key={y}
                type="button"
                className={yearFilter === y ? 'on' : ''}
                onClick={() => {
                  setYearFilter(y)
                  setMonthFilter((cur) => (cur !== 'all' && cur.startsWith(y) ? cur : 'all'))
                }}
              >
                {t('lib.year', { y })}
              </button>
            ))}
          </div>
        )}
        {props.section === 'history' && historyMonths.length > 0 && (
          <div className="month-chips">
            <button type="button" className={monthFilter === 'all' ? 'on' : ''} onClick={() => setMonthFilter('all')}>
              {t('lib.all')}
            </button>
            {historyMonths
              .filter((m) => yearFilter === 'all' || m.key.startsWith(yearFilter))
              .map((m) => (
                <button
                  key={m.key}
                  type="button"
                  className={monthFilter === m.key ? 'on' : ''}
                  onClick={() => setMonthFilter(monthFilter === m.key ? 'all' : m.key)}
                >
                  {m.label}
                </button>
              ))}
          </div>
        )}
        <div className="library-list">
          {items.length === 0 ? emptyState : props.section === 'history' ? (
            historyGroups.map((g) => (
              <Fragment key={g.key}>
                <button
                  type="button"
                  className="library-group-head"
                  onClick={() =>
                    setCollapsedGroups((prev) => {
                      const next = new Set(prev)
                      if (next.has(g.key)) next.delete(g.key)
                      else next.add(g.key)
                      return next
                    })
                  }
                >
                  <i>{collapsedGroups.has(g.key) ? '▸' : '▾'}</i>
                  {g.label}
                  <span>{t('lib.records', { n: g.records.length })}</span>
                </button>
                {!collapsedGroups.has(g.key) && g.records.map(renderHistoryRow)}
              </Fragment>
            ))
          ) : items.map((item) => {
            const row = item as DownloadRecord
            const pct = row.totalBytes > 0 ? Math.min(100, Math.round(row.receivedBytes / row.totalBytes * 100)) : 0
            const size = (n: number): string => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`
            return <article className="library-row download-row" key={row.id}>
              <div className="library-file-icon">↓</div><div className="library-row-main"><strong>{row.filename}</strong><small>{row.state === 'progressing' ? `${size(row.receivedBytes)} / ${size(row.totalBytes)}` : row.state === 'completed' ? size(row.totalBytes) : row.state === 'cancelled' ? t('lib.canceled') : t('lib.interrupted')}</small>
                {row.state === 'progressing' && <div className="download-progress"><i style={{ width: `${pct}%` }} /></div>}
              </div><div className="library-row-actions">
                {row.state === 'progressing' ? <button onClick={() => props.onCancelDownload(row.id)}>{t('common.cancel')}</button> : <><button disabled={row.state !== 'completed'} onClick={() => props.onOpenDownload(row.id)}>{t('lib.open')}</button><button onClick={() => props.onRevealDownload(row.id)}>{t('lib.folder')}</button></>}
              </div>
            </article>
          })}
        </div>
      </>
    )}
  </section>
}
