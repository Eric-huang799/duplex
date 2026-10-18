import { useEffect, useMemo, useRef, useState } from 'react'
import type { TabInfo, BookmarkRecord, HistoryRecord } from '../../../shared/protocol'
import { buildOmniboxSuggestions, formatVisitTime, splitHighlight, stripUrlForDisplay, type OmniboxSuggestion } from '../../../shared/omnibox'
import { VirtualKeyboard } from './VirtualKeyboard'
import { comboFromEvent, displayParts, isModifierKey, normalizeBinding, sameBinding, validateBinding } from '../../../shared/hotkeys'
import { DEFAULT_SHORTCUTS, SHORTCUT_DEFS, validateShortcuts, type ShortcutAction } from '../../../shared/shortcuts'
import { useI18n } from '../i18n'
import type { I18nKey } from '../../../shared/i18n'

type ThemeSetting = 'system' | 'light' | 'dark'
type EngineMenuState = 'closed' | 'open' | 'closing'
const ENGINE_MENU_CLOSE_MS = 110


/** Render text with the query's first occurrence bolded (Chrome suggestion style). */
function renderHighlight(text: string, query: string): React.ReactNode[] {
  return splitHighlight(text, query).map((seg, i) =>
    seg.hit ? <b key={i}>{seg.t}</b> : <span key={i}>{seg.t}</span>
  )
}

interface Props {
  active: TabInfo | null
  onAction: (action: string, url?: string, tabId?: number) => void
  onStopKeysChanged?: (keys: string[]) => void
  bookmarked?: boolean
  onBookmark?: () => void
  onToggleAI?: () => void
  aiOpen?: boolean
  annotationActive?: boolean
  onToggleAnnotation?: () => void
  onChromeOverlayChange?: (id: string, open: boolean) => void
  /** Local data for omnibox suggestions + the recent-history popup (Chrome-style). */
  bookmarks?: BookmarkRecord[]
  history?: HistoryRecord[]
  onOpenHistory?: () => void
}

function Icon({ name, filled = false }: { name: 'back' | 'forward' | 'reload' | 'star' | 'more' | 'stop' | 'home' | 'history'; filled?: boolean }): React.JSX.Element {
  const common = { viewBox: '0 0 24 24', width: 17, height: 17, fill: name === 'star' && filled ? 'currentColor' : 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true as const }
  const paths: Record<typeof name, React.ReactNode> = {
    back: <path d="m15 18-6-6 6-6" />,
    forward: <path d="m9 18 6-6-6-6" />,
    reload: <><path d="M20 7v5h-5" /><path d="M20 12a8 8 0 1 1-2.4-5.7L20 9" /></>,
    stop: <><path d="M6.5 6.5 17.5 17.5" /><path d="M17.5 6.5 6.5 17.5" /></>,
    star: <path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3l-5.6 2.9 1.1-6.2L3 9.6l6.2-.9L12 3Z" />,
    home: <><path d="m3 10.8 9-7.8 9 7.8" /><path d="M5.5 9.5V21h13V9.5" /></>,
    history: <><path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1L3.5 8.3" /><path d="M3.5 3.5v4.8h4.8" /><path d="M12 7.5V12l3 2.5" /></>,
    more: <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>
  }
  return <svg {...common}>{paths[name]}</svg>
}

