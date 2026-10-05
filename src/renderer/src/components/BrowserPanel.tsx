import { useMemo, useState } from 'react'
import type { BrowserDataSnapshot, DownloadRecord } from '../../../shared/protocol'

type Section = 'bookmarks' | 'history' | 'downloads'

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
}

const titles: Record<Section, string> = { bookmarks: '书签', history: '浏览记录', downloads: '下载' }

export function BrowserPanel(props: Props): React.JSX.Element {
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const items = useMemo(() => {
    if (props.section === 'bookmarks') return props.data.bookmarks.filter((x) => `${x.title} ${x.url}`.toLowerCase().includes(q))
    if (props.section === 'history') return props.data.history.slice().reverse().filter((x) => `${x.title} ${x.url}`.toLowerCase().includes(q))
    return props.downloads.filter((x) => `${x.filename} ${x.url}`.toLowerCase().includes(q))
  }, [props.section, props.data, props.downloads, q])

  return <section className="browser-panel">
    <header className="browser-panel-head">
      <div><span className="panel-eyebrow">DUPLEX LIBRARY</span><h2>{titles[props.section]}</h2></div>
      <button className="panel-close" onClick={props.onClose} aria-label="关闭">×</button>
    </header>
    <label className="library-search"><span>⌕</span><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`搜索${titles[props.section]}`} autoFocus /></label>
    <div className="library-tools">
      <span>{items.length} 项</span>
      {props.section === 'history' && <button onClick={props.onClearHistory}>清除浏览记录</button>}
      {props.section === 'downloads' && <button onClick={props.onClearDownloads}>清除列表</button>}
    </div>
    <div className="library-list">
      {items.length === 0 ? <div className="library-empty"><span>✧</span><strong>这里还没有内容</strong><small>浏览记录、书签和下载会显示在这里</small></div> : items.map((item) => {
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
        const isBookmark = props.section === 'bookmarks'
        const when = 'visitedAt' in row ? row.visitedAt : (row as BrowserDataSnapshot['bookmarks'][number]).addedAt
        return <article className="library-row" key={`${row.url}-${when}`}>
          <button className="library-row-open" onClick={() => props.onNavigate(row.url)}>
            <img src={row.favicon || new URL('/favicon.ico', row.url).href} onError={(e) => { e.currentTarget.style.visibility = 'hidden' }} />
            <span className="library-row-main"><strong>{row.title || row.url}</strong><small>{row.url}<i>{new Date(when).toLocaleString()}</i></small></span>
          </button>
          {!isBookmark && <button className="row-remove" title="从记录中移除" onClick={() => props.onRemoveHistory(row.url, when)}>×</button>}
        </article>
      })}
    </div>
  </section>
}
