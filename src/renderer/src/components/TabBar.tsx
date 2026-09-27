import type { TabInfo } from '../../../shared/protocol'

interface Props {
  tabs: TabInfo[]
  activeTabId: number | null
  onSwitch: (id: number) => void
  onClose: (id: number) => void
  onNew: () => void
}

function shortTitle(t: TabInfo): string {
  const s = t.title || t.url || '新标签页'
  const clean = s.replace(/^https?:\/\/(www\.)?/, '')
  return clean.length > 22 ? clean.slice(0, 22) + '…' : clean
}

export function TabBar({ tabs, activeTabId, onSwitch, onClose, onNew }: Props): React.JSX.Element {
  return (
    <div className="tabbar">
      {tabs.map((t) => (
        <div
          key={t.id}
          className={`tab ${t.id === activeTabId ? 'active' : ''}`}
          onClick={() => onSwitch(t.id)}
          title={t.url}
        >
          {t.loading && <span className="tab-loading" />}
          <span className="tab-title">{shortTitle(t)}</span>
          <button
            className="tab-close"
            title="关闭标签"
            onClick={(e) => {
              e.stopPropagation()
              onClose(t.id)
            }}
          >
            ×
          </button>
        </div>
      ))}
      <button className="tab-new" onClick={onNew} title="新建标签页">
        +
      </button>
    </div>
  )
}
