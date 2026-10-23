// Playwright: load the page, mark sections, collect tokens, screenshots, and assets.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { launch } from './browser.js';
import { write } from './guard.js';

const VIEWPORT = { width: 1440, height: 900 };
const MAX_ASSETS = 80;
const MAX_ASSET_BYTES = 8 * 1024 * 1024;

export async function capture(ctx, dir) {
  const browser = await launch();
  try {
    const context = await browser.newContext({ viewport: VIEWPORT, ignoreHTTPSErrors: true });
    const page = await context.newPage();
    await page.goto(ctx.url, { waitUntil: 'load', timeout: 60000 });
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {}); // chatty trackers never idle
    await autoScroll(page);
    await page.waitForTimeout(800);

    const dom = await page.evaluate(analyze);
    await page.screenshot({ path: path.join(dir, 'full.png'), fullPage: true });

    fs.mkdirSync(path.join(dir, 'sections'), { recursive: true });
    for (const s of dom.sections) {
      const clip = { x: 0, y: s.top, width: VIEWPORT.width, height: Math.max(1, Math.min(s.height, 4000)) };
      await page.screenshot({ path: path.join(dir, 'sections', `${s.id}.png`), clip, fullPage: true }).catch(() => {});
    }

    write(path.join(dir, 'raw.html'), await page.content());
    const assets = await downloadAssets(context, dom.assetUrls, path.join(dir, 'assets'));
    const faces = await fontFaces(context, dom, path.join(dir, 'assets', 'fonts'));
    write(path.join(dir, 'dom.json'), { ...dom, assets, fontFaces: faces });

    return {
      url: ctx.url,
      finalUrl: page.url(),
      title: dom.title,
      sections: dom.sections.length,
      assets: Object.keys(assets).length,
      fonts: faces.length,
      height: dom.pageHeight,
    };
  } finally {
    await browser.close();
  }
}

async function autoScroll(page) {
  await page.evaluate(async () => {
    const step = window.innerHeight * 0.8;
    for (let y = 0; y < document.body.scrollHeight && y < 30000; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 120));
    }
    window.scrollTo(0, 0);
  });
}

