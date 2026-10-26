// Screenshot the local clone per section and score it against the original with pixelmatch.
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { launch } from './browser.js';
import { read, write } from './guard.js';
import { collectElements, compareSection } from './elements.js';
import { devenv } from './devenv.js';

// Grade thresholds and the element/pixel mix: fitted to human labels by bin/calibrate.js when
// calibration/weights.json exists, otherwise the hand-set defaults.
const CAL = (() => { try { return JSON.parse(fs.readFileSync(new URL('../calibration/weights.json', import.meta.url), 'utf8')); } catch { return null; } })();
const DIFF_WIDTH = 320; // both sides are scaled to this width before diffing
const COARSE_WIDTH = 48;
const MAX_DIFF_HEIGHT = 2400;
const DOM_WEIGHT = CAL?.domWeight ?? 0.6; // share of a section score from the element match; the rest is pixels
export const PASS = CAL?.pass ?? 0.85;
export const CLOSE = CAL?.acceptable ?? 0.65; // "close enough": a few minutes of editing
export const SCORER = 4; // bump when scoring changes: score-guard decisions from older scorers are re-made

export async function verify(ctx, dir) {
  const { siteUrl } = read(path.join(ctx.dir, 'push', 'done.json'));
  const conv = read(path.join(ctx.dir, 'convert', 'done.json'));
  const browser = await launch({ local: true });
  let status, height, broken, found, readable, localEls, edit, mobile;
  fs.mkdirSync(path.join(dir, 'sections'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'diff'), { recursive: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
    const res = await page.goto(siteUrl, { waitUntil: 'networkidle', timeout: 60000 });
    status = res?.status() ?? 0;
    // Dev-env toolbars sit on top of the page and would count as differences.
    await page.addStyleTag({ content: '#wpadminbar,#a8c-debug-flag,[id*="debug-bar"],[class*="debug-bar"]{display:none!important}html{margin-top:0!important}' });
    // Lazy images below the fold are 0×0 until loaded; load them all so measurements see the real page.
    await page.evaluate(async () => {
      document.querySelectorAll('img[loading="lazy"]').forEach((i) => { i.loading = 'eager'; });
      await Promise.race([
        Promise.all([...document.images].map((i) => (i.complete ? null : new Promise((r) => { i.onload = i.onerror = r; })))),
        new Promise((r) => setTimeout(r, 8000)),
      ]);
    });
    await page.screenshot({ path: path.join(dir, 'full.png'), fullPage: true });
    height = await page.evaluate(() => document.documentElement.scrollHeight);
    broken = await page.evaluate(() => [...document.images].filter((i) => i.complete && !i.naturalWidth).map((i) => i.src).slice(0, 20));

    // Local top-level blocks, in the same role order the build step used.
    const ids = { header: [], body: [], footer: [] };
    for (const s of conv.sections) ids[s.role].push(s.id);
    found = await page.evaluate((ids) => {
      const kids = (sel) => [...(document.querySelector(sel)?.children || [])];
      const groups = {
        header: kids('header.wp-block-template-part'),
        body: kids('.wp-block-post-content'),
        footer: kids('footer.wp-block-template-part'),
      };
      const hit = [];
      for (const role of Object.keys(ids)) {
        ids[role].forEach((id, i) => {
          const el = groups[role][i];
          if (el) { el.setAttribute('data-c2t-local', id); hit.push(id); }
        });
      }
      return hit;
    }, ids);
    readable = await page.evaluate(readability);
    localEls = await page.evaluate(collectElements, 'data-c2t-local');
    for (const id of found) {
      await page.locator(`[data-c2t-local="${id}"]`).screenshot({ path: path.join(dir, 'sections', `${id}.png`) }).catch(() => {});
    }
    mobile = await phoneCheck(browser, siteUrl, path.join(dir, 'mobile.png')).catch((e) => ({ error: e.message.slice(0, 200) }));
    edit = await editability(browser, siteUrl, read(path.join(ctx.dir, 'push', 'state.json')).pageId, devenv(ctx.site).loginKey()).catch((e) => ({ error: e.message.slice(0, 200) }));
  } finally {
    await browser.close();
  }

  const capDir = path.join(ctx.dir, 'capture');
  const origEls = read(path.join(capDir, 'dom.json')).elements || {};
  const media = read(path.join(ctx.dir, 'push', 'state.json')).media || {};
  const gaps = {};
  const sections = conv.sections.map((s) => {
    const orig = path.join(capDir, 'sections', `${s.id}.png`);
    const local = path.join(dir, 'sections', `${s.id}.png`);
    if (!fs.existsSync(orig) || !fs.existsSync(local)) return { id: s.id, score: null, status: 'missing' };
    const d = diff(orig, local, path.join(dir, 'diff', `${s.id}.png`));
    // Element match: each original text block and image found in the clone, in place, in style.
    const el = origEls[s.id] ? compareSection(origEls[s.id], localEls[s.id], media) : null;
    gaps[s.id] = el;
    // Pixels still catch what elements can't see (backgrounds, borders, icons, image crops).
    const blended = el?.score != null ? DOM_WEIGHT * el.score + (1 - DOM_WEIGHT) * d.score : d.score;
    // Text the visitor can't read counts as missing: scale by the share of readable characters.
    const r = readable[s.id] ?? 1;
    const score = round(blended * r);
    return { id: s.id, ...d, pixelScore: d.score, dom: el?.score ?? null, matched: el ? `${el.matched}/${el.of}` : null, gaps: el?.gaps, worst: el?.worst, score, status: grade(score), readable: r };
  });
  write(path.join(dir, 'gaps.json'), gaps);
  const page = diff(path.join(capDir, 'full.png'), path.join(dir, 'full.png'), path.join(dir, 'diff', 'full.png'));
  const scored = sections.filter((s) => s.score !== null);
  return {
    siteUrl,
    status,
    height,
    brokenImages: broken,
    // Whole page = sections weighted by their original height; one full-page pixel diff swung ~30 points run to run.
    pageScore: (() => { const h = Object.fromEntries(read(path.join(capDir, 'dom.json')).sections.map((x) => [x.id, x.height])); const w = scored.reduce((a, x) => a + (h[x.id] || 0), 0); return w ? round(scored.reduce((a, x) => a + x.score * (h[x.id] || 0), 0) / w) : page.score; })(),
    pagePixels: page.score,
    avgScore: scored.length ? round(scored.reduce((a, s) => a + s.score, 0) / scored.length) : null,
    passing: scored.filter((s) => s.status === 'pass').length,
    editability: edit,
    mobile,
    sections,
  };
}

const round = (n) => Math.round(n * 1000) / 1000;

// Phone view of the clone: horizontal overflow is a hard failure; the screenshot goes in the report.
async function phoneCheck(browser, siteUrl, file) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, ignoreHTTPSErrors: true });
  try {
    const page = await ctx.newPage();
    await page.goto(siteUrl, { waitUntil: 'networkidle', timeout: 60000 });
    await page.addStyleTag({ content: '#wpadminbar{display:none!important}html{margin-top:0!important}' });
    const r = await page.evaluate(() => ({
      width: document.documentElement.scrollWidth,
      viewport: innerWidth,
      wide: [...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > innerWidth + 2 && getComputedStyle(e).position !== 'fixed')
        .slice(0, 5).map((e) => `${e.tagName.toLowerCase()}.${String(e.className).split(' ')[0]} ${Math.round(e.getBoundingClientRect().width)}px`),
      height: document.documentElement.scrollHeight,
    }));
    await page.screenshot({ path: file, fullPage: true });
    return { overflow: r.width > r.viewport + 1, ...r };
  } finally {
    await ctx.close();
  }
}

