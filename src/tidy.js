// Tidy pass, run last: make the blocks easy to edit in WordPress.
// - spacing (margin, padding, block gap) snaps to a spacing scale built from the values the page uses,
// - font sizes snap to a type scale, colors to palette colors (new ones are added as accents),
// so the editor shows preset pickers and sliders instead of one-off pixel values;
// - every section, and any block repeated 3+ times side by side (cards, timeline rows), becomes a
//   theme pattern the user can insert again.
// Scales go to convert/presets.json (build writes them into theme.json); patterns to convert/patterns.json.
import fs from 'node:fs';
import path from 'node:path';
import { launch } from './browser.js';
import { devenv } from './devenv.js';
import { read, write, exists } from './guard.js';

const MAX_SPACING = 10;
const MAX_FONT = 10;

export async function tidyPass(ctx) {
  const conv = read(path.join(ctx.dir, 'convert', 'done.json'));
  const tokens = read(path.join(ctx.dir, 'extract', 'tokens.json'));
  const blocksDir = path.join(ctx.dir, 'convert', 'blocks');
  const files = conv.sections.map((s) => ({ s, file: path.join(blocksDir, `${s.id}.html`) })).filter((x) => exists(x.file));
  const prevPresets = exists(path.join(ctx.dir, 'convert', 'presets.json')) ? read(path.join(ctx.dir, 'convert', 'presets.json')) : null;

  const env = devenv(ctx.site);
  const siteUrl = env.ensureSite('c2t-converter', 'clone2theme converter');
  const browser = await launch({ local: true });
  try {
    const page = await browser.newPage({ ignoreHTTPSErrors: true });
    await page.goto(`${siteUrl}wp-admin/?vip-dev-autologin=${env.loginKey()}`, { waitUntil: 'domcontentloaded' });
    await page.goto(`${siteUrl}wp-admin/post-new.php?post_type=page`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.wp?.blocks?.parse && wp.blocks.getBlockTypes().length > 40, null, { timeout: 60000 });

    // Every preset slug a block may already carry, resolved back to its value.
    const known = {
      fonts: Object.fromEntries([...(tokens.fontSizes || []), ...(prevPresets?.fonts || [])].map((f) => [f.slug, parseFloat(f.size)])),
      spacing: Object.fromEntries((prevPresets?.spacing || []).map((p) => [p.slug, parseFloat(p.size)])),
      colors: Object.fromEntries([...tokens.palette, ...(prevPresets?.extraColors || [])].map((p) => [p.slug, p.color])),
    };
    const used = { spacing: [], fonts: [], colors: {} };
    for (const { file } of files) {
      const v = await page.evaluate(collectValues, { markup: fs.readFileSync(file, 'utf8'), known });
      used.spacing.push(...v.spacing); used.fonts.push(...v.fonts);
      for (const [c, n] of Object.entries(v.colors)) used.colors[c] = (used.colors[c] || 0) + n;
    }
    const spacing = scale(used.spacing, MAX_SPACING, 2, 0.08).map((px, i) => ({ slug: `c2t-${i + 1}`, name: `${px}px`, size: `${px}px` }));
    const fonts = scale(used.fonts, MAX_FONT, 1, 0.04).map((px, i) => ({ slug: `c2t-size-${i + 1}`, name: `${px}px`, size: `${px}px` }));
    // Palette: the extracted one, plus colors used at least twice that aren't already in it.
    const palette = [...tokens.palette];
    const extraColors = [];
    for (const [hex, n] of Object.entries(used.colors).sort((a, b) => b[1] - a[1])) {
      if (n < 2 || palette.some((p) => dist(p.color, hex) <= 8) || extraColors.length >= 8) continue;
      const c = { slug: `accent-${extraColors.length + 1}`, name: `Accent ${extraColors.length + 1}`, color: hex };
      extraColors.push(c); palette.push(c);
    }

    const patterns = [];
    for (const { s, file } of files) {
      const out = await page.evaluate(tidy, { markup: fs.readFileSync(file, 'utf8'), known, spacing, fonts, palette });
      fs.writeFileSync(file, out.markup);
      const name = (s.heading || '').replace(/\s+/g, ' ').trim().slice(0, 40) || `Section ${s.id}`;
      const title = s.role === 'header' ? 'Site header' : s.role === 'footer' ? 'Site footer' : name;
      patterns.push({ slug: `section-${s.id}`, title, category: 'c2t-sections', markup: out.markup });
      out.repeats.forEach((r, k) => patterns.push({ slug: `section-${s.id}-item-${k + 1}`, title: `${name}: ${r.label || 'item'}`, category: 'c2t-items', markup: r.markup }));
    }
    const presets = { spacing, fonts, extraColors };
    write(path.join(ctx.dir, 'convert', 'presets.json'), presets);
    write(path.join(ctx.dir, 'convert', 'patterns.json'), patterns);
    return { spacing: spacing.length, fonts: fonts.length, colors: extraColors.length, patterns: patterns.length };
  } finally {
    await browser.close();
  }
}

