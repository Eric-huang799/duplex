import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { resolveLang, translate, type I18nKey, type Lang, type LangSetting } from '../../shared/i18n'

interface I18nValue {
  lang: Lang
  setting: LangSetting
  t: (key: I18nKey, vars?: Record<string, string | number>) => string
  setLanguage: (next: LangSetting) => void
}

const fallback: I18nValue = {
  lang: 'zh',
  setting: 'system',
  t: (key, vars) => translate('zh', key, vars),
  setLanguage: () => {}
}

const I18nContext = createContext<I18nValue>(fallback)

export function I18nProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [setting, setSetting] = useState<LangSetting>('system')
  const [systemLocale, setSystemLocale] = useState(() => navigator.language)

  useEffect(() => {
    void window.cobrowse.languageGet().then((s) => {
      setSetting(s.language === 'zh' || s.language === 'en' ? s.language : 'system')
      if (s.systemLocale) setSystemLocale(s.systemLocale)
    })
    return window.cobrowse.onLanguageChanged((l) => {
      setSetting(l === 'zh' || l === 'en' ? l : 'system')
    })
  }, [])

  const lang = resolveLang(setting, systemLocale)

  useEffect(() => {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en'
  }, [lang])

  const t = useCallback(
    (key: I18nKey, vars?: Record<string, string | number>) => translate(lang, key, vars),
    [lang]
  )

  const setLanguage = useCallback((next: LangSetting) => {
    setSetting(next)
    void window.cobrowse.languageSet(next)
  }, [])

  const value = useMemo(() => ({ lang, setting, t, setLanguage }), [lang, setting, t, setLanguage])
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18nValue {
  return useContext(I18nContext)
}