// How editable the page is in the real block editor: every block valid (no "unexpected content"),
// no raw HTML blocks, images linked to the media library, styles from presets rather than one-off values.
async function editability(browser, siteUrl, pageId, key) {
  const page = await browser.newPage({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } });
  try {
    await page.goto(`${siteUrl}wp-admin/?vip-dev-autologin=${key}`, { waitUntil: 'domcontentloaded' });
    await page.goto(`${siteUrl}wp-admin/post.php?post=${pageId}&action=edit`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.wp?.data?.select('core/block-editor')?.getBlocks().length > 0, null, { timeout: 90000 });
    return await page.evaluate(() => {
      const all = [];
      const walk = (l) => l.forEach((x) => { all.push(x); walk(x.innerBlocks); });
      walk(wp.data.select('core/block-editor').getBlocks());
      let custom = 0, preset = 0;
      const scan = (v) => {
        if (v && typeof v === 'object') return Object.values(v).forEach(scan);
        if (typeof v !== 'string') return;
        if (/^var:preset\|/.test(v)) preset++;
        else if (/^-?\d+(\.\d+)?px$|^#[0-9a-f]{6}$/i.test(v) && !/^0px$/.test(v)) custom++;
      };
      for (const b of all) {
        scan(b.attributes.style?.spacing); scan(b.attributes.style?.typography?.fontSize); scan(b.attributes.style?.color); scan(b.attributes.style?.border?.color);
        for (const k of ['fontSize', 'textColor', 'backgroundColor', 'borderColor']) if (b.attributes[k]) preset++;
      }
      const images = all.filter((x) => x.name === 'core/image');
      return {
        blocks: all.length,
        invalid: all.filter((x) => !x.isValid).length,
        invalidNames: [...new Set(all.filter((x) => !x.isValid).map((x) => x.name))],
        rawHtml: all.filter((x) => ['core/html', 'core/freeform', 'core/missing'].includes(x.name)).length,
        images: images.length,
        linkedImages: images.filter((x) => x.attributes.id).length,
        presetValues: preset,
        customValues: custom,
      };
    });
  } finally {
    await page.close();
  }
}
const grade = (score) => (score >= PASS ? 'pass' : score >= CLOSE ? 'close' : 'fail');