const rgbOf = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const dist = (a, b) => rgbOf(a).reduce((s, v, i) => s + Math.abs(v - rgbOf(b)[i]), 0);

// Cluster values (each within max(abs, rel × value) of the cluster's first) into at most `max` steps.
function scale(values, max, abs, rel) {
  const v = values.filter((n) => n > 0).sort((a, b) => a - b);
  let groups = [];
  for (const n of v) {
    const g = groups[groups.length - 1];
    if (g && n - g[0] <= Math.max(abs, g[0] * rel)) g.push(n); else groups.push([n]);
  }
  // Too many steps: merge the closest neighbors.
  while (groups.length > max) {
    let k = 0, best = Infinity;
    for (let i = 0; i < groups.length - 1; i++) {
      const d = groups[i + 1][0] / groups[i][groups[i].length - 1];
      if (d < best) { best = d; k = i; }
    }
    groups.splice(k, 2, [...groups[k], ...groups[k + 1]]);
  }
  return groups.map((g) => Math.round(g[Math.floor(g.length / 2)]));
}

// Runs in the block editor page: every spacing px, font size px and hex color the blocks use.
function collectValues({ markup, known }) {
  const out = { spacing: [], fonts: [], colors: {} };
  const px = (v) => (typeof v === 'string' && /^-?\d+(\.\d+)?px$/.test(v) ? parseFloat(v) : null);
  const sp = (v) => {
    const m = typeof v === 'string' && v.match(/^var:preset\|spacing\|(.+)$/);
    return m ? known.spacing[m[1]] ?? null : px(v);
  };
  const walk = (list) => list.forEach((b) => {
    const st = b.attributes.style || {};
    for (const kind of ['margin', 'padding']) for (const v of Object.values(st.spacing?.[kind] || {})) { const n = sp(v); if (n) out.spacing.push(n); }
    const gap = st.spacing?.blockGap;
    for (const v of typeof gap === 'object' && gap ? Object.values(gap) : [gap]) { const n = sp(v); if (n) out.spacing.push(n); }
    const fs = px(st.typography?.fontSize) ?? known.fonts[b.attributes.fontSize];
    if (fs) out.fonts.push(fs);
    for (const c of [st.color?.text, st.color?.background, st.border?.color, st.elements?.link?.color?.text]) {
      if (typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c)) out.colors[c.toLowerCase()] = (out.colors[c.toLowerCase()] || 0) + 1;
    }
    walk(b.innerBlocks || []);
  });
  walk(wp.blocks.parse(markup));
  return out;
}

