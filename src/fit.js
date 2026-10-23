// Fit pass, run after verify: correct vertical gaps from what the clone actually rendered.
// For each pair of neighboring blocks in a top-to-bottom list, the gap the original had is compared
// with the gap the clone drew, and the lower block's top margin moves by the difference.
// Sections only keep a fit when their score goes up (see keepBetter).
import fs from 'node:fs';
import path from 'node:path';
import { launch } from './browser.js';
import { devenv } from './devenv.js';
import { read, write, exists } from './guard.js';

const MIN_DELTA = 4; // px; smaller gaps are rendering noise

export async function fitPass(ctx) {
  const gapsFile = path.join(ctx.dir, 'verify', 'gaps.json');
  if (!exists(gapsFile)) return [];
  const gaps = read(gapsFile);
  const blocksDir = path.join(ctx.dir, 'convert', 'blocks');
  const todo = Object.entries(gaps).filter(([, g]) => g?.elements?.some((e) => e.c));
  if (!todo.length) return [];

  const env = devenv(ctx.site);
  const siteUrl = env.ensureSite('c2t-converter', 'clone2theme converter');
  const browser = await launch({ local: true });
  const changed = [];
  try {
    const page = await browser.newPage({ ignoreHTTPSErrors: true });
    await page.goto(`${siteUrl}wp-admin/?vip-dev-autologin=${env.loginKey()}`, { waitUntil: 'domcontentloaded' });
    await page.goto(`${siteUrl}wp-admin/post-new.php?post_type=page`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.wp?.blocks?.parse && wp.blocks.getBlockTypes().length > 40, null, { timeout: 60000 });
    for (const [id, g] of todo) {
      const file = path.join(blocksDir, `${id}.html`);
      if (!exists(file)) continue;
      const at = Object.fromEntries(g.elements.filter((e) => e.c).map((e) => [e.index, { o: e.o, c: e.c }]));
      const markup = fs.readFileSync(file, 'utf8');
      const out = await page.evaluate(nudge, { markup, at, min: MIN_DELTA });
      if (out.moved) {
        fs.copyFileSync(file, path.join(blocksDir, `${id}.prefit.html`));
        fs.writeFileSync(file, out.markup);
        changed.push({ id, moved: out.moved });
      }
    }
  } finally {
    await browser.close();
  }
  return changed;
}

// After the re-verify: sections whose score dropped go back to their pre-fit markup.
export function keepBetter(ctx, before) {
  const after = Object.fromEntries(read(path.join(ctx.dir, 'verify', 'done.json')).sections.map((s) => [s.id, s.score]));
  const blocksDir = path.join(ctx.dir, 'convert', 'blocks');
  const reverted = [];
  for (const [id, score] of Object.entries(before)) {
    const pre = path.join(blocksDir, `${id}.prefit.html`);
    if (!exists(pre)) continue;
    if (after[id] != null && score != null && after[id] < score) {
      fs.copyFileSync(pre, path.join(blocksDir, `${id}.html`));
      reverted.push(id);
    }
    fs.rmSync(pre);
  }
  return reverted;
}

// Runs in the block editor page.
function nudge({ markup, at, min }) {
  const { parse, serialize, createBlock } = wp.blocks;
  const rebuild = (list) => list.filter((b) => b.name).map((b) => createBlock(b.name, b.attributes, rebuild(b.innerBlocks || [])));
  const blocks = rebuild(parse(markup));
  // Original and clone vertical extent of a block: its own element plus everything inside it.
  const span = (b, side) => {
    const e = at[b.attributes.metadata?.c2t];
    let r = e ? { top: e[side].y, bottom: e[side].y + e[side].h } : null;
    for (const c of b.innerBlocks || []) {
      const s = span(c, side);
      if (s) r = r ? { top: Math.min(r.top, s.top), bottom: Math.max(r.bottom, s.bottom) } : s;
    }
    return r;
  };
  let moved = 0;
  const walk = (list, parent) => {
    const horizontal = parent && (parent.name === 'core/columns' || parent.name === 'core/navigation' || parent.name === 'core/buttons' || parent.attributes.layout?.type === 'flex');
    let prev = null;
    for (const b of list) {
      walk(b.innerBlocks || [], b);
      const o = span(b, 'o'), c = span(b, 'c');
      if (!horizontal && prev && o && c && o.top >= prev.o.bottom - 2) {
        const want = o.top - prev.o.bottom, have = c.top - prev.c.bottom;
        const delta = want - have;
        if (Math.abs(delta) >= min) {
          const s = b.attributes.style || {};
          const cur = parseFloat(s.spacing?.margin?.top);
          // No explicit margin means the layout's block gap (about 24px) was in effect.
          const next = Math.round(Math.min(300, Math.max(0, (Number.isFinite(cur) ? cur : 24) + delta)));
          b.attributes.style = { ...s, spacing: { ...(s.spacing || {}), margin: { ...(s.spacing?.margin || {}), top: `${next}px` } } };
          moved++;
        }
      }
      if (o && c) prev = { o, c };
    }
  };
  walk(blocks, null);
  return { markup: serialize(blocks), moved };
}
