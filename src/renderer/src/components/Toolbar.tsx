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
}

export function Toolbar({ active, onAction }: Props): React.JSX.Element {
  const [input, setInput] = useState('')
  const [editing, setEditing] = useState(false)
  const [theme, setTheme] = useState<ThemeSetting>('system')
  const [themeMenu, setThemeMenu] = useState(false)

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
    if (!themeMenu) return
    const close = (): void => setThemeMenu(false)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [themeMenu])

  const applyTheme = (t: ThemeSetting): void => {
    setTheme(t)
    void window.cobrowse.setTheme(t)
    setThemeMenu(false)
  }

  const submit = (): void => {
    const v = input.trim()
    if (v) onAction('navigate', v)
    setEditing(false)
    ;(document.activeElement as HTMLElement | null)?.blur()
  }

  return (
    <div className="toolbar">
      <button className="tb-btn" disabled={!active?.canGoBack} onClick={() => onAction('back')} title="后退">
        ←
      </button>
      <button className="tb-btn" disabled={!active?.canGoForward} onClick={() => onAction('forward')} title="前进">
        →
      </button>
      <button className="tb-btn" onClick={() => onAction('reload')} title="刷新">
        ⟳
      </button>
      <input
        className="urlbar"
        value={input}
        spellCheck={false}
        placeholder="输入网址或搜索内容，回车打开"
        onFocus={() => setEditing(true)}
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
      <button
        className="tb-btn"
        title="页面标注：在页面上画框向 AI 提问（Esc 退出）"
        onClick={() => onAction('annotationMode')}
      >
        ✎
      </button>
      <div className="theme-wrap">
        <button
          className="tb-btn"
          title={`主题：${THEME_LABEL[theme]}`}
          onClick={(e) => {
            e.stopPropagation()
            setThemeMenu((v) => !v)
          }}
        >
          {THEME_ICON[theme]}
        </button>
        {themeMenu && (
          <div className="theme-menu" onClick={(e) => e.stopPropagation()}>
            {(['system', 'light', 'dark'] as const).map((t) => (
              <button key={t} className={theme === t ? 'on' : ''} onClick={() => applyTheme(t)}>
                <span className="theme-menu-icon">{THEME_ICON[t]}</span>
                {THEME_LABEL[t]}
              </button>
            ))}
          </div>
        )}
      </div>
      {active?.loading && <span className="load-dot" title="加载中" />}
    </div>
  )
}
