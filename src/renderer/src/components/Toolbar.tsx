import { useEffect, useState } from 'react'
import type { TabInfo } from '../../../shared/protocol'
import { VirtualKeyboard } from './VirtualKeyboard'
import { comboFromEvent, displayParts, isModifierKey, sameBinding, validateBinding } from '../../../shared/hotkeys'

type ThemeSetting = 'system' | 'light' | 'dark'

const THEME_LABEL: Record<ThemeSetting, string> = {
  system: '跟随系统',
  light: '亮色',
  dark: '暗色'
}

const THEME_ICON: Record<ThemeSetting, string> = {
  system: '◐',
  light: '☀',
  dark: '☾'
}

interface Props {
  active: TabInfo | null
  onAction: (action: string, url?: string) => void
  onStopKeysChanged?: (keys: string[]) => void
  bookmarked?: boolean
  onBookmark?: () => void
  onOpenLibrary?: (section: 'bookmarks' | 'history' | 'downloads') => void
  onToggleAI?: () => void
  aiOpen?: boolean
  onChromeOverlayChange?: (id: string, open: boolean) => void
}

function Icon({ name, filled = false }: { name: 'back' | 'forward' | 'reload' | 'star' | 'more'; filled?: boolean }): React.JSX.Element {
  const common = { viewBox: '0 0 24 24', width: 17, height: 17, fill: name === 'star' && filled ? 'currentColor' : 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true as const }
  const paths: Record<typeof name, React.ReactNode> = {
    back: <path d="m15 18-6-6 6-6" />,
    forward: <path d="m9 18 6-6-6-6" />,
    reload: <><path d="M20 7v5h-5" /><path d="M20 12a8 8 0 1 1-2.4-5.7L20 9" /></>,
    star: <path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3l-5.6 2.9 1.1-6.2L3 9.6l6.2-.9L12 3Z" />,
    more: <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>
  }
  return <svg {...common}>{paths[name]}</svg>
}

