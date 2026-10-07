/**
 * Scripts executed inside page context via CDP Runtime.evaluate.
 * Every script is a self-contained IIFE expression.
 *
 * The snapshot script builds a compact text DOM outline where meaningful
 * elements get stable [eN] refs. Refs are valid until the next snapshot or
 * page navigation. The ref map lives on window.__cobrowse.refMap.
 */

export function buildSnapshotScript(): string {
  return `(() => {
  const MAX_LINES = 400;
  const refMap = new Map();
  let nextRef = 1;
  const lines = [];
  let truncated = false;
  let emittedCount = 0;

  const SKIP = new Set(['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','META','LINK','HEAD','BR','WBR','SVG','svg']);
  const INTERACTIVE = new Set(['A','BUTTON','INPUT','SELECT','TEXTAREA','SUMMARY','DETAILS','LABEL','OPTION','IFRAME']);

  const clean = (s, max) => (s == null ? '' : String(s)).replace(/\\s+/g, ' ').trim().slice(0, max || 60);

  const isVisible = (el) => {
    try {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return false;
      const cs = getComputedStyle(el);
      return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
    } catch (e) { return false; }
  };

  const fmtTag = (el) => {
    const tag = el.tagName.toLowerCase();
    let s = tag;
    if (el.id) s += '#' + clean(el.id, 32);
    let cls = '';
    if (typeof el.className === 'string') cls = el.className;
    const parts = cls.split(/\\s+/).filter(Boolean);
    if (parts.length) {
      s += '.' + parts.slice(0, 2).map(c => c.slice(0, 24)).join('.');
      if (parts.length > 2) s += '+' + (parts.length - 2);
    }
    return s;
  };

  const directText = (el) => {
    let t = '';
    for (const n of el.childNodes) {
      if (n.nodeType === 3) t += n.textContent;
    }
    return t;
  };

  const walk = (el, depth) => {
    if (truncated) return;
    const tag = el.tagName;
    if (!tag || SKIP.has(tag)) return;
    if (!isVisible(el)) return;

    const role = el.getAttribute('role');
    const ariaLabel = el.getAttribute('aria-label');
    const interactive = INTERACTIVE.has(tag) || !!role;
    const hasId = !!el.id;
    const childEls = Array.from(el.children);
    const leaf = childEls.length === 0;
    const text = clean(leaf ? el.textContent : directText(el), 60);
    const meaningful = interactive || hasId || !!ariaLabel || text.length >= 2;

    let emitted = false;
    if (meaningful) {
      if (emittedCount >= MAX_LINES) { truncated = true; return; }
      const ref = 'e' + (nextRef++);
      refMap.set(ref, el);
      let line = '  '.repeat(depth) + '[' + ref + '] <' + fmtTag(el) + '>';
      if (tag === 'INPUT') {
        const it = (el.type || 'text').toLowerCase();
        line += ' type=' + it;
        if (it !== 'password' && el.value) line += ' value="' + clean(el.value, 60) + '"';
        if (el.placeholder) line += ' placeholder="' + clean(el.placeholder, 60) + '"';
      } else if (tag === 'TEXTAREA') {
        line += ' type=textarea';
        if (el.value) line += ' value="' + clean(el.value, 60) + '"';
        if (el.placeholder) line += ' placeholder="' + clean(el.placeholder, 60) + '"';
      } else if (tag === 'SELECT') {
        const sel = el.options && el.selectedIndex >= 0 ? el.options[el.selectedIndex] : null;
        if (sel) line += ' selected="' + clean(sel.textContent, 40) + '"';
      } else if (tag === 'A') {
        const href = el.getAttribute('href');
        if (href) line += ' href="' + clean(href, 120) + '"';
      } else if (tag === 'IFRAME') {
        line += ' src="' + clean(el.getAttribute('src'), 120) + '"';
      }
      if (role) line += ' role=' + role;
      if (el.disabled) line += ' [disabled]';
      if (text) line += ' "' + text + '"';
      lines.push(line);
      emittedCount++;
      emitted = true;
    }

    // descend
    for (const c of childEls) {
      if (truncated) break;
      walk(c, emitted ? depth + 1 : depth);
    }
    // open shadow roots
    if (!truncated && el.shadowRoot) {
      for (const c of Array.from(el.shadowRoot.children)) {
        if (truncated) break;
        walk(c, depth + 1);
      }
    }
  };

  try {
    walk(document.body, 0);
  } catch (e) {
    lines.push('(outline error: ' + e.message + ')');
  }

  window.__cobrowse = window.__cobrowse || {};
  window.__cobrowse.refMap = refMap;

  const header = [
    'url: ' + location.href,
    'title: ' + document.title,
    'viewport: ' + innerWidth + 'x' + innerHeight + '  scrollY: ' + Math.round(scrollY) + ' / page: ' + Math.round(document.documentElement.scrollHeight),
    'refs: [eN] usable with click/type until next snapshot',
    '---'
  ].join('\\n');

  const footer = truncated ? '\\n--- (truncated at ' + MAX_LINES + ' lines; ' + (nextRef - 1) + ' refs total — use query/get_html for the rest)' : '';

  return header + '\\n' + lines.join('\\n') + footer;
})()`
}

