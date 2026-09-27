/**
 * Main-process side of the AI action visualization overlay.
 * See docs/blueprints/2026-09-27-p1-interaction-layer.md (state C).
 */
import type { Tab } from './tabs'

export interface OverlayRect {
  x: number
  y: number
  w: number
  h: number
}

export type OverlayCommand =
  | { kind: 'showCursor'; x: number; y: number; ttl?: number }
  | { kind: 'hideCursor' }
  | { kind: 'clickFx'; x: number; y: number }
  | { kind: 'highlight'; rect: OverlayRect; label?: string; ttl?: number }
  | { kind: 'clearHighlight' }
  | {
      kind: 'status'
      text: string
      hint?: string
      tone?: 'info' | 'busy' | 'error'
      ttl?: number
    }
  | { kind: 'clearStatus' }
  | { kind: 'annotationMode'; active?: boolean }
  | { kind: 'hideAll' }

export function overlaySend(tab: Tab, cmd: OverlayCommand): void {
  try {
    const wc = tab.view.webContents
    if (!wc.isDestroyed()) wc.send('overlay:cmd', cmd)
  } catch {
    /* visualization must never break tool execution */
  }
}

const takeover = { requested: false, activeUntil: 0 }

/** Mark an AI activity window; Esc within it counts as an explicit takeover. */
export function markAiActive(ms: number): void {
  takeover.activeUntil = Date.now() + ms
}

/** Called from the overlay IPC; returns true when the takeover was "in window". */
export function noteTakeover(): boolean {
  const active = Date.now() < takeover.activeUntil
  if (active) takeover.requested = true
  return active
}

export function consumeTakeover(): boolean {
  if (takeover.requested) {
    takeover.requested = false
    return true
  }
  return false
}

export function hideAllVisuals(tab: Tab | null): void {
  if (tab) overlaySend(tab, { kind: 'hideAll' })
}

export const TAKEOVER_HINT = 'Esc 接管'
