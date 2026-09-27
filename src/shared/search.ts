/** Search engines + query URL building (shared by address bar, tools, and tests). */
export const SEARCH_ENGINES = {
  baidu: { name: '百度', url: 'https://www.baidu.com/s?wd=%s' },
  bing: { name: '必应', url: 'https://cn.bing.com/search?q=%s' },
  google: { name: 'Google', url: 'https://www.google.com/search?q=%s' }
} as const

export type SearchEngine = keyof typeof SEARCH_ENGINES

export const DEFAULT_ENGINE: SearchEngine = 'baidu'

export function searchUrl(query: string, engine?: string): string {
  const key = (engine && engine in SEARCH_ENGINES ? engine : DEFAULT_ENGINE) as SearchEngine
  return SEARCH_ENGINES[key].url.replace('%s', encodeURIComponent(query))
}