// Runs in the local page: per marked section, share of visible text characters with contrast >= 3:1
// against the nearest solid background. Text over images (cover blocks) is given the benefit of the doubt.
function readability() {
  const rgba = (c) => (c.match(/[\d.]+/g) || []).map(Number);
  const lum = ([r, g, b]) => [r, g, b].map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    .reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i], 0);
  const blend = (fg, bg) => [0, 1, 2].map((i) => fg[i] * (fg[3] ?? 1) + bg[i] * (1 - (fg[3] ?? 1)));
  const backdrop = (el) => {
    for (let n = el; n; n = n.parentElement) {
      if (n.classList?.contains('wp-block-cover')) return null;
      const c = rgba(getComputedStyle(n).backgroundColor);
      if (c.length && (c[3] ?? 1) >= 0.5) return c;
    }
    return [255, 255, 255];
  };
  const out = {};
  document.querySelectorAll('[data-c2t-local]').forEach((sec) => {
    let ok = 0, all = 0;
    const walker = document.createTreeWalker(sec, NodeFilter.SHOW_TEXT);
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      const n = t.textContent.trim().length;
      const el = t.parentElement;
      if (!n || !el || !el.getClientRects().length) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden') continue;
      all += n;
      const bg = backdrop(el);
      if (!bg) { ok += n; continue; }
      const fg = blend(rgba(cs.color), bg);
      const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a);
      if ((hi + 0.05) / (lo + 0.05) >= 3) ok += n;
    }
    out[sec.getAttribute('data-c2t-local')] = all >= 20 ? Math.round((ok / all) * 1000) / 1000 : 1;
  });
  return out;
}

export function diff(origFile, localFile, outFile, w = DIFF_WIDTH) {
  // Sections rarely sit on whole pixels, so element screenshots pick up a sliver of the neighbor at an edge. On dark sections that row alone moved scores ~10 points, so trim it from both sides.
  const a = trim(PNG.sync.read(fs.readFileSync(origFile)));
  const b = trim(PNG.sync.read(fs.readFileSync(localFile)));
  // Fine pass catches text and detail; coarse pass rewards matching layout even when things shift a little.
  // Long sections are scored in bands that each find their own vertical alignment: one row a bit shorter
  // near the top used to misalign everything below it and score a correct layout below a flat one.
  const m = a.height > BAND_MIN ? banded : match;
  const fine = m(a, b, w, outFile);
  const coarse = m(a, b, COARSE_WIDTH);
  const pixels = (fine + coarse) / 2;
  // pixelmatch only sees the original's height, so charge for height drift directly,
  // measured on content (trailing empty space doesn't count).
  const ratio = contentHeight(b) / contentHeight(a) || 0;
  const score = round(pixels * Math.sqrt(Math.min(ratio, 1 / ratio) || 0));
  return {
    score,
    status: grade(score),
    pixels: round(pixels),
    heightRatio: round(ratio),
  };
}