export function buildResolveScript(target: string): string {
  const t = JSON.stringify(target)
  return `(() => {
  const target = ${t};
  let el = null;
  if (/^e\\d+$/.test(target)) {
    el = (window.__cobrowse && window.__cobrowse.refMap && window.__cobrowse.refMap.get(target)) || null;
    if (!el) return { error: 'ref ' + target + ' not found (page may have changed; call snapshot again)' };
  } else {
    try { el = document.querySelector(target); } catch (e) { return { error: 'invalid CSS selector: ' + target }; }
    if (!el) return { error: 'no element matches selector: ' + target };
  }
  if (!el.isConnected) return { error: 'element is detached (page changed); call snapshot again' };
  try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch (e) {}
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const visible = r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
  const cx = r.x + r.width / 2;
  const cy = r.y + r.height / 2;
  const x = Math.min(Math.max(cx, 1), innerWidth - 2);
  const y = Math.min(Math.max(cy, 1), innerHeight - 2);
  const clamped = x !== cx || y !== cy;
  return {
    ok: true,
    x: x, y: y,
    clamped: clamped || undefined,
    rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    visible: visible,
    tag: el.tagName.toLowerCase(),
    text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80),
    value: (el.value != null ? String(el.value) : undefined)
  };
})()`
}

export function buildFocusScript(target: string, clear: boolean): string {
  const t = JSON.stringify(target)
  return `(() => {
  const target = ${t};
  let el = null;
  if (/^e\\d+$/.test(target)) {
    el = (window.__cobrowse && window.__cobrowse.refMap && window.__cobrowse.refMap.get(target)) || null;
    if (!el) return { error: 'ref ' + target + ' not found; call snapshot again' };
  } else {
    try { el = document.querySelector(target); } catch (e) { return { error: 'invalid selector: ' + target }; }
    if (!el) return { error: 'no element matches selector: ' + target };
  }
  if (!el.isConnected) return { error: 'element is detached; call snapshot again' };
  try { el.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch (e) {}
  try { el.focus({ preventScroll: true }); } catch (e) {}
  const isField = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
  const editable = el.isContentEditable;
  if (${clear ? 'true' : 'false'}) {
    if (isField) { try { el.select(); } catch (e) {} }
    else if (editable) { try { document.execCommand('selectAll', false, undefined); } catch (e) {} }
  }
  const r = el.getBoundingClientRect();
  const label = (el.textContent || el.getAttribute('placeholder') || el.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim();
  return {
    ok: true,
    field: isField,
    editable: editable,
    tag: el.tagName.toLowerCase(),
    text: label.slice(0, 40),
    rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    cx: Math.round(r.x + r.width / 2),
    cy: Math.round(r.y + r.height / 2)
  };
})()`
}

export function buildReadValueScript(target: string): string {
  const t = JSON.stringify(target)
  return `(() => {
  const target = ${t};
  let el = null;
  if (/^e\\d+$/.test(target)) {
    el = (window.__cobrowse && window.__cobrowse.refMap && window.__cobrowse.refMap.get(target)) || null;
  } else {
    try { el = document.querySelector(target); } catch (e) {}
  }
  if (!el) return { error: 'element not found' };
  const isField = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
  const val = isField ? String(el.value) : (el.isContentEditable ? String(el.textContent) : '');
  return { value: val.slice(0, 200), length: val.length };
})()`
}

/** Scroll a selector into view (or report current scroll when selector is null). */
export function buildScrollScript(selector: string | null, dy: number, dx = 0): string {
  const sel = JSON.stringify(selector)
  return `(() => {
  const sel = ${sel};
  if (sel) {
    let el = null;
    if (/^e\\d+$/.test(sel)) {
      el = (window.__cobrowse && window.__cobrowse.refMap && window.__cobrowse.refMap.get(sel)) || null;
    } else {
      try { el = document.querySelector(sel); } catch (e) {}
    }
    if (!el) return { error: 'element not found: ' + sel };
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
  } else {
    window.scrollBy(${dx}, ${dy});
  }
  return { scrollX: Math.round(window.scrollX), scrollY: Math.round(window.scrollY), pageHeight: Math.round(document.documentElement.scrollHeight), viewportHeight: innerHeight };
})()`
}