// Runs inside the page. Marks sections and hidden nodes, then returns layout + tokens.
function analyze() {
  const H = (el) => el.getBoundingClientRect().height;
  const visible = (el) => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.05 && r.width > 1 && r.height > 1;
  };
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'LINK', 'META', 'TEMPLATE']);

  // Walk down single-child wrappers until we reach a level with several real blocks.
  let root = document.body;
  for (let i = 0; i < 8; i++) {
    const kids = [...root.children].filter((c) => !SKIP.has(c.tagName) && visible(c) && H(c) > 30);
    if (kids.length === 1 && H(kids[0]) > H(root) * 0.6) root = kids[0];
    else break;
  }
  // Header/footer often sit outside the main wrapper; split <main> into its children too.
  let candidates = [...root.children].filter((c) => !SKIP.has(c.tagName) && visible(c) && H(c) >= 40);
  candidates = candidates.flatMap((c) => {
    if (c.tagName === 'MAIN' || c.getAttribute('role') === 'main') {
      const inner = [...c.children].filter((k) => !SKIP.has(k.tagName) && visible(k) && H(k) >= 40);
      return inner.length > 1 ? inner : [c];
    }
    return [c];
  });

  // Most-used text and link colors inside a section, weighted by visible characters.
  const inkColors = (el) => {
    const text = new Map(), link = new Map();
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      const n = t.textContent.trim().length;
      const p = t.parentElement;
      if (!n || !p || !visible(p)) continue;
      const m = p.closest('a') ? link : text;
      m.set(getComputedStyle(p).color, (m.get(getComputedStyle(p).color) || 0) + n);
    }
    const best = (m) => [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    return { textColor: best(text), linkColor: best(link) };
  };

  const sections = candidates.map((el, i) => {
    const id = String(i + 1).padStart(2, '0');
    el.setAttribute('data-c2t-section', id);
    const r = el.getBoundingClientRect();
    const tag = el.tagName.toLowerCase();
    const isHeader = tag === 'header' || el.getAttribute('role') === 'banner' || (i === 0 && !!el.querySelector('nav'));
    const isFooter = tag === 'footer' || el.getAttribute('role') === 'contentinfo';
    const bg = getComputedStyle(el).backgroundImage.match(/url\(["']?(.*?)["']?\)/)?.[1] || null;
    return {
      id,
      tag,
      role: isHeader ? 'header' : isFooter ? 'footer' : 'body',
      top: Math.round(r.top + scrollY),
      height: Math.round(r.height),
      heading: (el.querySelector('h1,h2,h3')?.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80),
      bg: bg && !bg.startsWith('data:') ? new URL(bg, location.href).href : null,
      bgColor: getComputedStyle(el).backgroundColor,
      ...inkColors(el),
    };
  });

  // Freeze what the browser resolved so offline cleaning sees real URLs and visibility.
  const assetUrls = new Set();
  for (const s of sections) {
    const el = document.querySelector(`[data-c2t-section="${s.id}"]`);
    if (s.bg) assetUrls.add(s.bg);
    el.querySelectorAll('*').forEach((n) => {
      if (n.tagName === 'svg' || n.closest('svg')) return;
      // Closed <details> bodies report a normal computed style, so check for them explicitly.
      const closed = n.parentElement?.closest('details:not([open])') && !n.closest('summary');
      if ((closed || !visible(n)) && !['BR', 'SOURCE'].includes(n.tagName)) n.setAttribute('data-c2t-hidden', '1');
      if (n.tagName === 'A' && n.href) n.setAttribute('href', n.href);
      if (n.tagName === 'IMG') {
        const src = n.currentSrc || n.src || n.dataset.src || n.dataset.lazySrc || '';
        if (src && !src.startsWith('data:')) {
          const abs = new URL(src, location.href).href;
          n.setAttribute('data-c2t-src', abs);
          n.setAttribute('width', String(Math.round(n.getBoundingClientRect().width)));
          assetUrls.add(abs);
        }
      }
    });
    if (s.bg) el.setAttribute('data-c2t-bg', s.bg);
  }

  // Tokens: weight colors and fonts by how much visible text uses them.
  const tally = (m, k, w) => k && m.set(k, (m.get(k) || 0) + w);
  const text = new Map(), bgs = new Map(), fonts = new Map(), heads = new Map(), sizes = new Map(), buttons = new Map(), widths = new Map();
  const all = [...document.querySelectorAll('body *')].slice(0, 6000);
  for (const el of all) {
    if (SKIP.has(el.tagName) || el.closest('svg') || !visible(el)) continue;
    const cs = getComputedStyle(el);
    const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join('');
    const area = el.getBoundingClientRect().width * el.getBoundingClientRect().height;
    if (own) {
      tally(text, cs.color, own.length);
      tally(fonts, cs.fontFamily, own.length);
      tally(sizes, cs.fontSize, own.length);
      if (/^H[1-3]$/.test(el.tagName)) tally(heads, cs.fontFamily, own.length);
    }
    if (cs.backgroundColor && !/rgba\(0, 0, 0, 0\)|transparent/.test(cs.backgroundColor)) tally(bgs, cs.backgroundColor, area);
    if ((el.tagName === 'BUTTON' || el.tagName === 'A') && own && !/rgba\(0, 0, 0, 0\)/.test(cs.backgroundColor)) tally(buttons, cs.backgroundColor, 1);
    if (cs.maxWidth.endsWith('px')) tally(widths, cs.maxWidth, 1);
  }
  // Per heading level: the style of the instance carrying the most text (a level can be restyled per section).
  const headings = {};
  for (const tag of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']) {
    const best = [...document.querySelectorAll(tag)].filter((h) => !h.closest('svg') && visible(h))
      .sort((a, b) => b.textContent.trim().length - a.textContent.trim().length)[0];
    if (!best) continue;
    const cs = getComputedStyle(best);
    headings[tag] = {
      fontSize: cs.fontSize, fontFamily: cs.fontFamily, fontWeight: cs.fontWeight, fontStyle: cs.fontStyle,
      lineHeight: cs.lineHeight, letterSpacing: cs.letterSpacing, textTransform: cs.textTransform,
    };
  }

  // @font-face rules the browser can read; cross-origin sheets throw and are fetched in Node instead.
  const faceRules = [], blockedSheets = [];
  const walk = (rules, base) => {
    for (const r of rules) {
      if (r instanceof CSSFontFaceRule) faceRules.push({ css: r.cssText, base });
      else if (r.cssRules) walk(r.cssRules, base);
      if (r instanceof CSSImportRule && r.styleSheet) {
        try { walk(r.styleSheet.cssRules, r.styleSheet.href || base); } catch { blockedSheets.push(r.styleSheet.href); }
      }
    }
  };
  for (const sheet of document.styleSheets) {
    try { walk(sheet.cssRules, sheet.href || location.href); } catch { if (sheet.href) blockedSheets.push(sheet.href); }
  }

  const top = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, w]) => ({ value: k, weight: Math.round(w) }));

  return {
    title: document.title,
    lang: document.documentElement.lang || 'en',
    pageHeight: document.documentElement.scrollHeight,
    bodyBg: getComputedStyle(document.body).backgroundColor,
    sections,
    headings,
    faceRules,
    blockedSheets,
    assetUrls: [...assetUrls],
    tokens: {
      text: top(text, 6),
      backgrounds: top(bgs, 8),
      buttons: top(buttons, 4),
      fonts: top(fonts, 3),
      headingFonts: top(heads, 2),
      fontSizes: top(sizes, 8),
      maxWidths: top(widths, 4),
    },
  };
}