function contentHeight(img) {
  const s = resize(img, 160, Math.max(1, Math.round((img.height * 160) / img.width)));
  const bg = dominant(s);
  for (let y = s.height - 1; y >= 0; y--) {
    for (let x = 0; x < s.width; x++) if (far(s.data, (y * s.width + x) * 4, bg)) return (y + 1) / s.height * img.height;
  }
  return img.height;
}

function dominant(img) {
  const counts = new Map();
  for (let i = 0; i < img.data.length; i += 16) {
    const k = ((img.data[i] >> 4) << 8) | ((img.data[i + 1] >> 4) << 4) | (img.data[i + 2] >> 4);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const mode = [...counts.entries()].sort((x, y) => y[1] - x[1])[0][0];
  return [((mode >> 8) & 15) * 16 + 8, ((mode >> 4) & 15) * 16 + 8, (mode & 15) * 16 + 8];
}

const far = (d, i, bg) => Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]) > 48;

function inkPixels(a, b) {
  const bg = dominant(a);
  let n = 0;
  for (let i = 0; i < a.data.length; i += 4) if (far(a.data, i, bg) || far(b.data, i, bg)) n++;
  return n;
}

// Share of content pixels that match, both sides scaled to the original's shape at width w.
function match(a, b, w, outFile) {
  const h = Math.max(1, Math.min(MAX_DIFF_HEIGHT, Math.round((a.height * w) / a.width)));
  const ra = resize(a, w, h);
  // Same scale as the original, top-aligned; cut or padded with its own bottom color to the original's height.
  const hb = Math.max(1, Math.round((b.height * w) / b.width));
  const rb = fit(resize(b, w, Math.min(hb, MAX_DIFF_HEIGHT * 2)), h);
  // Sub-pixel layout drift above a section shifts it by a pixel or two and used to swing scores ~10 points,
  // so try small vertical offsets and keep the best. Flat backgrounds would inflate a plain pixel ratio,
  // so only count "ink": pixels that differ from the original's dominant color in either image.
  let best = -1, bestOut = null;
  for (const dy of w >= DIFF_WIDTH ? SHIFTS : [0]) { // the coarse pass is already shift tolerant
    const sb = shift(rb, dy);
    const out = new PNG({ width: w, height: h });
    const bad = pixelmatch(ra.data, sb.data, out.data, w, h, { threshold: 0.05, alpha: 0.3 });
    const m = Math.max(0, 1 - bad / Math.max(inkPixels(ra, sb), (w * h) * 0.02));
    if (m > best) { best = m; bestOut = out; }
  }
  if (outFile) fs.writeFileSync(outFile, PNG.sync.write(bestOut));
  return best;
}

const SHIFTS = [0, -1, 1, -2, 2];
const BAND_MIN = 1200; // original px; shorter sections keep the single top-aligned comparison
const BAND = 400; // original px per band
const BAND_SEARCH = 0.2; // how far (share of the original's height) a band may drift from the one above

