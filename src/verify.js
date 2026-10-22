// Screenshot the local clone per section and score it against the original with pixelmatch.
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { launch } from './browser.js';
import { read } from './guard.js';

const DIFF_WIDTH = 320; // both sides are scaled to this width before diffing
const COARSE_WIDTH = 48;
const MAX_DIFF_HEIGHT = 2400;
export const PASS = 0.85;
export const CLOSE = 0.65;

export async function verify(ctx, dir) {
  const { siteUrl } = read(path.join(ctx.dir, 'push', 'done.json'));
  const conv = read(path.join(ctx.dir, 'convert', 'done.json'));
  const browser = await launch({ local: true });
  let status, height, broken, found;
  fs.mkdirSync(path.join(dir, 'sections'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'diff'), { recursive: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
    const res = await page.goto(siteUrl, { waitUntil: 'networkidle', timeout: 60000 });
    status = res?.status() ?? 0;
    // Dev-env toolbars sit on top of the page and would count as differences.
    await page.addStyleTag({ content: '#wpadminbar,#a8c-debug-flag,[id*="debug-bar"],[class*="debug-bar"]{display:none!important}html{margin-top:0!important}' });
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
    for (const id of found) {
      await page.locator(`[data-c2t-local="${id}"]`).screenshot({ path: path.join(dir, 'sections', `${id}.png`) }).catch(() => {});
    }
  } finally {
    await browser.close();
  }

  const capDir = path.join(ctx.dir, 'capture');
  const sections = conv.sections.map((s) => {
    const orig = path.join(capDir, 'sections', `${s.id}.png`);
    const local = path.join(dir, 'sections', `${s.id}.png`);
    if (!fs.existsSync(orig) || !fs.existsSync(local)) return { id: s.id, score: null, status: 'missing' };
    return { id: s.id, ...diff(orig, local, path.join(dir, 'diff', `${s.id}.png`)) };
  });
  const page = diff(path.join(capDir, 'full.png'), path.join(dir, 'full.png'), path.join(dir, 'diff', 'full.png'));
  const scored = sections.filter((s) => s.score !== null);
  return {
    siteUrl,
    status,
    height,
    brokenImages: broken,
    pageScore: page.score,
    avgScore: scored.length ? round(scored.reduce((a, s) => a + s.score, 0) / scored.length) : null,
    passing: scored.filter((s) => s.status === 'pass').length,
    sections,
  };
}

const round = (n) => Math.round(n * 1000) / 1000;

export function diff(origFile, localFile, outFile, w = DIFF_WIDTH) {
  const a = PNG.sync.read(fs.readFileSync(origFile));
  const b = PNG.sync.read(fs.readFileSync(localFile));
  // Fine pass catches text and detail; coarse pass rewards matching layout even when things shift a little.
  const fine = match(a, b, w, outFile);
  const coarse = match(a, b, COARSE_WIDTH);
  const pixels = (fine + coarse) / 2;
  // pixelmatch only sees the original's height, so charge for height drift directly,
  // measured on content (trailing empty space doesn't count).
  const ratio = contentHeight(b) / contentHeight(a) || 0;
  const score = round(pixels * Math.sqrt(Math.min(ratio, 1 / ratio) || 0));
  return {
    score,
    status: score >= PASS ? 'pass' : score >= CLOSE ? 'close' : 'fail',
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
  const out = new PNG({ width: w, height: h });
  const bad = pixelmatch(ra.data, rb.data, out.data, w, h, { threshold: 0.05, alpha: 0.3 });
  if (outFile) fs.writeFileSync(outFile, PNG.sync.write(out));
  // Flat backgrounds would inflate a plain pixel ratio, so only count "ink":
  // pixels that differ from the original's dominant color in either image.
  return Math.max(0, 1 - bad / Math.max(inkPixels(ra, rb), (w * h) * 0.02));
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