export function Toolbar({ active, onAction, onStopKeysChanged, bookmarked = false, onBookmark, onToggleAI, aiOpen = false, annotationActive = false, onToggleAnnotation, onChromeOverlayChange, bookmarks = [], history = [], onOpenHistory }: Props): React.JSX.Element {
  const { t, lang } = useI18n()
  const [input, setInput] = useState('')
  const [editing, setEditing] = useState(false)
  const [sugs, setSugs] = useState<OmniboxSuggestion[]>([])
  const [hl, setHl] = useState(-1)
  const [histOpen, setHistOpen] = useState(false)
  const editTabRef = useRef<number | undefined>(active?.id)
  const currentTabRef = useRef<number | undefined>(active?.id)
  currentTabRef.current = active?.id
  /** Text the user actually typed (arrow-key sync + stage-1 Esc restore, Chrome-style). */
  const typedRef = useRef('')
  const [theme, setTheme] = useState<ThemeSetting>('system')
  const [engine, setEngine] = useState('baidu')
  const [engines, setEngines] = useState<Array<{ key: string; name: string }>>([])
  const [engineMenu, setEngineMenu] = useState<EngineMenuState>('closed')
  const engineMenuTimerRef = useRef<number | null>(null)
  const [platform] = useState(() => window.cobrowse.getPlatform())
  const [stopKeys, setStopKeys] = useState<string[]>([])
  const [stopKeysOpen, setStopKeysOpen] = useState(false)
  const [stopError, setStopError] = useState('')
  const [listening, setListening] = useState(false)
  const [pendingMods, setPendingMods] = useState('')
  const [vkOpen, setVkOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [shortcutCurrent, setShortcutCurrent] = useState<Record<string, string>>(() => ({ ...DEFAULT_SHORTCUTS }))
  const [shortcutDefaults, setShortcutDefaults] = useState<Record<string, string>>(() => ({ ...DEFAULT_SHORTCUTS }))
  const [shortcutDraft, setShortcutDraft] = useState<Record<string, string | null>>({})
  const [shortcutError, setShortcutError] = useState('')
  const [recordingAction, setRecordingAction] = useState<ShortcutAction | null>(null)
  const [recordingMods, setRecordingMods] = useState('')

  useEffect(() => {
    onChromeOverlayChange?.('toolbar-stop-keys', stopKeysOpen)
    return () => onChromeOverlayChange?.('toolbar-stop-keys', false)
  }, [stopKeysOpen, onChromeOverlayChange])

  useEffect(() => {
    const focus = (): void => {
      editTabRef.current = currentTabRef.current
      setEditing(true)
      document.querySelector<HTMLInputElement>('.urlbar')?.focus()
      document.querySelector<HTMLInputElement>('.urlbar')?.select()
    }
    window.addEventListener('duplex:focus-address', focus)
    return () => window.removeEventListener('duplex:focus-address', focus)
  }, [])

  useEffect(() => {
    if (!editing) {
      const url = active?.url ?? ''
      setInput(url === 'about:blank' ? '' : url)
    }
  }, [active?.url, editing])

  // Switching tabs collapses every chrome overlay and exits address editing (Chrome behavior).
  useEffect(() => {
    closeSugs()
    setHistOpen(false)
    setEditing(false)
    setEngineMenu('closed')
    if (engineMenuTimerRef.current != null) {
      window.clearTimeout(engineMenuTimerRef.current)
      engineMenuTimerRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id])

  useEffect(() => {
    return () => {
      if (engineMenuTimerRef.current != null) window.clearTimeout(engineMenuTimerRef.current)
    }
  }, [])

  const closeEngineMenu = (): void => {
    if (engineMenu !== 'open') return
    setEngineMenu('closing')
    if (engineMenuTimerRef.current != null) window.clearTimeout(engineMenuTimerRef.current)
    engineMenuTimerRef.current = window.setTimeout(() => {
      engineMenuTimerRef.current = null
      setEngineMenu('closed')
    }, ENGINE_MENU_CLOSE_MS)
  }

  const toggleEngineMenu = (): void => {
    if (engineMenu === 'open') {
      closeEngineMenu()
      return
    }
    if (engineMenuTimerRef.current != null) {
      window.clearTimeout(engineMenuTimerRef.current)
      engineMenuTimerRef.current = null
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
    setEngine(k)
    void window.cobrowse.searchEngineSet(k)
    closeEngineMenu()
  }

  useEffect(() => {
    void window.cobrowse.getTheme().then((t) => setTheme(t.theme))
    return window.cobrowse.onThemeChanged((t) => setTheme(t))
  }, [])

  useEffect(() => {
    void window.cobrowse.searchEngineGet().then((s) => {
      setEngine(s.engine)
      setEngines(s.engines)
    })
    return window.cobrowse.onSearchEngineChanged((k) => setEngine(k))
  }, [])

  useEffect(() => {
    const onOpenStopKeys = (): void => openStopKeys()
    window.addEventListener('duplex:open-stopkeys', onOpenStopKeys)
    return () => window.removeEventListener('duplex:open-stopkeys', onOpenStopKeys)
    // openStopKeys only touches stable state setters
  }, [])

  useEffect(() => {
    onChromeOverlayChange?.('toolbar-shortcuts', shortcutsOpen)
    return () => onChromeOverlayChange?.('toolbar-shortcuts', false)
  }, [shortcutsOpen, onChromeOverlayChange])

  useEffect(() => {
    const onOpenShortcuts = (): void => openShortcuts()
    window.addEventListener('duplex:open-shortcuts', onOpenShortcuts)
    return () => window.removeEventListener('duplex:open-shortcuts', onOpenShortcuts)
  }, [])

  useEffect(() => {
    if (!shortcutsOpen) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      closeShortcuts()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [shortcutsOpen])

  const closeStopKeys = (): void => {
    setStopKeysOpen(false)
    setListening(false)
    setPendingMods('')
  }

  const openStopKeys = (): void => {
    setStopKeysOpen(true)
    setStopError('')
    setVkOpen(false)
    setListening(false)
    setPendingMods('')
    void window.cobrowse.emergencyKeysGet().then((s) => setStopKeys(s.keys))
  }

  const closeShortcuts = (): void => {
    setShortcutsOpen(false)
    setShortcutDraft({})
    setShortcutError('')
    setRecordingAction(null)
    setRecordingMods('')
  }

  const openShortcuts = (): void => {
    setShortcutsOpen(true)
    setShortcutDraft({})
    setShortcutError('')
    setRecordingAction(null)
    setRecordingMods('')
    void window.cobrowse.shortcutsGet().then((s) => {
      setShortcutCurrent(s.shortcuts)
      setShortcutDefaults(s.defaults)
    })
  }

  const shortcutValue = (id: ShortcutAction): string => {
    if (Object.prototype.hasOwnProperty.call(shortcutDraft, id)) {
      const v = shortcutDraft[id]
      return v === null ? (shortcutDefaults[id] ?? DEFAULT_SHORTCUTS[id]) : v
    }
    return shortcutCurrent[id] ?? DEFAULT_SHORTCUTS[id]
  }

  const onShortcutRecorderKeyDown = (e: React.KeyboardEvent, id: ShortcutAction): void => {
    e.preventDefault()
    e.stopPropagation()
    if (e.key === 'Escape') {
      setRecordingAction(null)
      setRecordingMods('')
      ;(e.target as HTMLElement).blur()
      return
    }
    if (isModifierKey(e.key)) {
      const parts: string[] = []
      if (e.ctrlKey) parts.push('Ctrl')
      if (e.altKey) parts.push('Alt')
      if (e.shiftKey) parts.push('Shift')
      if (e.metaKey) parts.push('Win')
      setRecordingMods(parts.join(' + '))
      return
    }
    const combo = comboFromEvent(e)
    if (combo) {
      const norm = normalizeBinding(combo) ?? combo
      setShortcutDraft((d) => ({ ...d, [id]: norm }))
      setShortcutError('')
    }
    setRecordingMods('')
    setRecordingAction(null)
    ;(e.target as HTMLElement).blur()
  }

  const saveShortcuts = (): void => {
    const effective: Record<string, string> = {}
    for (const def of SHORTCUT_DEFS) effective[def.id] = shortcutValue(def.id)
    const check = validateShortcuts(effective, { platform, lang })
    if (!check.ok) {
      setShortcutError(check.error)
      return
    }
    void window.cobrowse.shortcutsSet(shortcutDraft).then((r) => {
      if (!r.ok) {
        setShortcutError(r.error ?? t('shortcuts.saveFailed'))
        return
      }
      if (r.shortcuts) setShortcutCurrent(r.shortcuts)
      closeShortcuts()
    })
  }

  useEffect(() => {
    if (!stopKeysOpen) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      closeStopKeys()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [stopKeysOpen])

  const noPage = !active || !active.url || active.url === 'about:blank'
  const showAnnotationToggle = annotationActive || typeof onToggleAnnotation === 'function'

  // Chrome-style: incognito tabs never surface local history/bookmarks in suggestions.
  const localHistory = active?.incognito ? [] : history
  const localBookmarks = active?.incognito ? [] : bookmarks
  const engineEntry = engines.find((e) => e.key === engine)
  const engineDisplay = engineEntry ? t(`engine.${engineEntry.key}` as I18nKey) : t('toolbar.engineFallback')

  const refreshSugs = (value: string): void => {
    setSugs(buildOmniboxSuggestions(value, localHistory, localBookmarks, { engineName: engineDisplay, lang }))
    setHl(-1)
  }

  const closeSugs = (): void => {
    setSugs([])
    setHl(-1)
  }

  const recent = buildOmniboxSuggestions('', localHistory, [], { recentLimit: 10, lang })
  /** Current trimmed query for match highlighting in the dropdown. */
  const qNow = input.trim()

  const pickSuggestion = (s: OmniboxSuggestion): void => {
    if (s.kind === 'search') submit()
    else onAction('navigate', s.url, editTabRef.current)
    closeSugs()
    setEditing(false)
    ;(document.activeElement as HTMLElement | null)?.blur()
  }

  useEffect(() => {
    onChromeOverlayChange?.('toolbar-history-pop', histOpen)
    return () => onChromeOverlayChange?.('toolbar-history-pop', false)
  }, [histOpen, onChromeOverlayChange])

  useEffect(() => {
    if (!histOpen) return
    const onDown = (e: MouseEvent): void => {
      const t = e.target as HTMLElement | null
      if (t?.closest('.hist-wrap')) return
      setHistOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setHistOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [histOpen])

  // Menu "浏览记录" opens the small recent-history popup (Chrome/Edge flow), never the full page directly.
  useEffect(() => {
    const onOpenRecent = (): void => setHistOpen(true)
    window.addEventListener('duplex:open-recent-history', onOpenRecent)
    return () => window.removeEventListener('duplex:open-recent-history', onOpenRecent)
  }, [])

  const submit = (): void => {
    const v = input.trim()
    if (v) onAction('navigate', v, editTabRef.current)
    setEditing(false)
    ;(document.activeElement as HTMLElement | null)?.blur()
  }

  const addBinding = (combo: string): void => {
    const v = validateBinding(combo, platform, lang)
    if (!v.ok) {
      setStopError(v.reason)
      return
    }
    if (stopKeys.some((b) => sameBinding(b, v.combo))) {
      setStopError(t('stopkeys.duplicate'))
      return
    }
    if (stopKeys.length >= 5) {
      setStopError(t('stopkeys.tooMany'))
      return
    }
    setStopKeys([...stopKeys, v.combo])
    setStopError('')
  }

  const removeBinding = (combo: string): void => {
    setStopKeys(stopKeys.filter((k) => k !== combo))
    setStopError('')
  }

  const onRecorderKeyDown = (e: React.KeyboardEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    if (e.key === 'Escape') {
      setListening(false)
      setPendingMods('')
      ;(e.target as HTMLElement).blur()
      return
    }
    if (isModifierKey(e.key)) {
      const parts: string[] = []
      if (e.ctrlKey) parts.push('Ctrl')
      if (e.altKey) parts.push('Alt')
      if (e.shiftKey) parts.push('Shift')
      if (e.metaKey) parts.push('Win')
      setPendingMods(parts.join(' + '))
      return
    }
    const combo = comboFromEvent(e)
    if (combo) addBinding(combo)
    setPendingMods('')
  }

  return (
    <div className="toolbar">
      <button className="tb-btn" disabled={!active?.canGoBack} onClick={() => onAction('back')} title={t('toolbar.back')}><Icon name="back" /></button>
      <button className="tb-btn" disabled={!active?.canGoForward} onClick={() => onAction('forward')} title={t('toolbar.forward')}><Icon name="forward" /></button>
      <button className="tb-btn" disabled={noPage} onClick={() => onAction(active?.loading ? 'stopLoad' : 'reload')} title={active?.loading ? t('toolbar.stop') : t('toolbar.reload')}><Icon name={active?.loading ? 'stop' : 'reload'} /></button>
      <button className="tb-btn tb-home" onClick={() => onAction('home')} title={t('toolbar.home')}><Icon name="home" /></button>
      <div className="urlbar-wrap">
        <input
          className="urlbar"
          value={input}
          spellCheck={false}
          placeholder={t('toolbar.addressPlaceholder')}
          aria-autocomplete="list"
          aria-controls="omnibox-list"
          aria-expanded={editing && sugs.length > 0}
          aria-activedescendant={hl >= 0 ? `omnibox-opt-${hl}` : undefined}
          onFocus={(e) => { typedRef.current = input; editTabRef.current = active?.id; setEditing(true); refreshSugs(input); e.currentTarget.select() }}
          onBlur={() => { setEditing(false); closeSugs() }}
          onChange={(e) => { typedRef.current = e.target.value; setInput(e.target.value); refreshSugs(e.target.value) }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' && sugs.length > 0) {
              e.preventDefault()
              const next = Math.min(hl + 1, sugs.length - 1)
              setHl(next)
              // Chrome: moving the selection places the target url into the omnibox.
              if (sugs[next].kind !== 'search') setInput(sugs[next].url)
              return
            }
            if (e.key === 'ArrowUp' && sugs.length > 0) {
              e.preventDefault()
              const next = Math.max(hl - 1, -1)
              setHl(next)
              setInput(next >= 0 && sugs[next].kind !== 'search' ? sugs[next].url : typedRef.current)
              return
            }
            if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) {
              const pick = hl >= 0 ? sugs[hl] : null
              if (pick && pick.kind !== 'search') pickSuggestion(pick)
              else submit()
              closeSugs()
              return
            }
            if (e.key === 'Escape') {
              if (sugs.length > 0) {
                // 第一段 Esc：收起下拉并还原手打文本（Chrome 交互），再按才退出编辑
                closeSugs()
                setInput(typedRef.current)
                return
              }
              setEditing(false)
              ;(e.target as HTMLInputElement).blur()
            }
          }}
        />
        <div className="engine-wrap address-engine">
          <button
            className="tb-btn engine-trigger"
            title={t('toolbar.engineTitle', { name: engineDisplay })}
            onClick={(e) => {
              e.stopPropagation()
              toggleEngineMenu()
            }}
          >
            {engineDisplay}　⌄
          </button>
          {engineMenu !== 'closed' && (
            <div
              className={`engine-menu${engineMenu === 'closing' ? ' closing' : ''}`}
              onClick={(e) => e.stopPropagation()}
            >
              {engines.map((en) => (
                <button
                  key={en.key}
                  className={engine === en.key ? 'on' : ''}
                  onClick={() => applyEngine(en.key)}
                >
                  {t(`engine.${en.key}` as I18nKey)}
                </button>
              ))}
            </div>
          )}
        </div>
        {editing && sugs.length > 0 && (
          <div className="omnibox-pop" role="listbox" id="omnibox-list">
            {sugs.map((s, i) => (
              <button
                type="button"
                key={`${s.kind}-${i}-${s.url}`}
                id={`omnibox-opt-${i}`}
                role="option"
                aria-selected={i === hl}
                className={`omnibox-item${i === hl ? ' on' : ''}`}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setHl(i)}
                onClick={() => pickSuggestion(s)}
              >
                <span className="omnibox-ico">
                  {s.kind === 'search'
                    ? '🔍'
                    : s.favicon
                      ? <img className="omnibox-fav" src={s.favicon} alt="" onError={(ev) => { ev.currentTarget.style.visibility = 'hidden' }} />
                      : '🌐'}
                </span>
                <span className="omnibox-label">{renderHighlight(s.label, qNow)}</span>
                <span className="omnibox-sub">{s.kind === 'search' ? s.sub : renderHighlight(stripUrlForDisplay(s.sub), qNow)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <button className={`tb-btn bookmark-button ${bookmarked ? 'is-bookmarked' : ''}`} disabled={noPage} title={bookmarked ? t('toolbar.bookmarkRemove') : t('toolbar.bookmarkAdd')} onClick={onBookmark}><Icon name="star" filled={bookmarked} /></button>
      <div className="hist-wrap">
        <button
          className="tb-btn hist-trigger"
          title={t('toolbar.recent')}
          onClick={(e) => {
            e.stopPropagation()
            setHistOpen((v) => !v)
          }}
        ><Icon name="history" /></button>
        {histOpen && (
          <div className="hist-pop" onMouseDown={(e) => e.stopPropagation()}>
            <div className="hist-pop-head">{t('toolbar.recentHead')}</div>
            {recent.length === 0 ? (
              <div className="hist-pop-empty">{t('toolbar.recentEmpty')}</div>
            ) : (
              recent.map((s, i) => (
                <button
                  type="button"
                  key={`${i}-${s.url}`}
                  className="omnibox-item"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setHistOpen(false)
                    onAction('navigate', s.url, currentTabRef.current)
                  }}
                >
                  <span className="omnibox-ico">
                    {s.favicon
                      ? <img className="omnibox-fav" src={s.favicon} alt="" onError={(ev) => { ev.currentTarget.style.visibility = 'hidden' }} />
                      : '🌐'}
                  </span>
                  <span className="omnibox-label">{s.label}</span>
                  <span className="omnibox-sub">{stripUrlForDisplay(s.sub)}</span>
                  <span className="omnibox-time">{formatVisitTime(s.visitedAt)}</span>
                </button>
              ))
            )}
            <button
              type="button"
              className="hist-pop-foot"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setHistOpen(false)
                onOpenHistory?.()
              }}
            >
              {t('toolbar.recentAll')}
            </button>
          </div>
        )}
      </div>
      <div className="tools-wrap">
        <button
          className="tb-btn tools-trigger"
          title={t('toolbar.tools')}
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect()
            window.cobrowse.showToolsMenu(rect.left, rect.bottom + 4, { annotationActive, theme })
          }}
        ><Icon name="more" /></button>
      </div>
      {showAnnotationToggle && (
        <button
          className={`tb-btn annotation-toggle ${annotationActive ? 'selected' : ''}`}
          disabled={noPage && !annotationActive}
          title={
            noPage && !annotationActive
              ? t('toolbar.annotateUnsupported')
              : annotationActive
                ? t('toolbar.annotateOff')
                : t('toolbar.annotateOn')
          }
          onClick={() => {
            if (onToggleAnnotation) onToggleAnnotation()
            else onAction('annotationMode')
          }}
        >
          ✎ {t('toolbar.annotate')}
        </button>
      )}
      <div className="ai-wrap">
        {active?.loading && <span className="load-dot" title={t('toolbar.loading')} />}
        <button className={`tb-btn ai-toggle ${aiOpen ? 'selected' : ''}`} title={aiOpen ? t('toolbar.aiClose') : t('toolbar.aiOpen')} onClick={onToggleAI}>AI</button>
      </div>

      {stopKeysOpen && (
        <div
          className="confirm-overlay"
          onClick={(e) => {
            e.stopPropagation()
            if (e.target === e.currentTarget) closeStopKeys()
          }}
        >
          <div className="confirm-box stopkey-box">
            <div className="confirm-title">{t('stopkeys.title')}</div>
            <div className="stopkey-hint">{t('stopkeys.hint1')}</div>
            <div className="stopkey-hint">{t('stopkeys.hint2')}</div>
            <div className="stopkey-chips">
              {stopKeys.length === 0 && <span className="stopkey-empty">{t('stopkeys.empty')}</span>}
              {stopKeys.map((k) => (
                <span className="stopkey-chip" key={k}>
                  {displayParts(k, platform, lang).map((p, i) => (
                    <span className="stopkey-capwrap" key={i}>
                      {i > 0 && <span className="stopkey-plus">+</span>}
                      <kbd>{p}</kbd>
                    </span>
                  ))}
                  <button type="button" title={t('common.remove')} onClick={() => removeBinding(k)}>
                    ×
                  </button>
                </span>
              ))}
            </div>
            <div
              className={`stopkey-recorder stopkey-capture${listening ? ' listening' : ''}`}
              tabIndex={0}
              onFocus={() => {
                setListening(true)
                setStopError('')
              }}
              onBlur={() => {
                setListening(false)
                setPendingMods('')
              }}
              onKeyDown={onRecorderKeyDown}
            >
              {listening
                ? pendingMods || t('stopkeys.listening')
                : t('stopkeys.record')}
            </div>
            {stopError && <div className="stopkey-error">{stopError}</div>}
            <button type="button" className="stopkey-vk-toggle" onClick={() => setVkOpen((v) => !v)}>
              {vkOpen ? t('stopkeys.localKeyboardHide') : t('stopkeys.localKeyboard')}
            </button>
            {vkOpen && <VirtualKeyboard onPick={(c) => addBinding(c)} />}
            <div className="confirm-row">
              <button className="import-btn" onClick={closeStopKeys}>
                {t('common.cancel')}
              </button>
              <button
                className="send-btn"
                onClick={() => {
                  if (stopKeys.length === 0) {
                    setStopError(t('stopkeys.needOne'))
                    return
                  }
                  void window.cobrowse.emergencyKeysSet(stopKeys).then((r) => {
                    if (r.ok) {
                      setStopKeysOpen(false)
                      onStopKeysChanged?.(r.keys ?? stopKeys)
                    } else setStopError(r.error ?? t('stopkeys.saveFailed'))
                  })
                }}
              >
                {t('common.save')}
              </button>
            </div>
          </div>
        </div>
      )}

      {shortcutsOpen && (
        <div
          className="confirm-overlay"
          onClick={(e) => {
            e.stopPropagation()
            if (e.target === e.currentTarget) closeShortcuts()
          }}
        >
          <div className="confirm-box stopkey-box">
            <div className="confirm-title">{t('shortcuts.title')}</div>
            <div className="stopkey-hint">{t('shortcuts.hint')}</div>
            <div
              style={{
                maxHeight: '46vh',
                overflowY: 'auto',
                border: '1px solid var(--line)',
                borderRadius: 10,
                padding: '0 10px'
              }}
            >
              {SHORTCUT_DEFS.map((def) => {
                const value = shortcutValue(def.id)
                const isListening = recordingAction === def.id
                const isDefault =
                  value === (shortcutDefaults[def.id] ?? DEFAULT_SHORTCUTS[def.id])
                return (
                  <div
                    key={def.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '7px 0',
                      borderBottom: '1px solid var(--line-soft)'
                    }}
                  >
                    <span style={{ flex: '0 0 118px', fontSize: 12.5 }}>{t(`shortcut.${def.id}` as I18nKey)}</span>
                    <span className="stopkey-chip" style={{ flex: '1 1 auto', minWidth: 0 }}>
                      {displayParts(value, platform, lang).map((p, i) => (
                        <span className="stopkey-capwrap" key={i}>
                          {i > 0 && <span className="stopkey-plus">+</span>}
                          <kbd>{p}</kbd>
                        </span>
                      ))}
                    </span>
                    <div
                      tabIndex={0}
                      className={`stopkey-recorder stopkey-capture${isListening ? ' listening' : ''}`}
                      style={{
                        flex: '0 0 120px',
                        alignSelf: 'center',
                        padding: '6px 8px',
                        fontSize: 11.5
                      }}
                      onFocus={() => {
                        setRecordingAction(def.id)
                        setRecordingMods('')
                        setShortcutError('')
                      }}
                      onBlur={() => {
                        setRecordingAction((cur) => (cur === def.id ? null : cur))
                        setRecordingMods('')
                      }}
                      onKeyDown={(e) => onShortcutRecorderKeyDown(e, def.id)}
                    >
                      {isListening ? recordingMods || t('shortcuts.pressNew') : t('shortcuts.rebind')}
                    </div>
                    <button
                      type="button"
                      className="stopkey-vk-toggle"
                      style={{ alignSelf: 'center' }}
                      disabled={isDefault}
                      onClick={() => {
                        setShortcutDraft((d) => ({ ...d, [def.id]: null }))
                        setShortcutError('')
                      }}
                    >
                      {t('shortcuts.resetOne')}
                    </button>
                  </div>
                )
              })}
            </div>
            {shortcutError && <div className="stopkey-error">{shortcutError}</div>}
            <div className="confirm-row">
              <button
                className="import-btn"
                onClick={() => {
                  setShortcutDraft(
                    Object.fromEntries(SHORTCUT_DEFS.map((d) => [d.id, null]))
                  )
                  setShortcutError('')
                }}
              >
                {t('shortcuts.resetAll')}
              </button>
              <button className="import-btn" onClick={closeShortcuts}>
                {t('common.cancel')}
              </button>
              <button className="send-btn" onClick={saveShortcuts}>
                {t('common.save')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
