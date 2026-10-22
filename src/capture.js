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
    write(path.join(dir, 'dom.json'), { ...dom, assets });

    return {
      url: ctx.url,
      finalUrl: page.url(),
      title: dom.title,
      sections: dom.sections.length,
      assets: Object.keys(assets).length,
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
    };
  });

  // Freeze what the browser resolved so offline cleaning sees real URLs and visibility.
  const assetUrls = new Set();
  for (const s of sections) {
    const el = document.querySelector(`[data-c2t-section="${s.id}"]`);
    if (s.bg) assetUrls.add(s.bg);
    el.querySelectorAll('*').forEach((n) => {
      if (n.tagName === 'svg' || n.closest('svg')) return;
      if (!visible(n) && !['BR', 'SOURCE'].includes(n.tagName)) n.setAttribute('data-c2t-hidden', '1');
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
  const top = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, w]) => ({ value: k, weight: Math.round(w) }));

  return {
    title: document.title,
    lang: document.documentElement.lang || 'en',
    pageHeight: document.documentElement.scrollHeight,
    bodyBg: getComputedStyle(document.body).backgroundColor,
    sections,
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
