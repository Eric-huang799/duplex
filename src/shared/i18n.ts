/**
 * App UI language: stored as a setting ("system" follows the OS locale).
 * The dictionary is shared by the renderer and the main process; every entry
 * is a [zh, en] pair so both languages stay in one place.
 */
export type Lang = 'zh' | 'en'
export type LangSetting = 'system' | Lang

export function isValidLangSetting(v: unknown): v is LangSetting {
  return v === 'system' || v === 'zh' || v === 'en'
}

/** Resolve the stored setting against an OS locale tag (zh* → zh, everything else → en). */
export function resolveLang(setting: LangSetting, systemLocale: string): Lang {
  if (setting !== 'system') return setting
  return /^zh([-_]|$)/i.test(systemLocale) ? 'zh' : 'en'
}

import RAW_TEXT from './i18n-text.json'

const TEXT = RAW_TEXT as unknown as Record<string, readonly [string, string]>

export type I18nKey = keyof typeof RAW_TEXT

/** Look up a UI string; unknown keys fall back to the key itself (zh side). */
export function translate(lang: Lang, key: I18nKey, vars?: Record<string, string | number>): string {
  const pair = TEXT[key]
  let text: string = pair ? pair[lang === 'en' ? 1 : 0] : key
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      text = text.replaceAll(`{${name}}`, String(value))
    }
  }
  return text
}
