/** Main-process translation helper (menus, dialogs, IPC error text). */
import { translate, type I18nKey, type Lang } from '../shared/i18n'

let lang: Lang = 'zh'

/** Called once at startup and whenever the user changes the language setting. */
export function setMainLanguage(next: Lang): void {
  lang = next
}

export function currentLang(): Lang {
  return lang
}

/** Translate a UI string for the main process. */
export function mt(key: I18nKey, vars?: Record<string, string | number>): string {
  return translate(lang, key, vars)
}
