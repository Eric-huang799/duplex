import { useEffect, useRef, useState } from 'react'
import type { TabInfo } from '../../../shared/protocol'
import { VirtualKeyboard } from './VirtualKeyboard'
import { comboFromEvent, displayParts, isModifierKey, normalizeBinding, sameBinding, validateBinding } from '../../../shared/hotkeys'
import { DEFAULT_SHORTCUTS, SHORTCUT_DEFS, validateShortcuts, type ShortcutAction } from '../../../shared/shortcuts'

type ThemeSetting = 'system' | 'light' | 'dark'

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
}

function Icon({ name, filled = false }: { name: 'back' | 'forward' | 'reload' | 'star' | 'more' | 'stop'; filled?: boolean }): React.JSX.Element {
  const common = { viewBox: '0 0 24 24', width: 17, height: 17, fill: name === 'star' && filled ? 'currentColor' : 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true as const }
  const paths: Record<typeof name, React.ReactNode> = {
    back: <path d="m15 18-6-6 6-6" />,
    forward: <path d="m9 18 6-6-6-6" />,
    reload: <><path d="M20 7v5h-5" /><path d="M20 12a8 8 0 1 1-2.4-5.7L20 9" /></>,
    stop: <><path d="M6.5 6.5 17.5 17.5" /><path d="M17.5 6.5 6.5 17.5" /></>,
    star: <path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3l-5.6 2.9 1.1-6.2L3 9.6l6.2-.9L12 3Z" />,
    more: <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>
  }
  return <svg {...common}>{paths[name]}</svg>
}