function banded(a, b, w, outFile) {
  const scale = w / a.width;
  const h = Math.max(1, Math.min(MAX_DIFF_HEIGHT, Math.round(a.height * scale)));
  const ra = resize(a, w, h);
  const hb = Math.max(1, Math.min(MAX_DIFF_HEIGHT * 2, Math.round(b.height * scale)));
  const rb = resize(b, w, hb);
  const bh = Math.max(4, Math.round(BAND * scale));
  const reach = Math.max(2, Math.min(Math.round(h * BAND_SEARCH), bh * 2));
  const steps = [0]; // every row near the last offset, then coarser
  for (let d = 1; d <= reach; d += d < 8 ? 1 : 3) steps.push(d);
  const row = w * 4;
  const out = outFile ? new PNG({ width: w, height: h }) : null;
  let offset = 0, bad = 0, ink = 0;
  for (let y = 0; y < h; y += bh) {
    const n = Math.min(bh, h - y);
    const band = new PNG({ width: w, height: n });
    ra.data.copy(band.data, 0, y * row, (y + n) * row);
    let best = null;
    // Search near the previous band's offset, nearest first so ties keep the smaller drift.
    for (const d of steps) {
      for (const dy of d ? [offset + d, offset - d] : [offset]) {
        const sb = new PNG({ width: w, height: n });
        for (let r = 0; r < n; r++) {
          const from = Math.min(hb - 1, Math.max(0, y + r + dy));
          rb.data.copy(sb.data, r * row, from * row, from * row + row);
        }
        const diffOut = new PNG({ width: w, height: n });
        const miss = pixelmatch(band.data, sb.data, diffOut.data, w, n, { threshold: 0.05, alpha: 0.3 });
        const denom = Math.max(inkPixels(band, sb), w * n * 0.02);
        if (!best || miss / denom < best.miss / best.denom) best = { dy, miss, denom, diffOut };
      }
    }
    offset = best.dy;
    bad += best.miss;
    ink += best.denom;
    if (out) best.diffOut.data.copy(out.data, y * row);
  }
  if (outFile) fs.writeFileSync(outFile, PNG.sync.write(out));
  return Math.max(0, 1 - bad / ink);
}
const EDGE = 2;

function trim(src) {
  if (src.height <= EDGE * 4 || src.width <= EDGE * 4) return src;
  const dst = new PNG({ width: src.width - EDGE * 2, height: src.height - EDGE * 2 });
  for (let y = 0; y < dst.height; y++) {
    const from = ((y + EDGE) * src.width + EDGE) * 4;
    src.data.copy(dst.data, y * dst.width * 4, from, from + dst.width * 4);
  }
  return dst;
}

// Move an image up (dy < 0) or down by whole rows, repeating the edge row.
function shift(src, dy) {
  if (!dy) return src;
  const dst = new PNG({ width: src.width, height: src.height });
  const row = src.width * 4;
  for (let y = 0; y < src.height; y++) {
    const from = Math.min(src.height - 1, Math.max(0, y - dy));
    src.data.copy(dst.data, y * row, from * row, from * row + row);
  }
  return dst;
}

function fit(src, h) {
  if (src.height === h) return src;
  const dst = new PNG({ width: src.width, height: h });
  const last = (src.height - 1) * src.width * 4;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < src.width; x++) {
      const o = (y * src.width + x) * 4;
      const i = y < src.height ? o : last + x * 4;
      dst.data[o] = src.data[i]; dst.data[o + 1] = src.data[i + 1]; dst.data[o + 2] = src.data[i + 2]; dst.data[o + 3] = src.data[i + 3];
    }
  }
  return dst;
}

// Area-average downscale (or nearest upscale) to w x h.
function resize(src, w, h) {
  const dst = new PNG({ width: w, height: h });
  const sx = src.width / w, sy = src.height / h;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let r = 0, g = 0, bl = 0, al = 0, n = 0;
      for (let yy = y0; yy < y1 && yy < src.height; yy += 1 + (sy > 8 ? Math.floor(sy / 8) : 0)) {
        for (let xx = x0; xx < x1 && xx < src.width; xx += 1 + (sx > 8 ? Math.floor(sx / 8) : 0)) {
          const i = (yy * src.width + xx) * 4;
          r += src.data[i]; g += src.data[i + 1]; bl += src.data[i + 2]; al += src.data[i + 3]; n++;
        }
      }
      const o = (y * w + x) * 4;
      dst.data[o] = r / n; dst.data[o + 1] = g / n; dst.data[o + 2] = bl / n; dst.data[o + 3] = al / n;
    }
  }
  return dst;
}