// Runs in the block editor page: snap values to presets, find repeated siblings.
function tidy({ markup, known, spacing, fonts, palette }) {
  const { parse, serialize, createBlock } = wp.blocks;
  const rebuild = (list) => list.filter((b) => b.name).map((b) => createBlock(b.name, b.attributes, rebuild(b.innerBlocks || [])));
  const blocks = rebuild(parse(markup));
  const px = (v) => (typeof v === 'string' && /^-?\d+(\.\d+)?px$/.test(v) ? parseFloat(v) : null);
  const near = (list, n, abs, rel) => {
    let best = null;
    for (const p of list) { const d = Math.abs(parseFloat(p.size) - n); if (d <= Math.max(abs, n * rel) && (!best || d < best.d)) best = { p, d }; }
    return best?.p || null;
  };
  const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const color = (hex) => {
    if (typeof hex !== 'string' || !/^#[0-9a-f]{6}$/i.test(hex)) return null;
    let best = null;
    for (const p of palette) { const d = rgb(p.color).reduce((s, v, i) => s + Math.abs(v - rgb(hex.toLowerCase())[i]), 0); if (d <= 8 && (!best || d < best.d)) best = { p, d }; }
    return best?.p.slug || null;
  };
  const snapSpace = (v) => {
    const m = typeof v === 'string' && v.match(/^var:preset\|spacing\|(.+)$/);
    const n = m ? known.spacing[m[1]] : px(v);
    if (n == null || n < 0) return v;
    if (n === 0) return '0';
    const p = near(spacing, n, 2, 0.08);
    return p ? `var:preset|spacing|${p.slug}` : `${n}px`;
  };
  const walk = (list) => list.forEach((b) => {
    const a = b.attributes;
    const st = a.style;
    if (st?.spacing) {
      for (const kind of ['margin', 'padding']) {
        if (!st.spacing[kind]) continue;
        for (const side of Object.keys(st.spacing[kind])) st.spacing[kind][side] = snapSpace(st.spacing[kind][side]);
      }
      const g = st.spacing.blockGap;
      if (typeof g === 'string') st.spacing.blockGap = snapSpace(g);
      else if (g && typeof g === 'object') for (const k of Object.keys(g)) g[k] = snapSpace(g[k]);
    }
    // Font size: a scale step instead of a pixel value.
    const fsz = px(st?.typography?.fontSize) ?? known.fonts[a.fontSize];
    if (fsz) {
      const p = near(fonts, fsz, 1, 0.04);
      if (p) { a.fontSize = p.slug; if (st?.typography) delete st.typography.fontSize; }
    }
    // Colors: palette slugs (shown as swatches) instead of hex.
    if (st?.color) {
      const t = color(st.color.text), bg = color(st.color.background);
      if (t) { a.textColor = t; delete st.color.text; }
      if (bg) { a.backgroundColor = bg; delete st.color.background; }
      if (!Object.keys(st.color).length) delete st.color;
    }
    if (st?.border?.color) { const c = color(st.border.color); if (c && 'borderColor' in (wp.blocks.getBlockType(b.name)?.attributes || {})) { a.borderColor = c; delete st.border.color; } }
    const lc = st?.elements?.link?.color?.text;
    if (lc) { const c = color(lc); if (c) st.elements.link.color.text = `var:preset|color|${c}`; }
    walk(b.innerBlocks || []);
  });
  walk(blocks);

  // Repeated siblings: same block shape 3+ times in one list (cards, rows). First one becomes a pattern.
  const shape = (b, d = 0) => (d > 4 ? b.name : `${b.name}(${(b.innerBlocks || []).map((c) => shape(c, d + 1)).join(',')})`);
  const firstText = (b) => {
    if (b.name === 'core/heading') return String(b.attributes.content || '').replace(/<[^>]+>/g, '').trim();
    for (const c of b.innerBlocks || []) { const t = firstText(c); if (t) return t; }
    return '';
  };
  const repeats = [];
  const seen = new Set();
  const scan = (list, parent) => {
    const counts = {};
    list.forEach((b) => { if (b.innerBlocks?.length) { const k = shape(b); counts[k] = (counts[k] || 0) + 1; } });
    for (const [k, n] of Object.entries(counts)) {
      if (n < 3 || seen.has(k)) continue;
      seen.add(k);
      let first = list.find((b) => shape(b) === k);
      // A column can't stand alone: the whole row of columns is the pattern.
      if (first.name === 'core/column') first = parent;
      if (!first) continue;
      const kind = first.name === 'core/columns' ? 'row' : 'item';
      repeats.push({ label: `${kind} like "${firstText(first).slice(0, 30) || 'the first one'}"`, markup: serialize([first]) });
    }
    list.forEach((b) => scan(b.innerBlocks || [], b));
  };
  scan(blocks, null);
  return { markup: serialize(blocks), repeats: repeats.slice(0, 4) };
}
