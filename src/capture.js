// Playwright: load the page, mark sections, collect tokens, screenshots, and assets.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { launch } from './browser.js';
import { write } from './guard.js';
import { collectElements, collectLayout } from './elements.js';

const VIEWPORT = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };
const MAX_ASSETS = 80;
const MAX_ASSET_BYTES = 8 * 1024 * 1024;

export async function capture(ctx, dir) {
  const browser = await launch();
  try {
    const context = await browser.newContext({ viewport: VIEWPORT, ignoreHTTPSErrors: true, bypassCSP: true }); // our measuring styles must apply on strict-CSP sites
    const page = await context.newPage();
    await page.goto(ctx.url, { waitUntil: 'load', timeout: 60000 });
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {}); // chatty trackers never idle
    await autoScroll(page);
    await page.waitForTimeout(800);

    await page.evaluate(plainColors);
    const dom = await page.evaluate(analyze);
    dom.layout = await page.evaluate(collectLayout, 'data-c2t-section');
    dom.elements = await page.evaluate(collectElements, 'data-c2t-section');
    await page.screenshot({ path: path.join(dir, 'full.png'), fullPage: true });

    fs.mkdirSync(path.join(dir, 'sections'), { recursive: true });
    for (const s of dom.sections) {
      const clip = { x: 0, y: s.top, width: VIEWPORT.width, height: Math.max(1, Math.min(s.height, 16000)) };
      await page.screenshot({ path: path.join(dir, 'sections', `${s.id}.png`), clip, fullPage: true }).catch(() => {});
    }

    const icons = await exportVectors(page, dom, path.join(dir, 'assets'));
    // Phone view of the original, for the report's mobile comparison.
    const phone = await browser.newContext({ viewport: MOBILE, isMobile: true, hasTouch: true, ignoreHTTPSErrors: true });
    try {
      const m = await phone.newPage();
      await m.goto(ctx.url, { waitUntil: 'load', timeout: 60000 });
      await m.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
      await autoScroll(m);
      await m.screenshot({ path: path.join(dir, 'mobile.png'), fullPage: true });
    } catch { /* mobile view is optional */ } finally { await phone.close(); }
    write(path.join(dir, 'raw.html'), await page.content());
    const assets = { ...(await downloadAssets(context, dom.assetUrls, path.join(dir, 'assets'))), ...icons };
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

// Runs inside the page first. Modern color syntax (oklch, lab, color(), color-mix) comes back from
// getComputedStyle as written; everything downstream reads rgb(). Wrap getComputedStyle so color
// properties are converted by the browser itself (paint one pixel, read it back).
function plainColors() {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 1;
  const cx = cv.getContext('2d', { willReadFrequently: true });
  const cache = new Map();
  const rgb = (c) => {
    if (typeof c !== 'string' || !/(oklch|oklab|lch\(|lab\(|color\(|hwb\(|color-mix)/.test(c)) return c;
    if (cache.has(c)) return cache.get(c);
    cx.clearRect(0, 0, 1, 1);
    cx.fillStyle = '#000';
    cx.fillStyle = c;
    cx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = cx.getImageData(0, 0, 1, 1).data;
    const out = a === 255 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${Math.round((a / 255) * 100) / 100})`;
    cache.set(c, out);
    return out;
  };
  const orig = window.getComputedStyle.bind(window);
  window.getComputedStyle = (el, pseudo) => new Proxy(orig(el, pseudo), {
    get(t, p) {
      const v = Reflect.get(t, p);
      if (typeof v === 'function') return v.bind(t);
      return typeof p === 'string' && /color$/i.test(p) ? rgb(v) : v;
    },
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
  // A page built inside one wrapper would otherwise be one 8000px section: split tall candidates that
  // are a stack of full-width bands into those bands (columns side by side are never split).
  const W = (el) => el.getBoundingClientRect().width;
  // Bands may overlap a little (negative margins pulling a band up over the previous one).
  const stacked = (kids) => kids.every((k, i) => !i || kids[i - 1].getBoundingClientRect().bottom - Math.max(2, Math.min(80, H(k) * 0.1)) <= k.getBoundingClientRect().top);
  // Theme wrappers nest deep (GeneratePress: page > content > primary > main > article > inside > entry-content).
  const split = (c, depth = 0) => {
    if (depth > 12 || H(c) < innerHeight * 1.5) return [c];
    const kids = [...c.children].filter((k) => !SKIP.has(k.tagName) && visible(k) && H(k) >= 40);
    // Only page bands count: children as wide as the viewport. Rows inside a content column (a timeline,
    // a card list) stay together in their section.
    const band = (k) => W(k) >= innerWidth * 0.85; // inset page wrappers (basecamp ~96%) count; content rows (dentalcorp timeline 80%) do not
    // Descend through a single wrapper only if that yields several bands; otherwise keep the outer
    // element so the section's origin (and every position measured from it) stays put.
    if (kids.length === 1 && band(kids[0]) && H(kids[0]) > H(c) * 0.6) { const inner = split(kids[0], depth + 1); return inner.length > 1 ? inner : [c]; }
    if (kids.length < 2 || !stacked(kids) || !kids.every(band)) return [c];
    return kids.flatMap((k) => split(k, depth + 1));
  };
  candidates = candidates.flatMap((c) => split(c));
  // The background a section sits on, even when it's drawn by a wrapper above it.
  const backdrop = (el) => {
    for (let n = el; n; n = n.parentElement) {
      const c = getComputedStyle(n).backgroundColor;
      const a = (c.match(/[\d.]+/g) || []).map(Number)[3] ?? 1;
      if (!/^rgba?\(0, 0, 0, 0\)$/.test(c) && c !== 'transparent' && a >= 0.5) return c;
    }
    return getComputedStyle(document.body).backgroundColor;
  };

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

  // Horizontal content box: the blocks holding visible text, plus images narrower than the viewport.
  // Containers here are often padding-based, so max-width tokens alone miss the real gutters.
  const contentBox = (el) => {
    let left = Infinity, right = -Infinity;
    const add = (n) => {
      const r = n.getBoundingClientRect();
      if (r.width < 2 || r.width > innerWidth * 0.95) return;
      left = Math.min(left, r.left); right = Math.max(right, r.right);
    };
    el.querySelectorAll('*').forEach((n) => {
      if (SKIP.has(n.tagName) || n.closest('svg') || !visible(n)) return;
      if (n.tagName === 'IMG') return add(n);
      if (![...n.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim())) return;
      let blk = n;
      while (blk.parentElement && blk !== el && getComputedStyle(blk).display.startsWith('inline')) blk = blk.parentElement;
      add(blk);
    });
    return left < right ? { left: Math.round(left), right: Math.round(right) } : null;
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
      bgColor: backdrop(el),
      box: contentBox(el),
      ...inkColors(el),
    };
  });

  // Sliders (carousels): the root gets data-c2t-slider (how many slides show at once), each slide
  // data-c2t-slide. Loop clones are hidden so every slide appears once. Known libraries first, then any
  // clipped box whose track lays 3+ similar children side by side past its edge.
  function markSliders(root) {
    const LIB = '.swiper,.swiper-container,.slick-slider,.splide,.glide,.flickity-enabled,.owl-carousel,.keen-slider,.embla,[aria-roledescription="carousel"]';
    const SLIDE = '.swiper-slide,.slick-slide,.splide__slide,.glide__slide,.flickity-cell,.owl-item,.keen-slider__slide,.embla__slide,[aria-roledescription="slide"]';
    const CLONE = '.swiper-slide-duplicate,.slick-cloned,.splide__slide--clone,.glide__slide--clone,.owl-item.cloned';
    const mark = (box, slides) => {
      slides = slides.filter((sl) => !sl.matches(CLONE));
      if (slides.length < 2 || box.closest('[data-c2t-slider]')) return;
      const b = box.getBoundingClientRect();
      const shown = slides.filter((sl) => { const r = sl.getBoundingClientRect(); return r.width > 1 && r.left >= b.left - 2 && r.right <= b.right + 2; }).length;
      box.setAttribute('data-c2t-slider', String(Math.max(1, shown)));
      slides.forEach((sl) => sl.setAttribute('data-c2t-slide', ''));
      box.querySelectorAll(CLONE).forEach((c) => c.setAttribute('data-c2t-hidden', '1'));
    };
    root.querySelectorAll(LIB).forEach((box) => mark(box, [...box.querySelectorAll(SLIDE)].filter((sl) => sl.parentElement.closest(LIB) === box)));
    root.querySelectorAll('*').forEach((box) => {
      if (box.closest('[data-c2t-slider]') || !/hidden|auto|scroll|clip/.test(getComputedStyle(box).overflowX)) return;
      const b = box.getBoundingClientRect();
      if (b.width < 200 || box.scrollWidth <= box.clientWidth + 20) return;
      const track = [box, ...box.children].find((t) => t.children.length >= 3);
      if (!track) return;
      const kids = [...track.children].filter((k) => k.getBoundingClientRect().width > 40);
      const rs = kids.map((k) => k.getBoundingClientRect());
      const sameRow = rs.every((r) => Math.abs(r.top - rs[0].top) <= 4);
      const sameSize = rs.every((r) => Math.abs(r.width - rs[0].width) <= rs[0].width * 0.15);
      if (kids.length >= 3 && sameRow && sameSize && rs.some((r) => r.left >= b.right - 2)) mark(box, kids);
    });
  }

  // Freeze what the browser resolved so offline cleaning sees real URLs and visibility.
  const assetUrls = new Set();
  for (const s of sections) {
    const el = document.querySelector(`[data-c2t-section="${s.id}"]`);
    if (s.bg) assetUrls.add(s.bg);
    markSliders(el);
    el.querySelectorAll('*').forEach((n) => {
      if (n.tagName === 'svg' || n.closest('svg')) return;
      // Closed <details> bodies report a normal computed style, so check for them explicitly.
      const closed = n.parentElement?.closest('details:not([open])') && !n.closest('summary');
      if ((closed || !visible(n)) && !['BR', 'SOURCE'].includes(n.tagName)) n.setAttribute('data-c2t-hidden', '1');
      if (n.tagName === 'A' && n.href) n.setAttribute('href', n.href);
      // Boxes painted with a photo (cards, bands inside a section): keep the photo as the box's background.
      const bi = getComputedStyle(n).backgroundImage.match(/url\(["']?(.*?)["']?\)/)?.[1];
      const br = n.getBoundingClientRect();
      if (bi && !bi.startsWith('data:') && !/\.svg(\?|$)/i.test(bi) && br.width >= 120 && br.height >= 120 && visible(n)) {
        const abs = new URL(bi, location.href).href;
        n.setAttribute('data-c2t-bgimg', abs);
        assetUrls.add(abs);
      }
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

// Icons and drawings made of SVG (inline <svg> or .svg images) become transparent PNGs, so they turn
// into ordinary image blocks the user can replace (WordPress doesn't take SVG uploads by default).
// Each one is shot alone: everything else is hidden for the screenshot, so no background comes along.
const MAX_VECTORS = 200;
async function exportVectors(page, dom, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const found = await page.evaluate((max) => {
    const out = [];
    document.querySelectorAll('[data-c2t-section]').forEach((sec) => {
      const base = sec.getBoundingClientRect();
      const id = sec.getAttribute('data-c2t-section');
      sec.querySelectorAll('svg, img').forEach((el) => {
        if (out.length >= max || el.closest('[data-c2t-hidden]')) return;
        if (el.tagName === 'IMG' ? !/\.svg(\?|$)/i.test(el.currentSrc || el.src) : el.parentElement?.closest('svg')) return;
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        if (r.width < 8 || r.height < 8 || r.width > 1440 || r.height > 1200 || cs.display === 'none' || cs.visibility === 'hidden') return;
        const key = `${id}-v${out.length}`;
        el.setAttribute('data-c2t-vector', key);
        out.push({ key, section: id, was: el.getAttribute('data-c2t-id'), box: { x: Math.round(r.left - base.left), y: Math.round(r.top - base.top), w: Math.round(r.width), h: Math.round(r.height) },
          alt: el.getAttribute('aria-label') || el.querySelector?.('title')?.textContent || el.getAttribute('alt') || '' });
      });
    });
    return out;
  }, MAX_VECTORS);
  if (!found.length) return {};
  const solo = await page.addStyleTag({ content: '*{visibility:hidden!important}html,body{background:transparent!important}[data-c2t-solo],[data-c2t-solo] *{visibility:visible!important}' });
  const files = {};
  for (const v of found) {
    const sel = `[data-c2t-vector="${v.key}"]`;
    await page.evaluate((q) => document.querySelector(q)?.setAttribute('data-c2t-solo', ''), sel);
    const file = `vector-${v.key}.png`;
    const ok = await page.locator(sel).screenshot({ path: path.join(dir, file), omitBackground: true, timeout: 5000 }).then(() => true).catch(() => false);
    await page.evaluate((q) => document.querySelector(q)?.removeAttribute('data-c2t-solo'), sel);
    if (ok) files[v.key] = file;
  }
  await solo.evaluate((n) => n.remove());
  // Swap each exported vector for an <img> the rest of the pipeline already understands.
  const map = {};
  for (const v of found) {
    if (!files[v.key]) continue;
    const url = `https://c2t.invalid/vector/${files[v.key]}`;
    map[url] = files[v.key];
    (dom.layout[v.section] ||= {})[v.key] = v.box;
    // An .svg <img> the scorer already knows now arrives as this PNG.
    for (const e of dom.elements?.[v.section] || []) if (e.kind === 'img' && v.was && e.id === v.was) { e.src = url; e.id = v.key; }
  }
  await page.evaluate((list) => list.forEach(({ key, url, alt, w, h }) => {
    const el = document.querySelector(`[data-c2t-vector="${key}"]`);
    if (!el) return;
    const img = document.createElement('img');
    img.setAttribute('data-c2t-src', url);
    img.setAttribute('src', url);
    img.setAttribute('width', String(w));
    img.setAttribute('height', String(h));
    img.setAttribute('alt', alt);
    img.setAttribute('data-c2t-id', key);
    el.replaceWith(img);
  }), found.filter((v) => files[v.key]).map((v) => ({ key: v.key, url: `https://c2t.invalid/vector/${files[v.key]}`, alt: v.alt, w: v.box.w, h: v.box.h })));
  return map;
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