/** Resolve BOTH drag endpoints after all scrolling; coordinates stay consistent. */
export function buildDragResolveScript(from: string, to: string): string {
  const f = JSON.stringify(from)
  const t = JSON.stringify(to)
  return `(() => {
  const resolveEl = (target) => {
    if (/^e\\d+$/.test(target)) {
      return (window.__cobrowse && window.__cobrowse.refMap && window.__cobrowse.refMap.get(target)) || null;
    }
    try { return document.querySelector(target); } catch (e) { return null; }
  };
  const fromEl = resolveEl(${f});
  if (!fromEl) return { error: 'from element not found: ' + ${f} };
  const toEl = resolveEl(${t});
  if (!toEl) return { error: 'to element not found: ' + ${t} };
  try { fromEl.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch (e) {}
  try { toEl.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch (e) {}
  const fr = fromEl.getBoundingClientRect();
  const tr = toEl.getBoundingClientRect();
  const cx = (r) => Math.min(Math.max(r.x + r.width / 2, 1), innerWidth - 2);
  const cy = (r) => Math.min(Math.max(r.y + r.height / 2, 1), innerHeight - 2);
  const rectOf = (r) => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) });
  const fromVisible = fr.width > 0 && fr.height > 0 && fr.bottom > 0 && fr.top < innerHeight && fr.right > 0 && fr.left < innerWidth;
  return {
    from: { x: cx(fr), y: cy(fr), rect: rectOf(fr), visible: fromVisible, tag: fromEl.tagName.toLowerCase(), text: (fromEl.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40) },
    to: { x: cx(tr), y: cy(tr), rect: rectOf(tr), tag: toEl.tagName.toLowerCase(), text: (toEl.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40) }
  };
})()`
}

/** Select an option in a native <select> by visible text or value. */
export function buildSelectScript(target: string, option: string): string {
  const t = JSON.stringify(target)
  const o = JSON.stringify(option)
  return `(() => {
  const target = ${t};
  const wanted = ${o};
  let el = null;
  if (/^e\\d+$/.test(target)) {
    el = (window.__cobrowse && window.__cobrowse.refMap && window.__cobrowse.refMap.get(target)) || null;
  } else {
    try { el = document.querySelector(target); } catch (e) { return { error: 'invalid selector: ' + target }; }
  }
  if (!el) return { error: 'element not found: ' + target };
  if (el.tagName !== 'SELECT') {
    return { error: 'target is not a native <select> (tag=' + el.tagName + '); for custom dropdowns, click the trigger then click the option element' };
  }
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim().toLowerCase();
  const w = norm(wanted);
  const opts = Array.from(el.options);
  const opt = opts.find(x => norm(x.textContent) === w)
    || opts.find(x => norm(x.value) === w)
    || opts.find(x => norm(x.textContent).includes(w))
    || opts.find(x => norm(x.value).includes(w));
  if (!opt) {
    return { error: 'no option matches "' + wanted + '"', options: opts.slice(0, 15).map(x => (x.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40)) };
  }
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
  setter.call(el, opt.value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return {
    ok: true,
    selected: { text: (opt.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60), value: opt.value.slice(0, 60), index: opt.index },
    valueNow: el.value.slice(0, 60)
  };
})()`
}

export function buildQueryScript(selector: string, limit: number): string {
  const sel = JSON.stringify(selector)
  return `(() => {
  const sel = ${sel};
  let els = [];
  try { els = Array.from(document.querySelectorAll(sel)); } catch (e) { return { error: 'invalid selector: ' + sel }; }
  const total = els.length;
  const out = els.slice(0, ${limit}).map(el => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    let cls = [];
    if (typeof el.className === 'string') cls = el.className.split(/\\s+/).filter(Boolean).slice(0, 3);
    const isField = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || undefined,
      classes: cls.length ? cls : undefined,
      role: el.getAttribute('role') || undefined,
      text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120) || undefined,
      href: el.getAttribute && el.getAttribute('href') || undefined,
      src: el.getAttribute && el.getAttribute('src') || undefined,
      value: isField ? String(el.value).slice(0, 80) : undefined,
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      visible: r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'
    };
  });
  return { total: total, returned: out.length, elements: out };
})()`
}

