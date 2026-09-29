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
}

export function Toolbar({ active, onAction, onStopKeysChanged }: Props): React.JSX.Element {
  const [input, setInput] = useState('')
  const [editing, setEditing] = useState(false)
  const [theme, setTheme] = useState<ThemeSetting>('system')
  const [themeMenu, setThemeMenu] = useState(false)
  const [engine, setEngine] = useState('baidu')
  const [engines, setEngines] = useState<Array<{ key: string; name: string }>>([])
  const [engineMenu, setEngineMenu] = useState(false)
  const [stopKeys, setStopKeys] = useState<string[]>([])
  const [stopKeysOpen, setStopKeysOpen] = useState(false)

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
      <button className="tb-btn" disabled={!active?.canGoBack} onClick={() => onAction('back')} title="后退">
        ←
      </button>
      <button className="tb-btn" disabled={!active?.canGoForward} onClick={() => onAction('forward')} title="前进">
        →
      </button>
      <button className="tb-btn" onClick={() => onAction('reload')} title="刷新">
        ⟳
      </button>
      <div className="engine-wrap">
        <button
          className="tb-engine"
          title={`搜索引擎：${engines.find((e) => e.key === engine)?.name ?? engine}（点击切换；地址栏输入非网址内容时用它搜索）`}
          onClick={(e) => {
            e.stopPropagation()
            setEngineMenu((v) => !v)
          }}
        >
          {engines.find((e) => e.key === engine)?.name ?? '搜索'}
        </button>
        {engineMenu && (
          <div className="engine-menu" onClick={(e) => e.stopPropagation()}>
            {engines.map((en) => (
              <button
                key={en.key}
                className={engine === en.key ? 'on' : ''}
                onClick={() => applyEngine(en.key)}
              >
                {en.name}
              </button>
            ))}
          </div>
        )}
      </div>
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
      <button
        className="tb-btn"
        title="急停快捷键设置"
        onClick={(e) => {
          e.stopPropagation()
          setStopKeysOpen(true)
          void window.cobrowse.emergencyKeysGet().then((s) => setStopKeys(s.keys))
        }}
      >
        ⌨
      </button>
      {active?.loading && <span className="load-dot" title="加载中" />}

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
