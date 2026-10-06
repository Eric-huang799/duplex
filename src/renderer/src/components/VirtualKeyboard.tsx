import { useState } from 'react'
import { buildCombo } from '../../../shared/hotkeys'

interface Props {
  onPick: (combo: string) => void
}

type ModState = { ctrl: boolean; alt: boolean; shift: boolean }

const MOD_KEYS: Record<string, keyof ModState> = { Ctrl: 'ctrl', Alt: 'alt', Shift: 'shift' }

type KeyDef = { label: string; value?: string; mod?: keyof ModState; wide?: boolean; disabled?: boolean }

const ROWS: KeyDef[][] = [
  [
    { label: 'Esc', value: 'Escape' },
    { label: 'F1', value: 'F1' },
    { label: 'F2', value: 'F2' },
    { label: 'F3', value: 'F3' },
    { label: 'F4', value: 'F4' },
    { label: 'F5', value: 'F5' },
    { label: 'F6', value: 'F6' },
    { label: 'F7', value: 'F7' },
    { label: 'F8', value: 'F8' },
    { label: 'F9', value: 'F9' },
    { label: 'F10', value: 'F10' },
    { label: 'F11', value: 'F11' },
    { label: 'F12', value: 'F12' }
  ],
  [
    { label: '`', value: '`' },
    { label: '1', value: '1' },
    { label: '2', value: '2' },
    { label: '3', value: '3' },
    { label: '4', value: '4' },
    { label: '5', value: '5' },
    { label: '6', value: '6' },
    { label: '7', value: '7' },
    { label: '8', value: '8' },
    { label: '9', value: '9' },
    { label: '0', value: '0' },
    { label: '-', value: '-' },
    { label: '=', value: '=' },
    { label: '⌫', value: 'Backspace', wide: true }
  ],
  [
    { label: 'Tab', value: 'Tab', wide: true },
    { label: 'Q', value: 'q' },
    { label: 'W', value: 'w' },
    { label: 'E', value: 'e' },
    { label: 'R', value: 'r' },
    { label: 'T', value: 't' },
    { label: 'Y', value: 'y' },
    { label: 'U', value: 'u' },
    { label: 'I', value: 'i' },
    { label: 'O', value: 'o' },
    { label: 'P', value: 'p' },
    { label: '[', value: '[' },
    { label: ']', value: ']' },
    { label: '\\', value: '\\' }
  ],
  [
    { label: 'Caps', disabled: true, wide: true },
    { label: 'A', value: 'a' },
    { label: 'S', value: 's' },
    { label: 'D', value: 'd' },
    { label: 'F', value: 'f' },
    { label: 'G', value: 'g' },
    { label: 'H', value: 'h' },
    { label: 'J', value: 'j' },
    { label: 'K', value: 'k' },
    { label: 'L', value: 'l' },
    { label: ';', value: ';' },
    { label: "'", value: "'" },
    { label: 'Enter', value: 'Enter', wide: true }
  ],
  [
    { label: 'Shift', mod: 'shift', wide: true },
    { label: 'Z', value: 'z' },
    { label: 'X', value: 'x' },
    { label: 'C', value: 'c' },
    { label: 'V', value: 'v' },
    { label: 'B', value: 'b' },
    { label: 'N', value: 'n' },
    { label: 'M', value: 'm' },
    { label: ',', value: ',' },
    { label: '.', value: '.' },
    { label: '/', value: '/' },
    { label: 'Shift', mod: 'shift', wide: true }
  ],
  [
    { label: 'Ctrl', mod: 'ctrl', wide: true },
    { label: 'Alt', mod: 'alt' },
    { label: '空格', value: ' ', wide: true },
    { label: 'Alt', mod: 'alt' },
    { label: 'Ctrl', mod: 'ctrl', wide: true },
    { label: '←', value: 'ArrowLeft' },
    { label: '↑', value: 'ArrowUp' },
    { label: '↓', value: 'ArrowDown' },
    { label: '→', value: 'ArrowRight' }
  ]
]

export function VirtualKeyboard({ onPick }: Props): React.JSX.Element {
  const [mods, setMods] = useState<ModState>({ ctrl: false, alt: false, shift: false })

  const activeLabels = [
    mods.ctrl ? 'Ctrl' : '',
    mods.alt ? 'Alt' : '',
    mods.shift ? 'Shift' : ''
  ].filter(Boolean)

  const press = (k: KeyDef): void => {
    if (k.mod) {
      setMods((m) => ({ ...m, [k.mod as keyof ModState]: !m[k.mod as keyof ModState] }))
      return
    }
    if (!k.value) return
    const combo = buildCombo(mods, k.value)
    setMods({ ctrl: false, alt: false, shift: false })
    onPick(combo)
  }

  return (
    <div className="virtual-kb">
      <div className="vk-status">
        {activeLabels.length > 0 ? `已选修饰键：${activeLabels.join(' + ')}` : '点击 Ctrl / Alt / Shift 后再点一个按键'}
      </div>
      {ROWS.map((row, i) => (
        <div className="vk-row" key={i}>
          {row.map((k, j) => (
            <button
              key={j}
              type="button"
              className={`vk-key${k.wide ? ' wide' : ''}${k.mod && mods[k.mod] ? ' on' : ''}${k.disabled ? ' disabled' : ''}`}
              disabled={k.disabled}
              onClick={() => press(k)}
            >
              {k.label}
            </button>
          ))}
        </div>
      ))}
    </div>
  )
}