export function buildCleanBodyHtmlScript(): string {
  return `(() => {
  const clone = document.body.cloneNode(true);
  clone.querySelectorAll('script,style,noscript,template,link,meta,svg').forEach(n => {
    if (n.tagName && n.tagName.toLowerCase() === 'svg') { n.replaceWith('[svg]'); } else { n.remove(); }
  });
  clone.querySelectorAll('*').forEach(n => {
    n.removeAttribute('style');
    Array.from(n.attributes || []).forEach(a => {
      if (a.name.startsWith('on')) n.removeAttribute(a.name);
    });
  });
  return clone.innerHTML.replace(/<!--[\\s\\S]*?-->/g, '').replace(/\\n{3,}/g, '\\n\\n');
})()`
}

export function buildOuterHtmlScript(selector: string): string {
  const sel = JSON.stringify(selector)
  return `(() => {
  const sel = ${sel};
  let el = null;
  if (/^e\\d+$/.test(sel)) {
    el = (window.__cobrowse && window.__cobrowse.refMap && window.__cobrowse.refMap.get(sel)) || null;
  } else {
    try { el = document.querySelector(sel); } catch (e) { return { error: 'invalid selector: ' + sel }; }
  }
  if (!el) return { error: 'element not found: ' + sel };
  return { html: el.outerHTML, tag: el.tagName.toLowerCase() };
})()`
}

export interface AnnotatePoint {
  x: number
  y: number
  tag: string
}

/**
 * Sample the DOM inside a viewport rect (grid hit-testing) and return
 * structured, text-based annotation data — usable by non-vision models.
 * The annotation overlay host is temporarily made click-transparent so it
 * never shadows real page elements during sampling.
 */
