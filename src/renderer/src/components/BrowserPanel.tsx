import { useEffect, useMemo, useRef, useState } from 'react'
import type { BrowserDataSnapshot, DownloadRecord } from '../../../shared/protocol'

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

const titles: Record<Section, string> = { bookmarks: '书签', history: '浏览记录', downloads: '下载' }

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
  const [query, setQuery] = useState('')
  const [clearStage, setClearStage] = useState(0)
  const [sort, setSort] = useState<BookmarkSort>('recent')
  const [folderFilter, setFolderFilter] = useState<string | null>(null)
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
      return props.data.history.slice().reverse().filter((x) => `${x.title} ${x.url}`.toLowerCase().includes(q))
    if (props.section === 'downloads')
      return props.downloads.filter((x) => `${x.filename} ${x.url}`.toLowerCase().includes(q))
    return []
  }, [props.section, props.data, props.downloads, q])

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
      toast('请输入网址')
      return
    }
    const result = await window.cobrowse.bookmarkAdd({
      url,
      title: newTitle.trim() || url,
      folder: newFolder || undefined
    })
    if (!result.ok) {
      toast(result.error || '新建书签失败')
      return
    }
    setNewOpen(false)
    toast('已添加书签')
    refresh()
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
      toast('网址不能为空')
      return
    }
    const result = await window.cobrowse.bookmarkUpdate(originalUrl, {
      title: editTitle.trim() || url,
      url,
      folder: editFolder
    })
    if (!result.ok) {
      toast(result.error || '保存书签失败')
      return
    }
    setEditUrl(null)
    refresh()
  }

  const removeBookmark = async (url: string): Promise<void> => {
    setConfirmRemove(null)
    await window.cobrowse.bookmarkRemove(url)
    if (editUrl === url) setEditUrl(null)
    toast('书签已删除')
    refresh()
  }

  const copyLink = async (url: string): Promise<void> => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable')
      await navigator.clipboard.writeText(url)
      toast('已复制链接')
    } catch {
      toast('复制失败，请手动复制')
    }
  }

  const commitCreateFolder = async (): Promise<void> => {
    if (!creatingFolder) return
    setCreatingFolder(false)
    const name = folderName.trim()
    if (!name) return
    const result = await window.cobrowse.bookmarkFolderAdd(name)
    if (!result.ok) {
      toast(result.error || '新建文件夹失败')
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
      toast(result.error || '重命名文件夹失败')
      return
    }
    if (folderFilter === oldName) setFolderFilter(name)
    refresh()
  }

  const confirmDeleteFolder = async (name: string): Promise<void> => {
    setDeleteFolderConfirm(null)
    await window.cobrowse.bookmarkFolderRemove(name)
    if (folderFilter === name) setFolderFilter(null)
    toast('文件夹已删除，书签已移到未分类')
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
          <span>删除「{name}」？文件夹内书签将移到未分类</span>
          <button style={dangerBtnStyle} onClick={() => void confirmDeleteFolder(name)}>
            删除
          </button>
          <button style={plainBtnStyle} onClick={() => setDeleteFolderConfirm(null)}>
            取消
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
          title="双击重命名"
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
          title={`删除文件夹「${name}」`}
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
              placeholder="标题（留空则使用网址）"
              onChange={(e) => setEditTitle(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Escape') setEditUrl(null)
              }}
            />
            <input
              style={{ ...inputStyle, flex: '1 1 220px', minWidth: 160 }}
              value={editUrlValue}
              placeholder="网址"
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
              <option value="">未分类</option>
              {props.data.bookmarkFolders.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
            <button type="submit" style={plainBtnStyle}>
              保存
            </button>
            <button type="button" style={plainBtnStyle} onClick={() => setEditUrl(null)}>
              取消
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
          title="打开（Ctrl/⌘+点击或鼠标中键在新标签打开）"
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
              <i>{b.folder ?? '未分类'}</i>
              <i>{new Date(b.addedAt).toLocaleString()}</i>
            </small>
          </span>
        </button>
        {active && (
          <div className="library-row-actions">
            {confirmRemove === b.url ? (
              <>
                <button style={{ color: 'var(--err)' }} onClick={() => void removeBookmark(b.url)}>
                  确认删除
                </button>
                <button onClick={() => setConfirmRemove(null)}>取消</button>
              </>
            ) : (
              <>
                <button title="在当前标签打开" onClick={() => props.onNavigate(b.url)}>
                  打开
                </button>
                <button title="在新标签打开" onClick={() => openInNewTab(b.url)}>
                  新标签
                </button>
                <button title="编辑" onClick={() => startEdit(b)}>
                  编辑
                </button>
                <button title="复制链接" onClick={() => void copyLink(b.url)}>
                  复制
                </button>
                <button
                  title="删除"
                  onClick={() => {
                    setConfirmRemove(b.url)
                    armConfirm()
                  }}
                >
                  删除
                </button>
              </>
            )}
          </div>
        )}
      </article>
    )
  }

  const emptyState = q ? (
    <div className="library-empty"><span>⌕</span><strong>没有匹配内容</strong><small>换个关键词再试试</small></div>
  ) : (
    <div className="library-empty"><span>✧</span><strong>这里还没有内容</strong><small>浏览记录、书签和下载会显示在这里</small></div>
  )

  const bookmarkEmpty = q ? (
    <div className="library-empty"><span>⌕</span><strong>没有匹配内容</strong><small>换个关键词再试试</small></div>
  ) : folderFilter != null ? (
    <div className="library-empty"><span>✧</span><strong>{folderFilter === '' ? '未分类还没有书签' : '该文件夹还没有书签'}</strong><small>可在书签行点击「编辑」调整所在文件夹</small></div>
  ) : (
    <div className="library-empty"><span>✧</span><strong>还没有书签</strong><small>点击「＋ 新建书签」，或浏览时点击星标</small></div>
  )

  return <section className="browser-panel">
    <header className="browser-panel-head">
      <div><span className="panel-eyebrow">DUPLEX LIBRARY</span><h2>{titles[props.section]}</h2></div>
      <button className="panel-close" onClick={props.onClose} aria-label="关闭">×</button>
    </header>
    <label className="library-search"><span>⌕</span><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`搜索${titles[props.section]}`} autoFocus /></label>
    {props.section === 'bookmarks' ? (
      <>
        <div className="library-tools">
          <span>{bookmarks.length} 项</span>
          <span style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <button
              title="切换排序方式"
              onClick={() => setSort((prev) => (prev === 'recent' ? 'title' : 'recent'))}
            >
              排序：{sort === 'recent' ? '最近添加' : '标题 A–Z'}
            </button>
            <button onClick={openNewForm}>＋ 新建书签</button>
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
          {folderChip('all', `全部 (${props.data.bookmarks.length})`, folderFilter === null, () => setFolderFilter(null))}
          {folderChip('root', `未分类 (${folderCounts.root})`, folderFilter === '', () => setFolderFilter(''))}
          {props.data.bookmarkFolders.map((name) => renderFolderChip(name))}
          {creatingFolder ? (
            <input
              autoFocus
              value={folderName}
              placeholder="文件夹名称"
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
              ＋ 新建文件夹
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
              placeholder="标题（留空则使用网址）"
              onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Escape') setNewOpen(false)
              }}
            />
            <input
              style={{ ...inputStyle, flex: '2 1 240px', minWidth: 180 }}
              value={newUrl}
              placeholder="网址，例如 https://example.com"
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
              <option value="">未分类</option>
              {props.data.bookmarkFolders.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
            <button type="submit" style={plainBtnStyle}>
              保存
            </button>
            <button type="button" style={plainBtnStyle} onClick={() => setNewOpen(false)}>
              取消
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
          <span>{items.length} 项</span>
          {props.section === 'history' && (
            <button className={clearStage > 0 ? 'danger' : ''} onClick={() => askClear(props.onClearHistory)}>
              {clearStage > 0 ? '确认清除浏览记录？' : '清除浏览记录'}
            </button>
          )}
          {props.section === 'downloads' && (
            <button className={clearStage > 0 ? 'danger' : ''} onClick={() => askClear(props.onClearDownloads)}>
              {clearStage > 0 ? '确认清除列表？' : '清除列表'}
            </button>
          )}
        </div>
        <div className="library-list">
          {items.length === 0 ? emptyState : items.map((item) => {
            if (props.section === 'downloads') {
              const row = item as DownloadRecord
              const pct = row.totalBytes > 0 ? Math.min(100, Math.round(row.receivedBytes / row.totalBytes * 100)) : 0
              const size = (n: number): string => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`
              return <article className="library-row download-row" key={row.id}>
                <div className="library-file-icon">↓</div><div className="library-row-main"><strong>{row.filename}</strong><small>{row.state === 'progressing' ? `${size(row.receivedBytes)} / ${size(row.totalBytes)}` : row.state === 'completed' ? size(row.totalBytes) : row.state === 'cancelled' ? '已取消' : '下载中断'}</small>
                  {row.state === 'progressing' && <div className="download-progress"><i style={{ width: `${pct}%` }} /></div>}
                </div><div className="library-row-actions">
                  {row.state === 'progressing' ? <button onClick={() => props.onCancelDownload(row.id)}>取消</button> : <><button disabled={row.state !== 'completed'} onClick={() => props.onOpenDownload(row.id)}>打开</button><button onClick={() => props.onRevealDownload(row.id)}>文件夹</button></>}
                </div>
              </article>
            }
            const row = item as BrowserDataSnapshot['history'][number]
            const when = row.visitedAt
            const icon = faviconSrc(row.url, row.favicon)
            return <article className="library-row" key={`${row.url}-${when}`}>
              <button className="library-row-open" onClick={() => props.onNavigate(row.url)}>
                {icon && <img key={icon} src={icon} onError={(e) => { e.currentTarget.style.visibility = 'hidden' }} />}
                <span className="library-row-main"><strong>{row.title || row.url}</strong><small>{row.url}<i>{new Date(when).toLocaleString()}</i></small></span>
              </button>
              <button className="row-remove" title="从记录中移除" onClick={() => props.onRemoveHistory(row.url, when)}>×</button>
            </article>
          })}
        </div>
      </>
    )}
  </section>
}
