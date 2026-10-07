/**
 * End-to-end smoke test: acts as an MCP client (like opencode would),
 * spawns the stdio bridge, and drives the real browser.
 *
 * Prereq: npm run build && npm run build:bridge
 * Usage:  node tests/smoke.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const bridge = path.join(root, 'dist-bridge', 'index.cjs')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function ok(label, cond, extra = '') {
  const mark = cond ? 'PASS' : 'FAIL'
  console.log(`[${mark}] ${label}${extra ? ' — ' + extra : ''}`)
  if (!cond) process.exitCode = 1
}

function firstText(result) {
  const item = (result?.content ?? []).find((c) => c.type === 'text')
  return item?.text ?? ''
}

async function main() {
  console.log('smoke: spawning bridge (this may auto-start the browser)...')
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bridge],
    cwd: root,
    stderr: 'inherit'
  })
  const client = new Client({ name: 'cobrowse-smoke', version: '0.1.0' })

  const timeout = setTimeout(() => {
    console.error('smoke: global timeout (120s)')
    process.exit(2)
  }, 120_000)

  await client.connect(transport)
  console.log('smoke: connected to bridge')

  const tools = await client.listTools()
  const names = tools.tools.map((t) => t.name).sort()
  ok('tools listed', names.length >= 15, `${names.length} tools`)
  console.log('       tools:', names.join(', '))

  const tabs = await client.callTool({ name: 'list_tabs', arguments: {} })
  ok('list_tabs works', firstText(tabs).includes('"id"'))

  const nav = await client.callTool({
    name: 'navigate',
    arguments: { url: 'https://example.com' }
  })
  const navText = firstText(nav)
  ok('navigate works', navText.includes('example.com'), navText.replace(/\s+/g, ' ').slice(0, 120))

  const snap = await client.callTool({ name: 'snapshot', arguments: {} })
  const snapText = firstText(snap)
  ok('snapshot has refs', /\[e\d+\]/.test(snapText), `${snapText.length} chars`)
  console.log('       snapshot head:', snapText.split('\n').slice(0, 8).join(' | ').slice(0, 260))

  const shot = await client.callTool({ name: 'screenshot', arguments: {} })
  const img = (shot?.content ?? []).find((c) => c.type === 'image')
  ok('screenshot returns image', !!img && img.data.length > 1000, `${img ? img.data.length : 0} b64 chars`)

  const query = await client.callTool({
    name: 'query',
    arguments: { selector: 'p' }
  })
  const qText = firstText(query)
  const qJson = JSON.parse(qText)
  ok('query finds elements', qJson.total >= 1, qText.replace(/\s+/g, ' ').slice(0, 100))

  // ---------- overlay visualization + fixture interaction ----------
  console.log('smoke: overlay + fixture checks')

  const fixtureUrl = pathToFileURL(path.join(root, 'tests', 'fixture.html')).href
  const nav2 = await client.callTool({ name: 'navigate', arguments: { url: fixtureUrl } })
  ok('fixture navigated', firstText(nav2).includes('Duplex'), firstText(nav2).replace(/\s+/g, ' ').slice(0, 100))

  const overlayCheck = await client.callTool({
    name: 'evaluate',
    arguments: {
      script:
        "const h = document.getElementById('__cobrowse_overlay_host'); return { present: !!h, shadow: !!(h && h.shadowRoot) }"
    }
  })
  const oc = JSON.parse(firstText(overlayCheck))
  ok('overlay host injected into page', oc.present === true && oc.shadow === true, JSON.stringify(oc))

  const snap2 = await client.callTool({ name: 'snapshot', arguments: {} })
  const snap2Text = firstText(snap2)
  const btnMatch = snap2Text.match(/\[(e\d+)\][^\n]*<button[^>]*>[^\n]*"点我"/)
  const btnRef = btnMatch ? btnMatch[1] : null
  ok('fixture button ref found in snapshot', !!btnRef, btnRef ?? snap2Text.split('\n').slice(0, 6).join(' | '))

  if (btnRef) {
    const clickT0 = Date.now()
    await client.callTool({ name: 'click', arguments: { target: btnRef } })
    const clickDur = Date.now() - clickT0
    const readStatus = async () =>
      JSON.parse(
        firstText(
          await client.callTool({
            name: 'evaluate',
            arguments: {
              script:
                "const out = document.getElementById('out') && document.getElementById('out').textContent; const h = document.getElementById('__cobrowse_overlay_host'); const s = h && h.shadowRoot && h.shadowRoot.querySelector('.cb-status'); return { out: out, statusVisible: !!(s && s.classList.contains('visible')), statusText: s ? s.textContent.trim() : '' }"
            }
          })
        )
      )
    let ac = await readStatus()
    if (!ac.statusVisible) {
      await sleep(250)
      ac = await readStatus()
    }
    ok('click took real effect', ac.out === 'clicked!', `#out="${ac.out}"`)
    ok(
      'status bar visible after click (ttl window)',
      ac.statusVisible === true,
      `click=${clickDur}ms | ${ac.statusText.replace(/\s+/g, ' ')}`
    )
  }

  const typeRes = await client.callTool({
    name: 'type',
    arguments: { target: '#field', text: 'hello cobrowse' }
  })
  const tr = JSON.parse(firstText(typeRes))
  ok('type reports filled honestly', tr.filled === true, JSON.stringify(tr).slice(0, 140))

  const scrollRes = await client.callTool({ name: 'scroll', arguments: { dy: 500 } })
  const sr = JSON.parse(firstText(scrollRes))
  ok('scroll moved the page', (sr.scrollY ?? 0) >= 300, JSON.stringify(sr))

  // ---------- toolset additions + search ----------
  console.log('smoke: toolset additions (hover/dblclick/drag/select/wait/console/keys/search)')

  const hoverRes = await client.callTool({ name: 'hover', arguments: { target: '#hovertarget' } })
  ok('hover call ok', firstText(hoverRes).includes('"hovered": true'), firstText(hoverRes).replace(/\s+/g, ' ').slice(0, 80))
  const tilt = await client.callTool({
    name: 'evaluate',
    arguments: { script: "return document.getElementById('hovertip').style.display" }
  })
  ok('hover triggered mouseenter', firstText(tilt).includes('block'), firstText(tilt))

  await client.callTool({ name: 'dblclick', arguments: { target: '#dbl' } })
  const dbl = await client.callTool({
    name: 'evaluate',
    arguments: { script: "return document.getElementById('dbl').textContent" }
  })
  ok('dblclick works', firstText(dbl).includes('double-clicked'), firstText(dbl))

  const selRes = await client.callTool({
    name: 'select_option',
    arguments: { target: '#sel', option: '香蕉' }
  })
  ok('select_option works', firstText(selRes).includes('banana'), firstText(selRes).replace(/\s+/g, ' ').slice(0, 110))

  await client.callTool({ name: 'drag', arguments: { from: '#dragme', to: '#sel' } })
  const dragPos = await client.callTool({
    name: 'evaluate',
    arguments: { script: "return document.getElementById('dragpos').textContent" }
  })
  ok('drag moves element', /moved \d+/.test(firstText(dragPos)), firstText(dragPos))

  const waitOk = await client.callTool({ name: 'wait', arguments: { text: '页面底部' } })
  ok('wait finds existing text', firstText(waitOk).includes('"found": true'), firstText(waitOk).replace(/\s+/g, ' ').slice(0, 90))
  const waitMiss = await client.callTool({ name: 'wait', arguments: { selector: '#nope', timeout: 800 } })
  ok('wait times out honestly', firstText(waitMiss).includes('"found": false'), firstText(waitMiss).replace(/\s+/g, ' ').slice(0, 90))

  const consoleRes = await client.callTool({ name: 'get_console', arguments: {} })
  ok('get_console captured fixture log', firstText(consoleRes).includes('fixture-loaded'), firstText(consoleRes).replace(/\s+/g, ' ').slice(0, 130))

  await client.callTool({ name: 'type', arguments: { target: '#field', text: 'abcdef' } })
  await client.callTool({ name: 'press', arguments: { key: 'Control+A' } })
  const selRangeRaw = await client.callTool({
    name: 'evaluate',
    arguments: { script: "const el = document.getElementById('field'); return { s: el.selectionStart, e: el.selectionEnd, len: el.value.length }" }
  })
  const selRange = JSON.parse(firstText(selRangeRaw))
  ok('Control+A selects the field text', selRange.s === 0 && selRange.e === selRange.len && selRange.len >= 6, JSON.stringify(selRange))

  // navigate treats free text as a search query (network)
  const navSearch = await client.callTool({ name: 'navigate', arguments: { url: 'python 教程' } })
  ok('navigate auto-searches free text', firstText(navSearch).includes('baidu.com'), firstText(navSearch).replace(/\s+/g, ' ').slice(0, 110))

  const searchRes = await client.callTool({ name: 'search', arguments: { query: 'Duplex 测试' } })
  const st2 = firstText(searchRes)
  ok('search tool opens baidu', st2.includes('baidu.com'), st2.replace(/\s+/g, ' ').slice(0, 110))

  // ---------- P1b: human annotation flow ----------
  console.log('smoke: annotation flow (draw -> question -> injection queue -> undo -> exit)')

  // Pause plugin consumption for this section: the test exercises the queue
  // itself, so nothing pollutes real opencode sessions.
  const ep = JSON.parse(
    fs.readFileSync(path.join(os.homedir(), '.cobrowse', 'endpoint.json'), 'utf8')
  )
  const auth = { authorization: `Bearer ${ep.token}`, 'content-type': 'application/json' }
  await fetch(`http://127.0.0.1:${ep.port}/api/injections/pause`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ paused: true })
  })

  await client.callTool({ name: 'navigate', arguments: { url: fixtureUrl } })
  await client.callTool({ name: 'annotation_mode', arguments: { active: true } })

  const modeCheck = JSON.parse(
    firstText(
      await client.callTool({
        name: 'evaluate',
        arguments: {
          script:
            "const h = document.getElementById('__cobrowse_overlay_host'); const sr = h && h.shadowRoot; const t = sr && sr.querySelector('.cb-annot-tools'); return { toolsVisible: !!(t && t.classList.contains('visible')) }"
        }
      })
    )
  )
  ok('annotation mode shows the tool pill', modeCheck.toolsVisible === true, JSON.stringify(modeCheck))

  // The pill must be its own hit layer: clicks must NOT fall through to the
  // drawing layer (this is the bug users hit when switching tools).
  const hitTest = JSON.parse(
    firstText(
      await client.callTool({
        name: 'evaluate',
        arguments: {
          script:
            "const sr = document.getElementById('__cobrowse_overlay_host').shadowRoot; const btn = sr.querySelector('button[data-tool=\"circle\"]'); const r = btn.getBoundingClientRect(); const hit = sr.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)); return { hitIsButton: hit === btn, hitTag: hit ? (hit.getAttribute ? (hit.getAttribute('data-tool') || hit.tagName) : '') : 'null' }"
        }
      })
    )
  )
  ok('tool picker is its own hit layer (no fall-through)', hitTest.hitIsButton === true, JSON.stringify(hitTest))

  // dragging the whole picker bar moves it; position becomes free (left/top)
  const dragPill = JSON.parse(
    firstText(
      await client.callTool({
        name: 'evaluate',
        arguments: {
          script:
            "const sr = document.getElementById('__cobrowse_overlay_host').shadowRoot; const tools = sr.querySelector('.cb-annot-tools'); const r = tools.getBoundingClientRect(); tools.dispatchEvent(new MouseEvent('mousedown', { clientX: r.left + 6, clientY: r.top + 6, bubbles: true, button: 0 })); window.dispatchEvent(new MouseEvent('mousemove', { clientX: r.left + 30, clientY: r.top + 20, bubbles: true })); window.dispatchEvent(new MouseEvent('mousemove', { clientX: r.left + 50, clientY: r.top + 40, bubbles: true })); window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); const after = tools.getBoundingClientRect(); return { left: tools.style.left, top: tools.style.top, moved: after.left > r.left }"
        }
      })
    )
  )
  ok(
    'tool picker can be dragged to a new position',
    dragPill.moved === true && !!dragPill.left && !!dragPill.top,
    JSON.stringify(dragPill)
  )
  // do not leak the dragged position into later runs
  await client.callTool({
    name: 'evaluate',
    arguments: {
      script:
        "try { localStorage.removeItem('cobrowse-annot-tools-pos') } catch (e) {} return 'cleared'"
    }
  })

  const drawScript = (x1, y1, x2, y2) =>
    "const sr = document.getElementById('__cobrowse_overlay_host').shadowRoot;\n" +
    "const layer = sr.querySelector('.cb-annot-layer');\n" +
    `const x1 = ${x1}, y1 = ${y1}, x2 = ${x2}, y2 = ${y2};\n` +
    "layer.dispatchEvent(new MouseEvent('mousedown', { clientX: x1, clientY: y1, bubbles: true, button: 0 }));\n" +
    "window.dispatchEvent(new MouseEvent('mousemove', { clientX: (x1 + x2) / 2, clientY: (y1 + y2) / 2, bubbles: true }));\n" +
    "window.dispatchEvent(new MouseEvent('mousemove', { clientX: x2, clientY: y2, bubbles: true }));\n" +
    "window.dispatchEvent(new MouseEvent('mouseup', { clientX: x2, clientY: y2, bubbles: true }));\n" +
    "return 'drawn'"

  const box = JSON.parse(
    firstText(
      await client.callTool({
        name: 'evaluate',
        arguments: {
          script:
            "const a = document.getElementById('hello').getBoundingClientRect(); const b = document.getElementById('out').getBoundingClientRect(); return { x1: Math.round(a.left - 12), y1: Math.round(a.top - 12), x2: Math.round(b.right + 12), y2: Math.round(b.bottom + 12) }"
        }
      })
    )
  )
  await client.callTool({
    name: 'evaluate',
    arguments: { script: drawScript(box.x1, box.y1, box.x2, box.y2) }
  })

  const cardCheck = JSON.parse(
    firstText(
      await client.callTool({
        name: 'evaluate',
        arguments: {
          script:
            "const sr = document.getElementById('__cobrowse_overlay_host').shadowRoot; const c = sr.querySelector('.cb-annot-card'); return { visible: c.classList.contains('visible'), markers: sr.querySelectorAll('.cb-marker').length }"
        }
      })
    )
  )
  ok(
    'question card appears after drawing a box',
    cardCheck.visible === true && cardCheck.markers === 1,
    JSON.stringify(cardCheck)
  )

  const cardHit = JSON.parse(
    firstText(
      await client.callTool({
        name: 'evaluate',
        arguments: {
          script:
            "const sr = document.getElementById('__cobrowse_overlay_host').shadowRoot; const ta = sr.querySelector('.cb-card-input'); const r = ta.getBoundingClientRect(); const hit = sr.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)); return { hitIsInput: hit === ta, hitTag: hit ? (hit.tagName || '') : 'null' }"
        }
      })
    )
  )
  ok('question card is clickable (own hit layer)', cardHit.hitIsInput === true, JSON.stringify(cardHit))

  // Deterministic delivery: switch the panel to opencode mode via the dev-only
  // debug action so the annotation lands in the injection queue. Ignore when
  // the app was started without COBROWSE_DEBUG_UI=1.
  await fetch(`http://127.0.0.1:${ep.port}/api/debug/ui-action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...auth },
    body: JSON.stringify({ action: 'panel-mode:opencode' })
  }).catch(() => {})
  await sleep(300)

  await client.callTool({
    name: 'evaluate',
    arguments: {
      script:
        "const sr = document.getElementById('__cobrowse_overlay_host').shadowRoot; const c = sr.querySelector('.cb-annot-card'); c.querySelector('.cb-card-input').value = '这个按钮是做什么的？'; c.querySelector('.cb-send').click(); return 'sent'"
    }
  })
  await sleep(800)

  const queue = await fetch(`http://127.0.0.1:${ep.port}/api/injections`, {
    headers: auth
  }).then((r) => r.json())
  const annotInj = Array.isArray(queue) ? queue.find((i) => i.source === 'annotation') : null
  let annotText = annotInj ? annotInj.text : null
  if (!annotText) {
    // A running opencode instance long-polls the queue and may already have
    // consumed the annotation — fall back to the mirrored annotation event.
    const events = await fetch(`http://127.0.0.1:${ep.port}/api/mirror/events?limit=200`, {
      headers: auth
    }).then((r) => r.json())
    const ev = Array.isArray(events)
      ? [...events].reverse().find((e) => e.kind === 'annotation')
      : null
    if (ev) annotText = ev.text
  }
  ok(
    'annotation delivered (queue or mirrored event)',
    !!annotText,
    annotText ? annotText.split('\n')[0] : `queue=${JSON.stringify(queue).slice(0, 80)}`
  )
  if (annotText) {
    ok('annotation text contains the question', annotText.includes('这个按钮是做什么的？'))
    ok(
      'annotation has code-layer anchors',
      annotText.includes('#hello') || annotText.includes('button')
    )
    if (annotInj) {
      await fetch(`http://127.0.0.1:${ep.port}/api/injections/ack`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...auth },
        body: JSON.stringify({ id: annotInj.id })
      })
    }
  }

  const box2 = JSON.parse(
    firstText(
      await client.callTool({
        name: 'evaluate',
        arguments: {
          script:
            "const f = document.getElementById('field').getBoundingClientRect(); return { x1: Math.round(f.left - 12), y1: Math.round(f.top - 12), x2: Math.round(f.right + 12), y2: Math.round(f.bottom + 12) }"
        }
      })
    )
  )
  await client.callTool({
    name: 'evaluate',
    arguments: { script: drawScript(box2.x1, box2.y1, box2.x2, box2.y2) }
  })
  const markers2 = JSON.parse(
    firstText(
      await client.callTool({
        name: 'evaluate',
        arguments: {
          script:
            "const sr = document.getElementById('__cobrowse_overlay_host').shadowRoot; return { markers: sr.querySelectorAll('.cb-marker').length }"
        }
      })
    )
  )
  ok(
    'continuous annotation creates a second box',
    markers2.markers === 2,
    JSON.stringify(markers2)
  )

  const afterRemove = JSON.parse(
    firstText(
      await client.callTool({
        name: 'evaluate',
        arguments: {
          script:
            "const sr = document.getElementById('__cobrowse_overlay_host').shadowRoot; const ms = sr.querySelectorAll('.cb-marker'); ms[ms.length - 1].querySelector('.remove').click(); return { markers: sr.querySelectorAll('.cb-marker').length }"
        }
      })
    )
  )
  ok('per-box undo (×) removes only that box', afterRemove.markers === 1, JSON.stringify(afterRemove))

  // tool variants: circle, arrow, point
  const pickTool = async (name) => {
    await client.callTool({
      name: 'evaluate',
      arguments: {
        script: `const sr = document.getElementById('__cobrowse_overlay_host').shadowRoot; sr.querySelector('button[data-tool="${name}"]').click(); return '${name}'`
      }
    })
  }
  const escCard = async () => {
    await client.callTool({
      name: 'evaluate',
      arguments: {
        script:
          "window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return 'esc'"
      }
    })
    await sleep(150)
  }

  await pickTool('circle')
  await client.callTool({
    name: 'evaluate',
    arguments: { script: drawScript(box2.x1, box2.y1, box2.x2, box2.y2) }
  })
  const circleCheck = JSON.parse(
    firstText(
      await client.callTool({
        name: 'evaluate',
        arguments: {
          script:
            "const sr = document.getElementById('__cobrowse_overlay_host').shadowRoot; return { circle: sr.querySelectorAll('.cb-marker.circle').length }"
        }
      })
    )
  )
  ok('circle tool creates a circular marker', circleCheck.circle === 1, JSON.stringify(circleCheck))
  await escCard()

  await pickTool('arrow')
  await client.callTool({
    name: 'evaluate',
    arguments: {
      script: drawScript(box2.x1, box2.y1, box2.x2 + 80, box2.y2 + 50)
    }
  })
  const arrowCheck = JSON.parse(
    firstText(
      await client.callTool({
        name: 'evaluate',
        arguments: {
          script:
            "const sr = document.getElementById('__cobrowse_overlay_host').shadowRoot; return { arrow: sr.querySelectorAll('.cb-marker.arrow').length, svg: sr.querySelectorAll('.cb-marker.arrow svg').length }"
        }
      })
    )
  )
  ok(
    'arrow tool creates an arrow with svg head',
    arrowCheck.arrow === 1 && arrowCheck.svg === 1,
    JSON.stringify(arrowCheck)
  )
  await escCard()

  await pickTool('point')
  const helloCenter = JSON.parse(
    firstText(
      await client.callTool({
        name: 'evaluate',
        arguments: {
          script:
            "const r = document.getElementById('hello').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }"
        }
      })
    )
  )
  await client.callTool({
    name: 'evaluate',
    arguments: {
      script:
        "const sr = document.getElementById('__cobrowse_overlay_host').shadowRoot;\n" +
        "const layer = sr.querySelector('.cb-annot-layer');\n" +
        `const x = ${helloCenter.x}, y = ${helloCenter.y};\n` +
        "layer.dispatchEvent(new MouseEvent('mousedown', { clientX: x, clientY: y, bubbles: true, button: 0 }));\n" +
        "window.dispatchEvent(new MouseEvent('mouseup', { clientX: x, clientY: y, bubbles: true }));\n" +
        "return 'picked'"
    }
  })
  const pointCheck = JSON.parse(
    firstText(
      await client.callTool({
        name: 'evaluate',
        arguments: {
          script:
            "const sr = document.getElementById('__cobrowse_overlay_host').shadowRoot; return { point: sr.querySelectorAll('.cb-marker.point').length }"
        }
      })
    )
  )
  ok('point tool picks the element under the cursor', pointCheck.point === 1, JSON.stringify(pointCheck))
  await escCard()

  await client.callTool({
    name: 'evaluate',
    arguments: {
      script:
        "window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return 'esc'"
    }
  })
  await sleep(400)
  const exited = JSON.parse(
    firstText(
      await client.callTool({
        name: 'evaluate',
        arguments: {
          script:
            "const sr = document.getElementById('__cobrowse_overlay_host').shadowRoot; const t = sr.querySelector('.cb-annot-tools'); return { toolsVisible: t.classList.contains('visible') }"
        }
      })
    )
  )
  ok('Esc exits annotation mode', exited.toolsVisible === false, JSON.stringify(exited))

  const stillWorks = firstText(await client.callTool({ name: 'list_tabs', arguments: {} }))
  ok(
    'annotation Esc did not trigger AI takeover',
    stillWorks.includes('"id"') && !stillWorks.includes('用户已接管')
  )

  // release the queue and drop any leftovers the test produced
  try {
    await fetch(`http://127.0.0.1:${ep.port}/api/injections`, { headers: auth })
    await fetch(`http://127.0.0.1:${ep.port}/api/injections/pause`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ paused: false })
    })
  } catch {
    /* ignore */
  }

  await client.close()
  clearTimeout(timeout)
  console.log(process.exitCode ? '\nsmoke: FAILED' : '\nsmoke: ALL PASSED')
  process.exit(process.exitCode ?? 0)
}

main().catch((e) => {
  console.error('smoke: fatal:', e)
  process.exit(1)
})
