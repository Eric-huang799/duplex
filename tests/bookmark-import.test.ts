import { describe, expect, it } from 'vitest'
import { parseChromeBookmarksJson, parseNetscapeBookmarks } from '../src/main/bookmark-import'

const CHROME_EXPORT = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<!-- This is an automatically generated file.
     It will be read and overwritten.
     DO NOT EDIT! -->
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><H3 ADD_DATE="1696000000" LAST_MODIFIED="1697000000" PERSONAL_TOOLBAR_FOLDER="true">书签栏</H3>
    <DL><p>
        <DT><A HREF="https://example.com/" ADD_DATE="1696000100">Example</A>
        <DT><A HREF="https://news.ycombinator.com/" ADD_DATE="1696000200" ICON="data:image/png;base64,AAAA">Hacker News</A>
        <DT><H3 ADD_DATE="1696000300">开发</H3>
        <DL><p>
            <DT><A HREF="https://github.com/" ADD_DATE="1696000400">GitHub</A>
            <DT><A HREF="https://developer.mozilla.org/" ADD_DATE="1696000500">MDN</A>
        </DL><p>
        <DT><A HREF="https://web.archive.org/" ADD_DATE="1696000550">Wayback</A>
    </DL><p>
    <DT><A HREF="https://standalone.example.org/" ADD_DATE="1696000600">顶层独立书签</A>
</DL><p>
`

describe('netscape bookmark HTML parser', () => {
  it('parses chrome/edge exports into flat bookmark records', () => {
    const out = parseNetscapeBookmarks(CHROME_EXPORT)
    expect(out.map((b) => b.url)).toEqual([
      'https://example.com/',
      'https://news.ycombinator.com/',
      'https://github.com/',
      'https://developer.mozilla.org/',
      'https://web.archive.org/',
      'https://standalone.example.org/'
    ])
  })

  it('maps the toolbar root folder to uncategorized and keeps nested folders', () => {
    const out = parseNetscapeBookmarks(CHROME_EXPORT)
    const byUrl = new Map(out.map((b) => [b.url, b]))
    // 书签栏 is the depth-1 toolbar folder → transparent (uncategorized)
    expect(byUrl.get('https://example.com/')?.folder).toBeUndefined()
    expect(byUrl.get('https://web.archive.org/')?.folder).toBeUndefined()
    // 开发 is nested one level deeper → kept as a folder
    expect(byUrl.get('https://github.com/')?.folder).toBe('开发')
    expect(byUrl.get('https://developer.mozilla.org/')?.folder).toBe('开发')
    expect(byUrl.get('https://standalone.example.org/')?.folder).toBeUndefined()
  })

  it('converts ADD_DATE unix seconds to milliseconds and keeps decoded titles', () => {
    const out = parseNetscapeBookmarks(CHROME_EXPORT)
    const gh = out.find((b) => b.url === 'https://github.com/')
    expect(gh?.title).toBe('GitHub')
    expect(gh?.addedAt).toBe(1696000400 * 1000)
    const amp = parseNetscapeBookmarks('<DL><p><DT><A HREF="https://a.com/?x=1&amp;y=2">A &amp; B</A>')
    expect(amp[0]?.title).toBe('A & B')
    expect(amp[0]?.url).toBe('https://a.com/?x=1&y=2')
  })

  it('skips non-http urls and tolerates malformed input', () => {
    const messy = `<DL><p>
      <DT><A HREF="javascript:void(0)" ADD_DATE="1696000100">bad scheme</A>
      <DT><A HREF="https://ok.example.com/">ok</A>
      <DT><A>no href</A>
      <DT><A HREF="https://nodate.example.com/">no date</A>
    </DL><p>`
    const out = parseNetscapeBookmarks(messy)
    expect(out.map((b) => b.url)).toEqual(['https://ok.example.com/', 'https://nodate.example.com/'])
    expect(out[0]!.addedAt).toBeGreaterThan(0)
    expect(out[1]!.addedAt).toBeGreaterThan(0)
  })
})

const LOCAL_CHROME_BOOKMARKS = JSON.stringify({
  roots: {
    bookmark_bar: {
      name: '书签栏',
      children: [
        { type: 'url', name: 'Example', url: 'https://example.com/', date_added: '13360000000000000' },
        {
          type: 'folder',
          name: '开发',
          children: [
            { type: 'url', name: 'GitHub', url: 'https://github.com/', date_added: '13360000001000000' }
          ]
        }
      ]
    },
    other: { name: '其他书签', children: [{ type: 'url', name: 'Wayback', url: 'https://web.archive.org/' }] },
    synced: { name: '手机书签', children: [] }
  }
})

describe('chrome/edge bookmarks JSON (direct local import)', () => {
  it('flattens roots into records with labeled folder chains', () => {
    const out = parseChromeBookmarksJson(LOCAL_CHROME_BOOKMARKS, 'Chrome')
    expect(out.map((b) => b.url)).toEqual([
      'https://example.com/',
      'https://github.com/',
      'https://web.archive.org/'
    ])
    expect(out[0]?.folder).toBe('Chrome / 书签栏')
    expect(out[1]?.folder).toBe('Chrome / 书签栏 / 开发')
    expect(out[2]?.folder).toBe('Chrome / 其他书签')
  })

  it('converts chrome epoch microseconds and falls back when missing', () => {
    const out = parseChromeBookmarksJson(LOCAL_CHROME_BOOKMARKS, 'Chrome')
    expect(out[0]?.addedAt).toBe((13360000000000000 - 11644473600000000) / 1000)
    const noTime = parseChromeBookmarksJson(
      '{"roots":{"other":{"children":[{"type":"url","url":"https://a.io/"}]}}}',
      'Edge'
    )
    expect(noTime[0]?.addedAt).toBeGreaterThan(1600000000000)
  })

  it('skips non-http urls and tolerates broken json', () => {
    const mixed = parseChromeBookmarksJson(
      '{"roots":{"bookmark_bar":{"children":[{"type":"url","name":"x","url":"chrome://settings/"},{"type":"url","name":"y","url":"https://ok.io/"}]}}}',
      'Chrome'
    )
    expect(mixed.map((b) => b.url)).toEqual(['https://ok.io/'])
    expect(parseChromeBookmarksJson('not json at all', 'Chrome')).toEqual([])
  })
})