export function buildAnnotateScript(
  rect: { x: number; y: number; w: number; h: number },
  points?: AnnotatePoint[]
): string {
  const rectJson = JSON.stringify(rect)
  const pointsJson = JSON.stringify(points ?? [])
  return `(() => {
  const rect = ${rectJson};
  const extraPoints = ${pointsJson};
  const HOST_ID = '__cobrowse_overlay_host';

  const clean = (s, max) => (s == null ? '' : String(s)).replace(/\\s+/g, ' ').trim().slice(0, max || 80);

  const buildSelector = (el) => {
    if (!el || el === document.body) return 'body';
    if (el.id) return '#' + CSS.escape(el.id);
    const parts = [];
    let cur = el;
    while (cur && cur !== document.body && parts.length < 5) {
      let part = cur.tagName.toLowerCase();
      let cls = '';
      if (typeof cur.className === 'string') cls = cur.className;
      const clsParts = cls.split(/\\s+/).filter(Boolean).slice(0, 2);
      if (clsParts.length) part += '.' + clsParts.map((c) => CSS.escape(c)).join('.');
      const parent = cur.parentElement;
      if (parent) {
        const sameTag = Array.from(parent.children).filter((c) => c.tagName === cur.tagName);
        if (sameTag.length > 1) part += ':nth-of-type(' + (sameTag.indexOf(cur) + 1) + ')';
      }
      parts.unshift(part);
      if (cur !== el && cur.id) { parts[0] = '#' + CSS.escape(cur.id); break; }
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  };

  // Climb out of shadow trees through their host (Node.contains cannot see
  // across a shadow boundary on its own).
  const parentOf = (node) => {
    if (node.parentElement) return node.parentElement;
    const root = node.getRootNode ? node.getRootNode() : null;
    return root && root.host ? root.host : null;
  };

  const containsComposed = (ancestor, node) => {
    let cur = node;
    while (cur) {
      if (cur === ancestor) return true;
      cur = parentOf(cur);
    }
    return false;
  };

  const lca = (els) => {
    if (!els.length) return null;
    let cur = els[0];
    for (const el of els.slice(1)) {
      while (cur && !containsComposed(cur, el)) cur = parentOf(cur);
      if (!cur) return null;
    }
    return cur;
  };

  const describe = (el, hits) => {
    const isField = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
    const role = el.getAttribute('role');
    const interactive = ['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY', 'DETAILS', 'LABEL', 'OPTION'].indexOf(el.tagName) >= 0 || !!role;
    let cls = [];
    if (typeof el.className === 'string') cls = el.className.split(/\\s+/).filter(Boolean).slice(0, 3);
    const value = isField && (el.type || '').toLowerCase() !== 'password' ? clean(el.value, 60) : '';
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || undefined,
      classes: cls.length ? cls : undefined,
      role: role || undefined,
      text: clean(el.textContent, 90) || undefined,
      href: el.getAttribute('href') || undefined,
      placeholder: isField ? el.getAttribute('placeholder') || undefined : undefined,
      value: value || undefined,
      interactive: interactive,
      hits: hits,
      selector: buildSelector(el)
    };
  };

  // document.elementsFromPoint only exposes shadow hosts; descend through open
  // shadow roots (<= 8 levels) to take the innermost real element at the point.
  const deepestAt = (x, y, seed) => {
    let el = seed || null;
    if (!el) {
      try {
        const list = document.elementsFromPoint(x, y);
        for (const cand of list) {
          if (!cand || cand.id === HOST_ID || cand === document.documentElement) continue;
          el = cand;
          break;
        }
      } catch (e) { el = null; }
    }
    let depth = 0;
    while (el && el.shadowRoot && depth < 8) {
      let inner = null;
      try { inner = el.shadowRoot.elementFromPoint(x, y); } catch (e) { inner = null; }
      if (!inner || inner === el || inner.id === HOST_ID) break;
      el = inner;
      depth++;
    }
    return el;
  };

  const host = document.getElementById(HOST_ID);
  const prevPE = host ? host.style.pointerEvents : null;
  if (host) host.style.pointerEvents = 'none';
  try {
    // Denser grid for large boxes: area > 50000px² allows up to 20 cells per axis.
    const dense = rect.w * rect.h > 50000;
    const maxCells = dense ? 20 : 12;
    const cols = Math.max(3, Math.min(maxCells, Math.round(rect.w / 50)));
    const rows = Math.max(3, Math.min(maxCells, Math.round(rect.h / 50)));
    const hits = new Map();
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = rect.x + (rect.w * (c + 0.5)) / cols;
        const y = rect.y + (rect.h * (r + 0.5)) / rows;
        if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) continue;
        const els = document.elementsFromPoint(x, y);
        for (const raw of els) {
          if (!raw || raw.id === HOST_ID || raw === document.documentElement) continue;
          const el = deepestAt(x, y, raw);
          if (!el || el.id === HOST_ID) continue;
          hits.set(el, (hits.get(el) || 0) + 1);
        }
      }
    }

    const alive = (el) => {
      try {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      } catch (e) { return false; }
    };

    const aliveList = Array.from(hits.entries()).filter(function (pair) { return alive(pair[0]); });
    aliveList.sort(function (a, b) { return b[1] - a[1]; });
    const elementCount = aliveList.length;
    const truncated = elementCount > 80;
    const list = aliveList.slice(0, 80);

    const elements = list.slice(0, 40).map(function (pair) { return describe(pair[0], pair[1]); });
    const primary = elements.slice().sort(function (a, b) {
      return ((b.interactive ? 2 : 0) + b.hits) - ((a.interactive ? 2 : 0) + a.hits);
    }).slice(0, 12);

    const anchorEls = list.map(function (pair) { return pair[0]; }).filter(function (el) { return el !== document.body; });
    const anchorNode = lca(anchorEls);

    const textEls = list.map(function (pair) { return pair[0]; }).sort(function (a, b) {
      return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1;
    });
    const seen = new Set();
    const textParts = [];
    let total = 0;
    for (const el of textEls) {
      let t = '';
      for (const n of el.childNodes) if (n.nodeType === 3) t += n.textContent;
      t = clean(t, 200);
      if (t.length >= 2 && !seen.has(t)) {
        seen.add(t);
        textParts.push(t);
        total += t.length + 1;
        if (total > 2000) break;
      }
    }

    const pointInfos = extraPoints.map(function (p) {
      let el = null;
      try { el = deepestAt(p.x, p.y); } catch (e) { el = null; }
      return { tag: p.tag, el: el ? describe(el, 1) : null };
    });

    return {
      url: location.href,
      title: document.title,
      scroll: { x: Math.round(scrollX), y: Math.round(scrollY) },
      viewport: { w: innerWidth, h: innerHeight },
      elements: elements,
      primary: primary,
      anchor: anchorNode
        ? { selector: buildSelector(anchorNode), tag: anchorNode.tagName.toLowerCase(), text: clean(anchorNode.textContent, 120) || undefined }
        : null,
      text: textParts.join(' ').slice(0, 2000),
      points: pointInfos,
      elementCount: elementCount,
      truncated: truncated || undefined
    };
  } finally {
    if (host) host.style.pointerEvents = prevPE == null ? 'none' : prevPE;
  }
})()`
}
