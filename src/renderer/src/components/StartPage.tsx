import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { BookmarkRecord, HistoryRecord } from '../../../shared/protocol'
import { buildOmniboxSuggestions, splitHighlight, stripUrlForDisplay, type OmniboxSuggestion } from '../../../shared/omnibox'

/** Render text with the query's first occurrence bolded (Chrome suggestion style). */
function renderHighlight(text: string, query: string): React.ReactNode[] {
  return splitHighlight(text, query).map((seg, i) =>
    seg.hit ? <b key={i}>{seg.t}</b> : <span key={i}>{seg.t}</span>
  )
}

interface Props {
  onNavigate: (value: string) => void
  bookmarks?: BookmarkRecord[]
  history?: HistoryRecord[]
  onRemoveBookmark?: (url: string) => void
  onRemoveHistory?: (url: string, visitedAt: number) => void
}

type EngineMenuState = 'closed' | 'open' | 'closing'

const ENTER_BASE_MS = 340
const ENTER_STAGGER_MS = 35
const MENU_CLOSE_MS = 110

export function StartPage({
  onNavigate,
  bookmarks = [],
  history = [],
  onRemoveBookmark,
  onRemoveHistory
}: Props): React.JSX.Element {
  const [value, setValue] = useState('')
  const [now, setNow] = useState(() => new Date())
  const [bgFailed, setBgFailed] = useState(false)
  const [engineKey, setEngineKey] = useState('baidu')
  const [engines, setEngines] = useState<Array<{ key: string; name: string }>>([])
  const [engineMenu, setEngineMenu] = useState<EngineMenuState>('closed')
  const contentRef = useRef<HTMLDivElement | null>(null)
  const flipPendingRef = useRef<{ rects: Map<Element, DOMRect>; count: number; ts: number } | null>(null)
  const deletingRef = useRef(false)
  const initialMountRef = useRef(true)
  const menuTimerRef = useRef<number | null>(null)
  const [sugs, setSugs] = useState<OmniboxSuggestion[]>([])
  const [hl, setHl] = useState(-1)

  useEffect(() => {
    void window.cobrowse.searchEngineGet().then((s) => {
      setEngineKey(s.engine)
      setEngines(s.engines)
    })
    return window.cobrowse.onSearchEngineChanged((k) => setEngineKey(k))
  }, [])

  useEffect(() => {
    const t = window.setTimeout(() => {
      initialMountRef.current = false
    }, 1400)
    return () => window.clearTimeout(t)
  }, [])

  useEffect(() => {
    return () => {
      if (menuTimerRef.current != null) window.clearTimeout(menuTimerRef.current)
    }
  }, [])

  const closeEngineMenu = (): void => {
    if (engineMenu !== 'open') return
    setEngineMenu('closing')
    if (menuTimerRef.current != null) window.clearTimeout(menuTimerRef.current)
    menuTimerRef.current = window.setTimeout(() => {
      menuTimerRef.current = null
      setEngineMenu('closed')
    }, MENU_CLOSE_MS)
  }

  const toggleEngineMenu = (): void => {
    if (engineMenu === 'open') {
      closeEngineMenu()
      return
    }
    if (menuTimerRef.current != null) {
      window.clearTimeout(menuTimerRef.current)
      menuTimerRef.current = null
    }
    setEngineMenu('open')
  }

  useEffect(() => {
    if (engineMenu === 'closed') return
    const close = (): void => closeEngineMenu()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeEngineMenu()
    }
    window.addEventListener('click', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('keydown', onKey)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engineMenu])

  const applyEngine = (k: string): void => {
    setEngineKey(k)
    void window.cobrowse.searchEngineSet(k)
    closeEngineMenu()
  }

  const engineName = engines.find((e) => e.key === engineKey)?.name ?? '百度'

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000)
    return () => clearInterval(t)
  }, [])

  const submit = (): void => {
    const v = value.trim()
    if (v) onNavigate(v)
  }

  const flipSelector = '.start-content > *:not(.start-shortcuts), .shortcut'

  const captureFlipRects = (): { rects: Map<Element, DOMRect>; count: number; ts: number } | null => {
    const root = contentRef.current
    if (!root) return null
    const rects = new Map<Element, DOMRect>()
    root.querySelectorAll(flipSelector).forEach((el) => rects.set(el, el.getBoundingClientRect()))
    return { rects, count: root.querySelectorAll('.shortcut').length, ts: Date.now() }
  }

  useLayoutEffect(() => {
    const pending = flipPendingRef.current
    if (!pending) return
    const root = contentRef.current
    if (!root) return
    if (Date.now() - pending.ts > 2000) {
      flipPendingRef.current = null
      return
    }
    if (root.querySelectorAll('.shortcut').length === pending.count) return
    flipPendingRef.current = null
    root.querySelectorAll(flipSelector).forEach((el) => {
      const prev = pending.rects.get(el)
      if (!prev) return
      const next = el.getBoundingClientRect()
      const dx = prev.left - next.left
      const dy = prev.top - next.top
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return
      el.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0px, 0px)' }],
        { duration: 240, easing: 'cubic-bezier(0.2, 0.72, 0.25, 1)' }
      )
    })
  })

  const removeTile = (tile: Element | null, run: (() => void) | undefined): void => {
    if (!tile || !run || deletingRef.current) return
    deletingRef.current = true
    const captured = captureFlipRects()
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      deletingRef.current = false
      if (captured) flipPendingRef.current = captured
      run()
    }
    const exit = tile.animate(
      [
        { opacity: 1, transform: 'scale(1)' },
        { opacity: 0, transform: 'scale(0.82)' }
      ],
      { duration: 160, easing: 'ease-in', fill: 'forwards' }
    )
    exit.finished.then(finish).catch(finish)
  }

  const enterDelay = (index: number, base: number): React.CSSProperties | undefined =>
    initialMountRef.current ? { animationDelay: `${base + index * ENTER_STAGGER_MS}ms` } : undefined

  const historyBase = ENTER_BASE_MS + Math.min(bookmarks.length, 6) * ENTER_STAGGER_MS

  const refreshSugs = (v: string): void => {
    const q = v.trim()
    if (!q) {
      setSugs([])
      setHl(-1)
      return
    }
    const base = buildOmniboxSuggestions(v, history, bookmarks, { engineName })
    if (base.length === 1) {
      setSugs([...base, ...buildOmniboxSuggestions('', history, [], { recentLimit: 4 })])
    } else {
      setSugs(base)
    }
    setHl(-1)
  }

  const closeSugs = (): void => {
    setSugs([])
    setHl(-1)
  }

  const pickSug = (s: OmniboxSuggestion): void => {
    onNavigate(s.kind === 'search' ? value.trim() : s.url)
    closeSugs()
  }

  const hh = String(now.getHours()).padStart(2, '0')
  const mm = String(now.getMinutes()).padStart(2, '0')
  const dateStr = now.toLocaleDateString('zh-CN', {
    month: 'long',
    day: 'numeric',
    weekday: 'long'
  })

  return (
    <div className="startpage">
      {!bgFailed && (
        <>
          <picture className="start-bg start-bg-sharp">
            <source media="(prefers-color-scheme: dark)" srcSet="./start-bg-dark.jpg" />
            <img src="./start-bg.jpg" alt="" draggable={false} onError={() => setBgFailed(true)} />
          </picture>
          <picture className="start-bg start-bg-blur">
            <source media="(prefers-color-scheme: dark)" srcSet="./start-bg-dark.jpg" />
            <img src="./start-bg.jpg" alt="" draggable={false} onError={() => setBgFailed(true)} />
          </picture>
        </>
      )}
      <div className="start-glow" />
      <div className="start-content" ref={contentRef}>
        <div className="start-clock">
          <div className="start-time">
            {hh}:{mm}
          </div>
          <div className="start-date">{dateStr}</div>
        </div>

        <div className="start-brand">Duplex</div>

        <div className="start-search">
          <svg
            className="start-search-icon"
            viewBox="0 0 24 24"
            width="18"
            height="18"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <circle cx="11" cy="11" r="7" />
            <line x1="16.5" y1="16.5" x2="21" y2="21" strokeLinecap="round" />
          </svg>
          <input
            value={value}
            spellCheck={false}
            placeholder="搜索或输入网址"
            aria-autocomplete="list"
            onChange={(e) => {
              setValue(e.target.value)
              refreshSugs(e.target.value)
            }}
            onFocus={() => refreshSugs(value)}
            onBlur={() => closeSugs()}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' && sugs.length > 0) {
                e.preventDefault()
                setHl((h) => Math.min(h + 1, sugs.length - 1))
                return
              }
              if (e.key === 'ArrowUp' && sugs.length > 0) {
                e.preventDefault()
                setHl((h) => Math.max(h - 1, -1))
                return
              }
              if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                const pick = hl >= 0 ? sugs[hl] : null
                if (pick && pick.kind !== 'search') {
                  onNavigate(pick.url)
                  closeSugs()
                  ;(e.target as HTMLInputElement).blur()
                } else submit()
                return
              }
              if (e.key === 'Escape' && sugs.length > 0) closeSugs()
            }}
          />
          <div className="start-engine-wrap">
            <button
              className="start-engine"
              title="点击切换搜索引擎"
              onClick={(e) => {
                e.stopPropagation()
                toggleEngineMenu()
              }}
            >
              {engineName}
            </button>
            {engineMenu !== 'closed' && (
              <div
                className={`start-engine-menu${engineMenu === 'closing' ? ' closing' : ''}`}
                onClick={(e) => e.stopPropagation()}
              >
                {engines.map((en) => (
                  <button
                    key={en.key}
                    className={engineKey === en.key ? 'on' : ''}
                    onClick={() => applyEngine(en.key)}
                  >
                    {en.name}
                  </button>
                ))}
              </div>
            )}
          </div>
          {sugs.length > 0 && (
            <div className="omnibox-pop start-search-pop" role="listbox">
              {sugs.map((s, i) => (
                <button
                  type="button"
                  key={`${s.kind}-${i}-${s.url}`}
                  role="option"
                  aria-selected={i === hl}
                  className={`omnibox-item${i === hl ? ' on' : ''}`}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setHl(i)}
                  onClick={() => pickSug(s)}
                >
                  <span className="omnibox-ico">
                    {s.kind === 'search'
                      ? '🔍'
                      : s.favicon
                        ? <img className="omnibox-fav" src={s.favicon} alt="" onError={(ev) => { ev.currentTarget.style.visibility = 'hidden' }} />
                        : '🌐'}
                  </span>
                  <span className="omnibox-label">{renderHighlight(s.label, value.trim())}</span>
                  <span className="omnibox-sub">{s.kind === 'search' ? s.sub : renderHighlight(stripUrlForDisplay(s.sub), value.trim())}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        {bookmarks.length > 0 && (
          <div className="start-shortcuts">
            {bookmarks.slice(0, 6).map((item, i) => (
              <div className="shortcut" key={item.url} style={enterDelay(i, ENTER_BASE_MS)}>
                <button className="shortcut-main" onClick={() => onNavigate(item.url)} title={item.url}>
                  <span className="shortcut-icon">{item.favicon ? <img src={item.favicon} onError={(e) => { e.currentTarget.style.visibility = 'hidden' }} /> : '✦'}</span>
                  <span>{item.title || item.url}</span>
                </button>
                <button
                  className="shortcut-del"
                  title="删除此常用网站（移除书签）"
                  onClick={(e) => {
                    e.stopPropagation()
                    removeTile(e.currentTarget.closest('.shortcut'), () => onRemoveBookmark?.(item.url))
                  }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        {history.length > 0 && (
          <div className="start-shortcuts">
            {history.slice().reverse().slice(0, 4).map((item, i) => (
              <div className="shortcut" key={`${item.url}-${item.visitedAt}`} style={enterDelay(i, historyBase)}>
                <button className="shortcut-main" onClick={() => onNavigate(item.url)} title={item.url}>
                  <span className="shortcut-icon">{item.favicon ? <img src={item.favicon} onError={(e) => { e.currentTarget.style.visibility = 'hidden' }} /> : '↗'}</span>
                  <span>{item.title || item.url}</span>
                </button>
                <button
                  className="shortcut-del"
                  title="删除此常用网站（移除历史记录）"
                  onClick={(e) => {
                    e.stopPropagation()
                    removeTile(e.currentTarget.closest('.shortcut'), () => onRemoveHistory?.(item.url, item.visitedAt))
                  }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