export function Toolbar({ active, onAction, onStopKeysChanged, bookmarked = false, onBookmark, onOpenLibrary, onToggleAI, aiOpen = false, onChromeOverlayChange }: Props): React.JSX.Element {
  const [input, setInput] = useState('')
  const [editing, setEditing] = useState(false)
  const [theme, setTheme] = useState<ThemeSetting>('system')
  const [engine, setEngine] = useState('baidu')
  const [engines, setEngines] = useState<Array<{ key: string; name: string }>>([])
  const [engineMenu, setEngineMenu] = useState(false)
  const [stopKeys, setStopKeys] = useState<string[]>([])
  const [stopKeysOpen, setStopKeysOpen] = useState(false)
  const [stopError, setStopError] = useState('')
  const [listening, setListening] = useState(false)
  const [pendingMods, setPendingMods] = useState('')
  const [vkOpen, setVkOpen] = useState(false)
  const [toolsMenu, setToolsMenu] = useState(false)

  useEffect(() => {
    onChromeOverlayChange?.('toolbar-engine', engineMenu)
    return () => onChromeOverlayChange?.('toolbar-engine', false)
  }, [engineMenu, onChromeOverlayChange])

  useEffect(() => {
    onChromeOverlayChange?.('toolbar-tools', toolsMenu)
    return () => onChromeOverlayChange?.('toolbar-tools', false)
  }, [toolsMenu, onChromeOverlayChange])

  useEffect(() => {
    onChromeOverlayChange?.('toolbar-stop-keys', stopKeysOpen)
    return () => onChromeOverlayChange?.('toolbar-stop-keys', false)
  }, [stopKeysOpen, onChromeOverlayChange])

  useEffect(() => {
    const focus = (): void => { setEditing(true); document.querySelector<HTMLInputElement>('.urlbar')?.focus(); document.querySelector<HTMLInputElement>('.urlbar')?.select() }
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
  }, [])

  useEffect(() => {
    void window.cobrowse.searchEngineGet().then((s) => {
      setEngine(s.engine)
      setEngines(s.engines)
    })
  }, [])

  useEffect(() => {
    if (!engineMenu) return
    const close = (): void => setEngineMenu(false)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [engineMenu])

  useEffect(() => {
    if (!toolsMenu) return
    const close = (): void => setToolsMenu(false)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [toolsMenu])

  const applyTheme = (t: ThemeSetting): void => {
    setTheme(t)
    void window.cobrowse.setTheme(t)
    setToolsMenu(false)
  }

  const applyEngine = (k: string): void => {
    setEngine(k)
    void window.cobrowse.searchEngineSet(k)
    setEngineMenu(false)
  }

  const submit = (): void => {
    const v = input.trim()
    if (v) onAction('navigate', v)
    setEditing(false)
    ;(document.activeElement as HTMLElement | null)?.blur()
  }

  const addBinding = (combo: string): void => {
    const v = validateBinding(combo)
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
      <button className="tb-btn" onClick={() => onAction('reload')} title="刷新"><Icon name="reload" /></button>
      <input
        className="urlbar"
        value={input}
        spellCheck={false}
        placeholder="输入网址或搜索内容，回车打开"
        onFocus={(e) => { setEditing(true); e.currentTarget.select() }}
        onBlur={() => setEditing(false)}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit()
          if (e.key === 'Escape') {
            setEditing(false)
            ;(e.target as HTMLInputElement).blur()
          }
        }}
      />
      <div className="engine-wrap address-engine">
        <button className="tb-btn engine-trigger" title={`搜索引擎：${engines.find((e) => e.key === engine)?.name ?? engine}`} onClick={(e) => { e.stopPropagation(); setEngineMenu((v) => !v) }}>{engines.find((e) => e.key === engine)?.name ?? '搜索'}　⌄</button>
        {engineMenu && <div className="engine-menu" onClick={(e) => e.stopPropagation()}>{engines.map((en) => <button key={en.key} className={engine === en.key ? 'on' : ''} onClick={() => applyEngine(en.key)}>{en.name}</button>)}</div>}
      </div>
      <button className={`tb-btn bookmark-button ${bookmarked ? 'is-bookmarked' : ''}`} title={bookmarked ? '移除书签' : '添加书签'} onClick={onBookmark}><Icon name="star" filled={bookmarked} /></button>
      <button
        className={`tb-btn tools-trigger ${toolsMenu ? 'selected' : ''}`}
        title="浏览器工具和主题"
        onClick={(e) => { e.stopPropagation(); setToolsMenu((v) => !v) }}
      ><Icon name="more" /></button>
      {toolsMenu && <div className="browser-tools-menu" onClick={(e) => e.stopPropagation()}>
        <button onClick={() => { onOpenLibrary?.('bookmarks'); setToolsMenu(false) }}>书签</button><button onClick={() => { onOpenLibrary?.('history'); setToolsMenu(false) }}>浏览记录</button><button onClick={() => { onOpenLibrary?.('downloads'); setToolsMenu(false) }}>下载内容</button>
        <button onClick={() => { onAction('annotationMode'); setToolsMenu(false) }}>页面标注</button><button onClick={() => { setToolsMenu(false); setStopKeysOpen(true); setStopError(''); setVkOpen(false); setListening(false); setPendingMods(''); void window.cobrowse.emergencyKeysGet().then((s) => setStopKeys(s.keys)) }}>设置急停键</button>
        <div className="tools-menu-divider" />
        {(['system', 'light', 'dark'] as const).map((t) => <button key={t} className={theme === t ? 'on' : ''} onClick={() => applyTheme(t)}>{THEME_ICON[t]}　{THEME_LABEL[t]}</button>)}
      </div>}
      {active?.loading && <span className="load-dot" title="加载中" />}
      <button className={`tb-btn ai-toggle ${aiOpen ? 'selected' : ''}`} title={aiOpen ? '隐藏 AI 面板' : '打开 AI 面板'} onClick={onToggleAI}>AI</button>

      {stopKeysOpen && (
        <div className="confirm-overlay" onClick={(e) => e.stopPropagation()}>
          <div className="confirm-box stopkey-box">
            <div className="confirm-title">急停快捷键</div>
            <div className="stopkey-hint">
              触发后立即中止当前任务（内置 agent 与外部工具进程）并接管浏览器；在网页内同样生效。支持单键与组合键（最多 5 个）。
            </div>
            <div className="stopkey-chips">
              {stopKeys.length === 0 && <span className="stopkey-empty">（未设置）</span>}
              {stopKeys.map((k) => (
                <span className="stopkey-chip" key={k}>
                  {displayParts(k).map((p, i) => (
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
              <button className="import-btn" onClick={() => setStopKeysOpen(false)}>
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
    </div>
  )
}