export function Toolbar({ active, onAction, onStopKeysChanged, bookmarked = false, onBookmark, onToggleAI, aiOpen = false, annotationActive = false, onToggleAnnotation, onChromeOverlayChange }: Props): React.JSX.Element {
  const [input, setInput] = useState('')
  const [editing, setEditing] = useState(false)
  const editTabRef = useRef<number | undefined>(active?.id)
  const currentTabRef = useRef<number | undefined>(active?.id)
  currentTabRef.current = active?.id
  const [theme, setTheme] = useState<ThemeSetting>('system')
  const [engine, setEngine] = useState('baidu')
  const [engines, setEngines] = useState<Array<{ key: string; name: string }>>([])
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
    const check = validateShortcuts(effective, { platform })
    if (!check.ok) {
      setShortcutError(check.error)
      return
    }
    void window.cobrowse.shortcutsSet(shortcutDraft).then((r) => {
      if (!r.ok) {
        setShortcutError(r.error ?? '保存失败')
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

  const submit = (): void => {
    const v = input.trim()
    if (v) onAction('navigate', v, editTabRef.current)
    setEditing(false)
    ;(document.activeElement as HTMLElement | null)?.blur()
  }

  const addBinding = (combo: string): void => {
    const v = validateBinding(combo, platform)
    if (!v.ok) {
      setStopError(v.reason)
      return
    }
    if (stopKeys.some((b) => sameBinding(b, v.combo))) {
      setStopError('该组合已存在')
      return
    }
    if (stopKeys.length >= 5) {
      setStopError('最多设置 5 个')
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
      <button className="tb-btn" disabled={!active?.canGoBack} onClick={() => onAction('back')} title="后退"><Icon name="back" /></button>
      <button className="tb-btn" disabled={!active?.canGoForward} onClick={() => onAction('forward')} title="前进"><Icon name="forward" /></button>
      <button className="tb-btn" disabled={noPage} onClick={() => onAction(active?.loading ? 'stopLoad' : 'reload')} title={active?.loading ? '停止加载' : '刷新'}><Icon name={active?.loading ? 'stop' : 'reload'} /></button>
      <input
        className="urlbar"
        value={input}
        spellCheck={false}
        placeholder="输入网址或搜索内容，回车打开"
        onFocus={(e) => { editTabRef.current = active?.id; setEditing(true); e.currentTarget.select() }}
        onBlur={() => setEditing(false)}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) submit()
          if (e.key === 'Escape') {
            setEditing(false)
            ;(e.target as HTMLInputElement).blur()
          }
        }}
      />
      <div className="engine-wrap address-engine">
        <button
          className="tb-btn engine-trigger"
          title={`搜索引擎：${engines.find((e) => e.key === engine)?.name ?? engine}`}
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect()
            window.cobrowse.showEngineMenu(rect.left, rect.bottom + 4)
          }}
        >
          {engines.find((e) => e.key === engine)?.name ?? '搜索'}　⌄
        </button>
      </div>
      <button className={`tb-btn bookmark-button ${bookmarked ? 'is-bookmarked' : ''}`} disabled={noPage} title={bookmarked ? '移除书签' : '添加书签'} onClick={onBookmark}><Icon name="star" filled={bookmarked} /></button>
      <div className="tools-wrap">
        <button
          className="tb-btn tools-trigger"
          title="浏览器工具和主题"
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
              ? '当前页面不支持标注（请在网页上使用）'
              : annotationActive
                ? '退出页面标注模式'
                : '进入页面标注模式'
          }
          onClick={() => {
            if (onToggleAnnotation) onToggleAnnotation()
            else onAction('annotationMode')
          }}
        >
          ✎ 标注
        </button>
      )}
      <div className="ai-wrap">
        {active?.loading && <span className="load-dot" title="加载中" />}
        <button className={`tb-btn ai-toggle ${aiOpen ? 'selected' : ''}`} title={aiOpen ? '隐藏 AI 面板' : '打开 AI 面板'} onClick={onToggleAI}>AI</button>
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
            <div className="confirm-title">急停快捷键</div>
            <div className="stopkey-hint">
              触发后立即中止当前任务（内置 agent 与外部工具进程）并接管浏览器；在网页内同样生效。支持单键与组合键（最多 5 个）。
            </div>
            <div className="stopkey-hint">
              单键快捷键在网页输入框内打字时不会触发（避免误伤），组合键始终有效；设置快捷键后该键会从网页中截获。
            </div>
            <div className="stopkey-chips">
              {stopKeys.length === 0 && <span className="stopkey-empty">（未设置）</span>}
              {stopKeys.map((k) => (
                <span className="stopkey-chip" key={k}>
                  {displayParts(k, platform).map((p, i) => (
                    <span className="stopkey-capwrap" key={i}>
                      {i > 0 && <span className="stopkey-plus">+</span>}
                      <kbd>{p}</kbd>
                    </span>
                  ))}
                  <button type="button" title="移除" onClick={() => removeBinding(k)}>
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
                ? pendingMods || '请按下快捷键…（Esc 取消）'
                : '点击这里，然后直接按下你要设置的按键 / 组合键'}
            </div>
            {stopError && <div className="stopkey-error">{stopError}</div>}
            <button type="button" className="stopkey-vk-toggle" onClick={() => setVkOpen((v) => !v)}>
              {vkOpen ? '收起虚拟键盘' : '用虚拟键盘选择…'}
            </button>
            {vkOpen && <VirtualKeyboard onPick={(c) => addBinding(c)} />}
            <div className="confirm-row">
              <button className="import-btn" onClick={closeStopKeys}>
                取消
              </button>
              <button
                className="send-btn"
                onClick={() => {
                  if (stopKeys.length === 0) {
                    setStopError('至少需要一个按键')
                    return
                  }
                  void window.cobrowse.emergencyKeysSet(stopKeys).then((r) => {
                    if (r.ok) {
                      setStopKeysOpen(false)
                      onStopKeysChanged?.(r.keys ?? stopKeys)
                    } else setStopError(r.error ?? '保存失败')
                  })
                }}
              >
                保存
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
            <div className="confirm-title">快捷键设置</div>
            <div className="stopkey-hint">
              点击某个动作的「录制」后直接按下新按键（Esc 取消录制）；「恢复默认」将该动作还原为默认键。保存后立即生效。
            </div>
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
                    <span style={{ flex: '0 0 118px', fontSize: 12.5 }}>{def.label}</span>
                    <span className="stopkey-chip" style={{ flex: '1 1 auto', minWidth: 0 }}>
                      {displayParts(value, platform).map((p, i) => (
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
                      {isListening ? recordingMods || '按下按键…（Esc 取消）' : '录制'}
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
                      恢复默认
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
                恢复全部默认
              </button>
              <button className="import-btn" onClick={closeShortcuts}>
                取消
              </button>
              <button className="send-btn" onClick={saveShortcuts}>
                保存
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
