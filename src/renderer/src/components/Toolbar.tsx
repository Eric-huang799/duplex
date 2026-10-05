import { useEffect, useState } from 'react'
import type { TabInfo } from '../../../shared/protocol'

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
        <button onClick={() => { onAction('annotationMode'); setToolsMenu(false) }}>页面标注</button><button onClick={() => { setStopKeysOpen(true); setToolsMenu(false); void window.cobrowse.emergencyKeysGet().then((s) => setStopKeys(s.keys)) }}>设置急停键</button>
        <div className="tools-menu-divider" />
        {(['system', 'light', 'dark'] as const).map((t) => <button key={t} className={theme === t ? 'on' : ''} onClick={() => applyTheme(t)}>{THEME_ICON[t]}　{THEME_LABEL[t]}</button>)}
      </div>}
      {active?.loading && <span className="load-dot" title="加载中" />}
      <button className={`tb-btn ai-toggle ${aiOpen ? 'selected' : ''}`} title={aiOpen ? '隐藏 AI 面板' : '打开 AI 面板'} onClick={onToggleAI}>AI</button>

      {stopKeysOpen && (
        <div className="confirm-overlay" onClick={(e) => e.stopPropagation()}>
          <div className="confirm-box">
            <div className="confirm-title">急停快捷键</div>
            <label className="add-tool-field">
              <span>按键（逗号分隔；在下方输入框按任意键即可捕获替换）</span>
              <input
                className="stopkey-capture"
                value={stopKeys.join(',')}
                spellCheck={false}
                onChange={(e) =>
                  setStopKeys(
                    e.target.value
                      .split(',')
                      .map((s) => s.trim())
                      .filter(Boolean)
                  )
                }
                onKeyDown={(e) => {
                  e.preventDefault()
                  setStopKeys([e.key])
                }}
              />
            </label>
            <div className="import-status">
              按急停键立即中止当前任务（内置 agent 与外部工具进程）并接管浏览器。常用键名：Escape、F2、F8。
            </div>
            <div className="confirm-row">
              <button className="import-btn" onClick={() => setStopKeysOpen(false)}>
                取消
              </button>
              <button
                className="send-btn"
                onClick={() => {
                  void window.cobrowse.emergencyKeysSet(stopKeys).then((r) => {
                    if (r.ok) {
                      setStopKeysOpen(false)
                      onStopKeysChanged?.(r.keys ?? stopKeys)
                    }
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
