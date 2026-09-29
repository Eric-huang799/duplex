import { useEffect, useRef, useState } from 'react'

interface Props {
  onNavigate: (value: string) => void
}

export function StartPage({ onNavigate }: Props): React.JSX.Element {
  const [value, setValue] = useState('')
  const [now, setNow] = useState(() => new Date())
  const [bgFailed, setBgFailed] = useState(false)
  const [engineKey, setEngineKey] = useState('baidu')
  const [engines, setEngines] = useState<Array<{ key: string; name: string }>>([])
  const [engineMenu, setEngineMenu] = useState(false)

  useEffect(() => {
    void window.cobrowse.searchEngineGet().then((s) => {
      setEngineKey(s.engine)
      setEngines(s.engines)
    })
  }, [])

  useEffect(() => {
    if (!engineMenu) return
    const close = (): void => setEngineMenu(false)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [engineMenu])

  const applyEngine = (k: string): void => {
    setEngineKey(k)
    void window.cobrowse.searchEngineSet(k)
    setEngineMenu(false)
  }

  const engineName = engines.find((e) => e.key === engineKey)?.name ?? '百度'
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    const t = setInterval(() => setNow(new Date()), 30_000)
    return () => clearInterval(t)
  }, [])

  const submit = (): void => {
    const v = value.trim()
    if (v) onNavigate(v)
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
      <div className="start-content">
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
            ref={inputRef}
            value={value}
            spellCheck={false}
            placeholder="搜索或输入网址"
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit()
            }}
          />
          <div className="start-engine-wrap">
            <button
              className="start-engine"
              title="点击切换搜索引擎"
              onClick={(e) => {
                e.stopPropagation()
                setEngineMenu((v) => !v)
              }}
            >
              {engineName}
            </button>
            {engineMenu && (
              <div className="start-engine-menu" onClick={(e) => e.stopPropagation()}>
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
        </div>
      </div>
    </div>
  )
}
