/**
 * Main-process side of the AI action visualization overlay.
 * See docs/blueprints/2026-09-27-p1-interaction-layer.md (state C).
 */
import type { Tab } from './tabs'
import { displayParts } from '../shared/hotkeys'
import { loadSettings } from './settings'

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
  | {
      kind: 'annotationResult'
      annotationId: string
      ok: boolean
      error?: string
      warning?: string
      elementCount?: number
    }
  | { kind: 'hideAll' }

export function overlaySend(tab: Tab, cmd: OverlayCommand): void {
  try {
    const wc = tab.view.webContents
    if (!wc.isDestroyed()) wc.send('overlay:cmd', cmd)
  } catch {
    /* visualization must never break tool execution */
  }
}

/**
 * Emergency-stop state ("neutral gear"):
 * once paused, the browser refuses EVERY AI tool call until the user resumes
 * (a new user message or the resume control in the window).
 */
const takeover = { paused: false, pausedAt: 0, activeUntil: 0 }

/** Mark an AI activity window (kept for visualization/status decisions). */
export function markAiActive(ms: number): void {
  takeover.activeUntil = Date.now() + ms
}

/** Latch the emergency stop on. Returns true when it was not already paused. */
export function pauseAi(): boolean {
  const newly = !takeover.paused
  takeover.paused = true
  takeover.pausedAt = Date.now()
  return newly
}

/** Clear the emergency-stop latch. Returns true when it was paused before. */
export function resumeAi(): boolean {
  const was = takeover.paused
  takeover.paused = false
  return was
}

export function isAiPaused(): boolean {
  return takeover.paused
}

export function aiPausedAt(): number {
  return takeover.pausedAt
}

export function hideAllVisuals(tab: Tab | null): void {
  if (tab) overlaySend(tab, { kind: 'hideAll' })
}

/**
 * Build the emergency-stop hint from the configured keys ("F2 急停"). Esc is
 * reserved for the annotation UI, so a non-Esc key is preferred when present.
 */
export function formatTakeoverHint(keys: string[]): string {
  const usable = keys.filter((k) => typeof k === 'string' && k.length > 0)
  const key = usable.find((k) => k !== 'Escape') ?? usable[0]
  if (!key) return '急停（未设置快捷键）'
  return `${displayParts(key).join('+')} 急停`
}

/** The takeover hint for the current settings (dynamic — stop keys are configurable). */
export function takeoverHint(): string {
  try {
    return formatTakeoverHint(loadSettings().emergencyStopKeys)
  } catch {
    return '急停'
  }
}