async function downloadAssets(context, urls, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const map = {};
  for (const url of urls.slice(0, MAX_ASSETS)) {
    try {
      const res = await context.request.get(url, { timeout: 20000 });
      if (!res.ok()) continue;
      const type = res.headers()['content-type'] || '';
      if (!type.startsWith('image/') || type.includes('svg')) continue; // SVGs stay hotlinked (WP blocks SVG uploads)
      const body = await res.body();
      if (body.length > MAX_ASSET_BYTES || body.length < 200) continue;
      const ext = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'image/avif': '.avif' }[type.split(';')[0]] || '.jpg';
      const file = crypto.createHash('sha1').update(url).digest('hex').slice(0, 12) + ext;
      fs.writeFileSync(path.join(dir, file), body);
      map[url] = file;
    } catch { /* skip unreachable assets */ }
  }
  return map;
}

// Download woff2/woff files for the families the page actually uses, so the theme can self-host them.
const MAX_FONTS = 16;
async function fontFaces(context, dom, dir) {
  const used = new Set([...dom.tokens.fonts, ...dom.tokens.headingFonts, ...Object.values(dom.headings).map((h) => ({ value: h.fontFamily }))]
    .map((f) => f.value.split(',')[0].replace(/["']/g, '').trim().toLowerCase()));
  const rules = [...dom.faceRules];
  for (const href of dom.blockedSheets) {
    const css = await context.request.get(href, { timeout: 20000 }).then((r) => (r.ok() ? r.text() : '')).catch(() => '');
    for (const m of css.matchAll(/@font-face\s*\{[^}]*\}/g)) rules.push({ css: m[0], base: href });
  }
  const prop = (css, name) => css.match(new RegExp(`${name}\\s*:\\s*([^;}]+)`))?.[1].trim();
  const faces = [];
  fs.mkdirSync(dir, { recursive: true });
  for (const { css, base } of rules) {
    const family = (prop(css, 'font-family') || '').replace(/["']/g, '').trim();
    if (!used.has(family.toLowerCase()) || faces.length >= MAX_FONTS) continue;
    const srcs = [...(prop(css, 'src') || '').matchAll(/url\(["']?([^"')]+)["']?\)/g)].map((m) => m[1]);
    const src = srcs.find((u) => /\.woff2(\?|#|$)/.test(u)) || srcs.find((u) => /\.woff(\?|#|$)/.test(u));
    if (!src) continue;
    const url = new URL(src, base).href;
    const ext = /\.woff2(\?|#|$)/.test(src) ? '.woff2' : '.woff';
    const weight = prop(css, 'font-weight') || '400';
    const style = prop(css, 'font-style') || 'normal';
    try {
      const res = await context.request.get(url, { timeout: 20000 });
      if (!res.ok()) continue;
      const body = await res.body();
      if (body.length > 2 * 1024 * 1024) continue;
      const file = crypto.createHash('sha1').update(url).digest('hex').slice(0, 12) + ext;
      fs.writeFileSync(path.join(dir, file), body);
      faces.push({ family, weight, style, file, url });
    } catch { /* skip unreachable fonts */ }
  }
  return faces;
}
