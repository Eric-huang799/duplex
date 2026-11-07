import { useEffect, useMemo, useRef, useState } from 'react'
import { useI18n } from '../i18n'
import './command-palette.css'

export interface PaletteCommand {
  id: string
  label: string
  /** 右侧灰色补充说明（快捷键、目标标签的域名等）。 */
  hint?: string
  run: () => void
}

interface Props {
  open: boolean
  commands: PaletteCommand[]
  onClose: () => void
}

/**
 * Ctrl+K 命令面板：一个入口解决"那个功能在哪"。
 *
 * 只做纯前端筛选与键盘导航，具体动作由调用方传进来的 `run` 负责——
 * 这样面板本身不依赖任何 IPC，也不会因为新增命令而变复杂。
 */
export function CommandPalette({ open, commands, onClose }: Props): React.JSX.Element | null {
  const { t } = useI18n()
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return commands
    return commands.filter((c) => `${c.label} ${c.hint ?? ''}`.toLowerCase().includes(q))
  }, [commands, query])

  useEffect(() => {
    if (!open) return
    setQuery('')
    setIndex(0)
    // 打开后下一帧聚焦，避免与触发这次打开的按键冲突
    const timer = setTimeout(() => inputRef.current?.focus(), 0)
    return () => clearTimeout(timer)
  }, [open])

  useEffect(() => {
    setIndex(0)
  }, [query])

  if (!open) return null

  const run = (cmd: PaletteCommand | undefined): void => {
    if (!cmd) return
    onClose()
    cmd.run()
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    // 中文输入法组字时不要接管回车/方向键
    if (e.nativeEvent.isComposing || e.keyCode === 229) return
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setIndex((i) => Math.min(i + 1, Math.max(0, filtered.length - 1)))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setIndex((i) => Math.max(i - 1, 0))
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      run(filtered[index])
    }
  }

  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label={t('cmd.title')}>
        <input
          ref={inputRef}
          className="palette-input"
          value={query}
          placeholder={t('cmd.placeholder')}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="palette-list">
          {filtered.length === 0 && <div className="palette-empty">{t('cmd.empty')}</div>}
          {filtered.map((cmd, i) => (
            <button
              key={cmd.id}
              className={`palette-item ${i === index ? 'on' : ''}`}
              onMouseEnter={() => setIndex(i)}
              onClick={() => run(cmd)}
            >
              <span className="palette-label">{cmd.label}</span>
              {cmd.hint && <span className="palette-hint">{cmd.hint}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
