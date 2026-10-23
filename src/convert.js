// HTML -> blocks using WordPress's own converter, running in the dev-env block editor.
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { launch } from './browser.js';
import { devenv } from './devenv.js';
import { read, write, exists, withRetry } from './guard.js';
import { patternFor, budget, MODEL, isAi } from './ai.js';
import { CLOSE, SCORER } from './verify.js';
import { sectionWidth } from './extract.js';

export async function convert(ctx, dir) {
  const exDir = path.join(ctx.dir, 'extract');
  const sections = read(path.join(exDir, 'sections.json'));
  const prev = exists(path.join(dir, 'done.json')) ? read(path.join(dir, 'done.json')) : null;
  const only = ctx.section && prev ? String(ctx.section).padStart(2, '0') : null;

  const env = devenv(ctx.site);
  const siteUrl = env.ensureSite('c2t-converter', 'clone2theme converter');
  const key = env.loginKey();
  if (!key) throw new Error('no dev-env autologin key (vip dev-env info)');

  // AI targets: sections the plain converter left as raw HTML, or that scored low last verify.
  const tokens = read(path.join(exDir, 'tokens.json'));
  const palette = tokens.palette;
  const dom = read(path.join(ctx.dir, 'capture', 'dom.json'));
  const lastVerify = exists(path.join(ctx.dir, 'verify', 'done.json')) ? read(path.join(ctx.dir, 'verify', 'done.json')) : null;
  const weak = new Set((lastVerify?.sections || []).filter((v) => v.score !== null && v.score < CLOSE).map((v) => v.id));
  const lastScore = Object.fromEntries((lastVerify?.sections || []).map((v) => [v.id, v.score]));
  const prevBy = Object.fromEntries((prev?.sections || []).map((p) => [p.id, p]));
  const aiOn = !ctx.noAi; // cache hits work offline; live calls need credentials
  const b = budget(ctx);
  let aiStop = null;

  const browser = await launch({ local: true });
  const results = [];
  try {
    const page = await browser.newPage({ ignoreHTTPSErrors: true });
    await page.goto(`${siteUrl}wp-admin/?vip-dev-autologin=${key}`, { waitUntil: 'domcontentloaded' });
    await page.goto(`${siteUrl}wp-admin/post-new.php?post_type=page`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.wp?.blocks?.rawHandler && wp.blocks.getBlockTypes().length > 40, null, { timeout: 60000 });

    fs.mkdirSync(path.join(dir, 'blocks'), { recursive: true });
    for (const s of sections) {
      if (only && s.id !== only) {
        results.push(prev.sections.find((p) => p.id === s.id));
        continue;
      }
      // A strip with no words and no images (decoration drawn in svg/CSS) becomes a sized, colored band.
      const html = !s.words && !s.images ? '' : fs.readFileSync(path.join(exDir, 'sections', `${s.id}.html`), 'utf8');
      const empty = !html;
      const aiHtml = html.replace(/ data-c2t-id="[^"]*"/g, ''); // ids are for layout lookups, not the model
      const shot = path.join(ctx.dir, 'capture', 'sections', `${s.id}.png`);
      const base = { html, bg: s.bg, height: s.height, width: sectionWidth(s), pad: !s.bg && exists(shot) ? padding(shot) : null, bgColor: s.bgColor, textColor: s.textColor, linkColor: s.linkColor, role: s.role,
        layout: dom.layout?.[s.id] || {}, els: dom.elements?.[s.id] || [], fonts: tokens.fonts, sizes: tokens.fontSizes };
      let out = await page.evaluate(toBlocks, base);
      const plainUnclear = !empty && (out.total ? out.unclear / out.total : 1) > 0.5;
      // Plain score: the last verify of a plain conversion, carried over while Haiku's version is live.
      const p = prevBy[s.id];
      const plainScore = (p && !isAi(p.ai) ? lastScore[s.id] : p?.plainScore) ?? null;
      const keepPlain = p?.keepPlain?.scorer === SCORER ? p.keepPlain : null;
      let ai = ctx.noAi ? 'skipped (--no-ai)' : 'not needed';
      if (aiStop) ai = aiStop;
      else if (keepPlain && only !== s.id && aiOn) ai = `kept plain (${keepPlain.model || 'Haiku'} ${pct(keepPlain.haiku)} vs plain ${pct(keepPlain.plain)})`;
      else if (aiOn && html && (plainUnclear || weak.has(s.id) || only === s.id)) {
        const got = await withRetry(`ai:${s.id}`, async (lastErr) => {
          const r = await patternFor({ html: aiHtml, screenshot: path.join(ctx.dir, 'capture', 'sections', `${s.id}.png`), palette, lastError: lastErr?.message, b });
          const o = await page.evaluate(toBlocks, { ...base, aiMarkup: r.markup });
          if (o.aiError) throw new Error(o.aiError);
          if (o.total && o.unclear / o.total > 0.3) throw new Error(`${o.unclear} of ${o.total} blocks were raw HTML`);
          const lost = fidelity(aiHtml, r.markup);
          if (lost) throw new Error(lost);
          return { ...o, pattern: r.pattern, cached: r.cached };
        }, 1);
        if (got.status === 'needs-human') {
          // Credential problems won't fix themselves on the next section: stop calling.
          if (/no Anthropic credentials/.test(got.error)) aiStop = 'skipped (no Anthropic credentials)';
          else if (/authentication_error|invalid x-api-key|^401/.test(got.error)) aiStop = 'skipped (Anthropic rejected the API key)';
          ai = aiStop || `failed: ${got.error}`;
        }
        else {
          write(path.join(dir, 'blocks', `${s.id}.plain.html`), out.markup); // the score guard may swap back to this
          out = got;
          ai = `${MODEL}: ${got.pattern}${got.cached ? ' (cached)' : ''}`;
        }
      }
      write(path.join(dir, 'blocks', `${s.id}.html`), out.markup);
      const unclearShare = out.total ? out.unclear / out.total : 1;
      results.push({
        id: s.id,
        role: s.role,
        heading: s.heading,
        blocks: out.total,
        counts: out.counts,
        unclear: !empty && unclearShare > 0.5,
        unclearShare: Math.round(unclearShare * 100) / 100,
        ai,
        plainScore,
        keepPlain: ai.startsWith('kept plain') ? keepPlain : null,
      });
    }
  } finally {
    await browser.close();
  }
  b.save();
  return {
    converter: siteUrl,
    sections: results,
    unclear: results.filter((r) => r.unclear).map((r) => r.id),
    ai: { ...b.state, used: results.filter((r) => isAi(r.ai)).map((r) => r.id) },
  };
}

const pct = (n) => `${Math.round(n * 100)}%`;

// Score guard, run after verify: a Haiku rebuild that doesn't beat the plain conversion is swapped back
// and pinned to plain so later runs don't re-apply it. Returns the reverted section ids.
export function guardAi(runDir) {
  const convFile = path.join(runDir, 'convert', 'done.json');
  const verFile = path.join(runDir, 'verify', 'done.json');
  if (!exists(convFile) || !exists(verFile)) return [];
  const conv = read(convFile);
  const score = Object.fromEntries(read(verFile).sections.map((v) => [v.id, v.score]));
  const reverted = [];
  for (const s of conv.sections) {
    const haiku = score[s.id];
    const plainFile = path.join(runDir, 'convert', 'blocks', `${s.id}.plain.html`);
    if (!isAi(s.ai) || s.plainScore == null || haiku == null || haiku > s.plainScore || !exists(plainFile)) continue;
    fs.copyFileSync(plainFile, path.join(runDir, 'convert', 'blocks', `${s.id}.html`));
    const model = s.ai.split(':')[0];
    s.keepPlain = { haiku, plain: s.plainScore, scorer: SCORER, model };
    s.ai = `kept plain (${model} ${pct(haiku)} vs plain ${pct(s.plainScore)})`;
    reverted.push(s.id);
  }
  if (reverted.length) {
    conv.ai.used = conv.ai.used.filter((id) => !reverted.includes(id));
    write(convFile, conv);
  }
  return reverted;
}

// Top/bottom padding of the original section, read off its screenshot: the plain background rows
// above the first and below the last row with any content.
function padding(file) {
  const { width: w, height: h, data } = PNG.sync.read(fs.readFileSync(file));
  if (h < 20) return null;
  const E = 3; // skip edge rows: fractional section bounds pick up a sliver of the neighbor
  const bg = [0, 1, 2].map((c) => data[(E * w + 2) * 4 + c]);
  const busy = (y) => {
    let n = 0;
    for (let x = 0; x < w; x += 2) {
      const i = (y * w + x) * 4;
      if (Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2]) > 48) n++;
    }
    return n > w / 2 / 200;
  };
  let top = E, bottom = h - 1 - E;
  while (top < h && !busy(top)) top++;
  while (bottom > top && !busy(bottom)) bottom--;
  if (top >= h) return null;
  const clamp = (n) => Math.min(240, Math.max(0, n));
  return { top: clamp(top), bottom: clamp(h - 1 - bottom) };
}

// Content check for AI answers: every image kept, nearly all words kept.
function fidelity(html, markup) {
  const srcs = (h) => new Set([...h.matchAll(/(?:src="|"url":")([^"]+)/g)].map((m) => m[1]));
  // Labels kept in block attributes (navigation links) count as text too.
  const words = (h) => (h.replace(/<!--[\s\S]*?-->/g, (c) => [...c.matchAll(/"label":"((?:[^"\\]|\\.)*)"/g)].map((m) => ` ${m[1]} `).join(' ')).replace(/<[^>]+>/g, ' ').match(/[\p{L}\p{N}’']+/gu) || []).length;
  const out = srcs(markup);
  const missing = [...srcs(html)].filter((u) => !out.has(u)).length;
  const kept = words(markup) / Math.max(1, words(html));
  const problems = [];
  if (missing) problems.push(`${missing} images from the HTML are missing`);
  if (kept < 0.9) problems.push(`only ${Math.round(kept * 100)}% of the text is present`);
  return problems.length ? `content dropped: ${problems.join(', ')}. Include every image and all text, even if the section is long.` : null;
}

// Runs in the block editor page.
function toBlocks({ html, bg, height, width, pad, bgColor, textColor, linkColor, role, aiMarkup, layout = {}, els = [], fonts = [], sizes = [] }) {
  const { rawHandler, createBlock, serialize, parse, getBlockType } = wp.blocks;

  const BLOCK = /^(H[1-6]|P|UL|OL|TABLE|BLOCKQUOTE|PRE|FIGURE|HR|IMG)$/;
  const INLINE = /^(A|SPAN|STRONG|EM|B|I|SMALL|BR|SUP|SUB|CODE|MARK|U|S|TIME|ABBR|LABEL)$/;
  const HAS_BLOCK = 'h1,h2,h3,h4,h5,h6,p,div,ul,ol,table,section,article,figure,blockquote';
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const L = (n) => (n?.getAttribute ? layout[n.getAttribute('data-c2t-id')] : null);
  const px = (n) => `${Math.round(n)}px`;
  // Layout ids stay out of saved content; source-code line breaks are just spaces (not <br>), except in <pre>.
  const leaf = (h) => rawHandler({ HTML: h.replace(/ data-c2t-id="[^"]*"/g, '').replace(/^(?![\s\S]*<pre)[\s\S]*$/, (x) => x.replace(/\s*\n\s*/g, ' ')) });

  // Plain conversion keeps the original's structure: side-by-side children become columns (wide items)
  // or a flex row (small items like links, stats, buttons); boxes with a border or their own background
  // become framed groups (cards). Everything else flows top to bottom.
  function build(node) {
    const out = [];
    let run = [];
    const flush = () => {
      const box = document.createElement('p');
      run.forEach((n) => box.append(n.cloneNode(true)));
      if (box.textContent.trim() || box.querySelector('img')) out.push(...leaf(box.outerHTML));
      run = [];
    };
    for (const n of [...node.childNodes]) {
      if (n.nodeType === 3) { if (n.textContent.trim()) run.push(n); continue; }
      if (n.nodeType !== 1) continue;
      if (n.tagName === 'C2T-SEARCH') { flush(); out.push(...blocksOf(n)); }
      else if (BLOCK.test(n.tagName) && !rowList(n)) { flush(); out.push(...blocksOf(n)); }
      else if (INLINE.test(n.tagName) && !n.querySelector(HAS_BLOCK)) {
        // Inline in the HTML but drawn on its own line (display:block in CSS): start a new paragraph.
        const b = L(n), last = [...run].reverse().find((r) => L(r));
        if (b && last && b.y >= L(last).y + L(last).h - 2) flush();
        run.push(n);
      } else { flush(); out.push(...container(n)); }
    }
    flush();
    return out;
  }
  function rowList(n) {
    if (!/^(UL|OL)$/.test(n.tagName) || L(n)?.d !== 'flex' && L(n)?.d !== 'grid') return false;
    const menu = [...n.children].every((li) => li.children.length === 1 && li.firstElementChild.tagName === 'A' && li.textContent.trim() === li.firstElementChild.textContent.trim()
      && !L(li.firstElementChild)?.bw && !L(li.firstElementChild)?.bg); // framed links are buttons
    return !(menu && (role === 'header' || role === 'footer'));
  }
  function blocksOf(n) {
    if (n.tagName === 'C2T-SEARCH') {
      return [createBlock('core/search', { label: n.getAttribute('data-label') || 'Search', showLabel: false, placeholder: n.getAttribute('data-placeholder') || '', buttonText: n.getAttribute('data-button') || 'Search' })];
    }
    if (rowList(n)) return container(n);
    if (BLOCK.test(n.tagName)) {
      const c = n.cloneNode(true);
      c.querySelectorAll('div,section,article,header,footer,nav,aside').forEach((d) => d.replaceWith(...d.childNodes));
      return leaf(c.outerHTML);
    }
    if (INLINE.test(n.tagName) && !n.querySelector(HAS_BLOCK)) {
      const p = document.createElement('p');
      p.append(n.cloneNode(true));
      return p.textContent.trim() || p.querySelector('img') ? leaf(p.outerHTML) : [];
    }
    return container(n);
  }
  function container(n) {
    const kids = [...n.children];
    const hasText = [...n.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim());
    // Row mode needs a box for every child that carries content; otherwise flow.
    const boxed = kids.every((k) => L(k) || (!k.textContent.trim() && !k.querySelector('img')));
    const flow = kids.filter((k) => L(k) && !L(k).abs);
    const lines = !hasText && boxed ? linesOf(flow) : null;
    // Absolutely positioned children with content (badges, overlays) still keep their content, after the rows.
    const inner = lines && lines.some((l) => l.length > 1)
      ? [...lines.flatMap((line) => (line.length > 1 ? rowBlock(n, line) : blocksOf(line[0]))), ...kids.filter((k) => L(k)?.abs).flatMap(blocksOf)]
      : build(n);
    return frame(n, inner);
  }
  // Group children into visual lines: a child joins a line it overlaps vertically without overlapping
  // any item in it horizontally (DOM order can differ from drawing order). Items are then left to right.
  function linesOf(kids) {
    const lines = [];
    for (const k of kids) {
      const b = L(k);
      const line = lines.find((l) => Math.min(b.y + b.h, l.bottom) - Math.max(b.y, l.top) > 0.3 * Math.min(b.h, l.minH)
        && l.items.every((i) => { const q = L(i); return b.x >= q.x + q.w - 4 || b.x + b.w <= q.x + 4; }));
      if (line) { line.items.push(k); line.top = Math.min(line.top, b.y); line.bottom = Math.max(line.bottom, b.y + b.h); line.minH = Math.min(line.minH, b.h); }
      else lines.push({ items: [k], top: b.y, bottom: b.y + b.h, minH: b.h });
    }
    return lines.sort((p, q) => p.top - q.top).map((l) => l.items.sort((p, q) => L(p).x - L(q).x));
  }
  function rowBlock(parent, line) {
    // Items with no content (icon or line drawn in svg/CSS) stay as empty space so the rest keep their place.
    const all = line.map((k) => ({ k, b: L(k), blocks: blocksOf(k) }));
    const items = all.filter((x) => x.blocks.length || x.b.w >= 8);
    if (all.filter((x) => x.blocks.length).length < 1) return [];
    if (items.length < 2) return items.flatMap((x) => x.blocks);
    const left = Math.min(...items.map((x) => x.b.x)), right = Math.max(...items.map((x) => x.b.x + x.b.w));
    const span = Math.max(1, right - left);
    const gaps = items.slice(1).map((x, i) => x.b.x - (items[i].b.x + items[i].b.w));
    const gap = Math.max(0, Math.round(gaps.reduce((a, g) => a + g, 0) / gaps.length));
    const tops = items.map((x) => x.b.y), mids = items.map((x) => x.b.y + x.b.h / 2);
    const spread = (v) => Math.max(...v) - Math.min(...v);
    const PL = L(parent);
    const valign = PL?.d === 'flex' && PL.dir !== 'column' && PL.ai === 'center' ? 'center' : spread(tops) <= 4 ? 'top' : spread(mids) <= 6 ? 'center' : 'top';
    const pw = L(parent)?.w || span;
    const centered = (b) => b?.d === 'flex' && ((b.dir === 'column' && b.jc === 'center') || (b.dir !== 'column' && b.ai === 'center'));
    if (items.filter((x) => x.blocks.length).every((x) => x.b.w >= pw * 0.2)) {
      // A row touching the section edge bleeds: full width, padded on the side that doesn't.
      const vw = 1440;
      const bleedL = left <= 2 && width, bleedR = right >= vw - 2 && width;
      const gutter = width ? (vw - width) / 2 : 0;
      const bleed = bleedL || bleedR ? { align: 'full', style: { spacing: { blockGap: { left: px(gap) }, padding: { left: bleedL ? '0px' : px(gutter), right: bleedR ? '0px' : px(gutter) } } } } : null;
      return [createBlock('core/columns', { ...(valign === 'center' ? { verticalAlignment: 'center' } : {}), style: { spacing: { blockGap: { left: px(gap) } } }, ...(bleed || {}) },
        items.map((x) => createBlock('core/column', { width: `${Math.round((x.b.w / span) * 1000) / 10}%`, ...(centered(x.b) ? { verticalAlignment: 'center' } : {}) }, x.blocks)))];
    }
    // Justification from where the items actually sit in the parent's content box.
    const P = L(parent), pad = P?.pad || [0, 0, 0, 0];
    const cl = P ? P.x + pad[3] : left, cr = P ? P.x + P.w - pad[1] : right;
    const atL = left - cl <= 8, atR = cr - right <= 8;
    const set = { 'space-between': 'space-between', 'space-around': 'space-between', 'space-evenly': 'space-between', center: 'center', 'flex-end': 'right', end: 'right', right: 'right' }[P?.jc];
    const jc = set && P?.d === 'flex' ? set : atL && atR ? (items.length > 1 && cr - cl - span > 8 ? 'space-between' : 'left') : atL ? 'left' : atR ? 'right' : Math.abs((left - cl) - (cr - right)) <= 12 ? 'center' : 'left';
    // A row that fits on a phone never wraps (it was one line in the original); wider rows may wrap.
    return [createBlock('core/group', { layout: { type: 'flex', flexWrap: span <= 400 ? 'nowrap' : 'wrap', justifyContent: jc, verticalAlignment: valign }, style: { spacing: { blockGap: px(gap) } } },
      items.map((x) => {
        if (!x.blocks.length) return createBlock('core/spacer', { width: px(x.b.w), height: '0px' });
        const item = x.blocks.length === 1 ? x.blocks[0] : createBlock('core/group', { layout: { type: 'default' } }, x.blocks);
        // Small items keep their measured width so labels don't wrap; wide ones stay fluid for phones.
        if (x.b.w <= 400) item.attributes.style = { ...(item.attributes.style || {}), layout: { selfStretch: 'fixed', flexSize: px(x.b.w + 2) } }; // +2: sub-pixel slack
        return item;
      }))];
  }
  // A box with a border, or a background different from what's behind it, becomes a framed group.
  function frame(n, inner) {
    const f = L(n);
    if (!f || !inner.length) return inner;
    let behind = null;
    for (let p = n.parentElement; p && !behind; p = p.parentElement) behind = L(p)?.bg || null;
    behind = behind || bgColor;
    const ownBg = f.bg && solid(f.bg) !== solid(behind) ? solid(f.bg) : null;
    if (!f.bw && !ownBg) return inner;
    const style = {
      ...(ownBg ? { color: { background: ownBg } } : {}),
      ...(f.bw || f.br ? { border: { ...(f.bw ? { width: px(f.bw), color: solid(f.bc) || undefined, style: 'solid' } : {}), ...(f.br ? { radius: px(f.br) } : {}) } } : {}),
      ...(f.pad ? { spacing: { padding: { top: px(f.pad[0]), right: px(f.pad[1]), bottom: px(f.pad[2]), left: px(f.pad[3]) } } } : {}),
    };
    const framed = createBlock('core/group', { style, layout: { type: 'default' } }, inner);
    // Narrower than its parent (a card beside a cleaned-away icon): keep its width and which side it sits on.
    let pb = null;
    for (let p = n.parentElement; p && !pb; p = p.parentElement) pb = L(p);
    if (!pb || f.w >= pb.w * 0.95) return [framed];
    const offL = f.x - pb.x, offR = pb.x + pb.w - (f.x + f.w);
    const side = Math.abs(offL - offR) <= 8 ? 'center' : offL > offR ? 'right' : 'left';
    return [createBlock('core/group', { layout: { type: 'constrained', contentSize: px(f.w), justifyContent: side } }, [framed])];
  }

  let inner = html ? container(doc.body) : [];
  if (aiMarkup) {
    // Rebuild from parsed names + attributes so small markup slips from the model can't leave invalid blocks.
    const unknown = new Set();
    const rebuild = (list) => list.filter((b) => b.name).map((b) => {
      if (!getBlockType(b.name) || b.name === 'core/missing') { unknown.add(b.attributes?.originalName || b.name); return null; }
      return createBlock(b.name, b.attributes, rebuild(b.innerBlocks || []));
    }).filter(Boolean);
    const rebuilt = rebuild(parse(aiMarkup));
    if (unknown.size) return { aiError: `unknown blocks: ${[...unknown].join(', ')}` };
    if (!rebuilt.length) return { aiError: 'markup parsed to zero blocks' };
    inner = rebuilt;
  }
  // Keep images at the size they rendered on the original page.
  const widths = Object.fromEntries([...doc.querySelectorAll('img[width]')].map((i) => [i.getAttribute('src'), Number(i.getAttribute('width'))]));
  const size = (list) => list.forEach((b) => {
    const w = b.name === 'core/image' && widths[b.attributes.url];
    if (w && w < 1000) b.attributes.width = `${w}px`;
    size(b.innerBlocks || []);
  });
  size(inner);
  if (role === 'header' || role === 'footer') inner = rows(inner);
  inner = styled(inner);
  const counts = {};
  let total = 0, unclear = 0;
  const walk = (list) => list.forEach((b) => {
    counts[b.name] = (counts[b.name] || 0) + 1;
    total++;
    if (['core/html', 'core/freeform', 'core/missing'].includes(b.name)) unclear++;
    walk(b.innerBlocks || []);
  });
  walk(inner);
  if (!inner.length) inner = [createBlock('core/paragraph', { content: '' })];

  const block = bg
    ? createBlock('core/cover', { url: bg, dimRatio: 40, align: 'full', minHeight: height ? Math.min(height, 1200) : 420, minHeightUnit: 'px', layout: { type: 'constrained', ...(width ? { contentSize: `${width}px` } : {}) } }, inner)
    : createBlock('core/group', {
        tagName: role === 'header' ? 'header' : role === 'footer' ? 'footer' : 'section',
        align: 'full',
        layout: { type: 'constrained', ...(width ? { contentSize: `${width}px` } : {}) },
        style: {
          // Never shorter than the original section.
          ...(height ? { dimensions: { minHeight: `${Math.min(height, 1200)}px` } } : {}),
          spacing: { padding: pad ? { top: `${pad.top}px`, bottom: `${pad.bottom}px` } : { top: 'var:preset|spacing|50', bottom: 'var:preset|spacing|50' } },
          // The original's own text and link colors, so dark sections don't inherit the theme's dark text.
          ...(solid(bgColor) || solid(textColor) ? { color: { ...(solid(bgColor) ? { background: solid(bgColor) } : {}), ...(solid(textColor) ? { text: solid(textColor) } : {}) } } : {}),
          ...(solid(linkColor) ? { elements: { link: { color: { text: solid(linkColor) } } } } : {}),
        },
      }, inner);
  return { markup: serialize([block]), total, unclear, counts };

  // Header/footer: link-only lists become horizontal navigation (at any depth). A header that is still
  // a plain stack sits on one row; in the footer a menu shares a row with the short text next to it.
  function rows(list) {
    const nav = (b) => {
      if (b.name !== 'core/list') return { ...b, innerBlocks: (b.innerBlocks || []).map(nav) };
      const links = b.innerBlocks.map((li) => !li.innerBlocks.length && String(li.attributes.content).trim().match(/^<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>$/));
      if (!links.length || !links.every(Boolean)) return b;
      return createBlock('core/navigation', { layout: { type: 'flex', flexWrap: 'wrap' }, overlayMenu: 'mobile' },
        links.map(([a, url, label]) => createBlock('core/navigation-link', { label: label.replace(/<[^>]+>/g, '').trim(), url, kind: 'custom', ...(/target="_blank"/.test(a) ? { opensInNewTab: true } : {}) })));
    };
    const navs = list.map(nav);
    const row = (items) => createBlock('core/group', { layout: { type: 'flex', justifyContent: 'space-between', flexWrap: 'wrap' } }, items);
    if (role === 'header') return navs.length > 1 && !navs.some((b) => b.attributes.layout?.type === 'flex') ? [row(navs)] : navs;
    const out = [];
    navs.forEach((b) => {
      const prev = out[out.length - 1];
      const short = b.name === 'core/paragraph' && String(b.attributes.content).replace(/<[^>]+>/g, '').split(/\s+/).length < 15;
      if (prev?.name === 'core/navigation' && short) out[out.length - 1] = row([prev, b]);
      else out.push(b);
    });
    return out;
  }

  // Style pass, for plain and AI blocks alike: each text block and image is matched to the original
  // element it came from (by its words, or image URL) and gets that element's measured type, color,
  // frame and the vertical gap to the block above it. metadata.c2t records the element for the fit pass.
  function styled(list) {
    const words = (t) => (String(t || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
    const dice = (a, b) => {
      const wa = words(a), wb = words(b);
      if (!wa.length || !wb.length) return 0;
      const count = new Map();
      wb.forEach((w) => count.set(w, (count.get(w) || 0) + 1));
      let common = 0;
      wa.forEach((w) => { const n = count.get(w); if (n) { common++; count.set(w, n - 1); } });
      return (2 * common) / (wa.length + wb.length);
    };
    const textOf = (b) => {
      const a = b.attributes;
      const v = b.name === 'core/navigation-link' ? a.label : b.name === 'core/button' ? a.text : ['core/heading', 'core/paragraph', 'core/list-item'].includes(b.name) ? a.content : null;
      return v == null ? null : String(v).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    };
    const used = new Set();
    const elOf = new Map();
    const first = (f) => String(f || '').split(',')[0].replace(/["']/g, '').trim().toLowerCase();
    const sectionText = solid(textColor);
    const walk = (bs) => bs.map((b) => {
      b.innerBlocks = walk(b.innerBlocks || []);
      if (b.name === 'core/image') {
        const k = els.findIndex((e, i) => !used.has(i) && e.kind === 'img' && e.src === b.attributes.url);
        if (k >= 0) {
          used.add(k); elOf.set(b, els[k]);
          b.attributes.metadata = { ...(b.attributes.metadata || {}), c2t: k };
          if (els[k].frame?.br) b.attributes.style = { ...(b.attributes.style || {}), border: { ...(b.attributes.style?.border || {}), radius: px(els[k].frame.br) } };
          // Shown cropped (overflow or object-fit cover): same visible box, image fills it.
          if (els[k].cropped || els[k].fit === 'cover') Object.assign(b.attributes, { width: px(els[k].w), height: px(els[k].h), scale: 'cover', aspectRatio: undefined });
        }
        return b;
      }
      const t = textOf(b);
      if (!t) return b;
      let best = -1, score = 0.6;
      els.forEach((e, i) => { if (e.kind === 'text' && !used.has(i)) { const d = dice(t, e.text); if (d > score) { score = d; best = i; } } });
      if (best < 0) return b;
      used.add(best);
      const e = els[best];
      // A lone link drawn as a box (border or fill) is a button, not a paragraph.
      const link = b.name === 'core/paragraph' && String(b.attributes.content).trim().match(/^<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>$/);
      if (link && (e.frame?.bw || e.frame?.bg)) {
        const flex = b.attributes.style?.layout; // its place in a flex row moves to the buttons wrapper
        b = createBlock('core/button', { text: link[2], url: link[1] });
        if (flex) b.c2tFlex = flex;
      }
      const st = e.style || {};
      const a = b.attributes;
      const typo = { ...(a.style?.typography || {}) };
      const preset = sizes.find((p) => Math.abs(parseFloat(p.size) - st.size) <= 1);
      if (preset) { a.fontSize = preset.slug; delete typo.fontSize; } else if (st.size) { delete a.fontSize; typo.fontSize = px(st.size); }
      if (st.weight) typo.fontWeight = String(st.weight);
      if (st.line) typo.lineHeight = String(st.line);
      if (st.spacing) typo.letterSpacing = `${st.spacing}px`;
      typo.textTransform = st.upper ? 'uppercase' : undefined;
      if (['core/heading', 'core/paragraph'].includes(b.name) && ['center', 'right', 'end'].includes(st.align)) typo.textAlign = st.align === 'end' ? 'right' : st.align;
      const fam = fonts.find((f) => first(f.fontFamily || f.name) === st.font);
      if (fam) a.fontFamily = fam.slug;
      const style = { ...(a.style || {}), typography: JSON.parse(JSON.stringify(typo)) };
      const color = solid(st.color);
      if (color && color !== sectionText) { style.color = { ...(style.color || {}), text: color }; delete a.textColor; }
      if (b.name === 'core/button') {
        const f = e.frame || {};
        style.color = { ...(style.color || {}), background: f.bg ? solid(f.bg) : 'transparent' };
        delete a.backgroundColor;
        style.border = { ...(f.bw ? { width: px(f.bw), color: solid(f.bc) || undefined, style: 'solid' } : { width: '0px' }), radius: px(f.br || 0) };
        if (f.pad) style.spacing = { ...(style.spacing || {}), padding: { top: px(f.pad[0]), right: px(f.pad[1]), bottom: px(f.pad[2]), left: px(f.pad[3]) } };
      }
      a.style = style;
      a.metadata = { ...(a.metadata || {}), c2t: best };
      elOf.set(b, e);
      return b;
    });
    let out = walk(list);
    // A button left on its own needs a core/buttons wrapper.
    const wrapButtons = (bs, parent) => {
      const res = [];
      for (const b of bs) {
        b.innerBlocks = wrapButtons(b.innerBlocks || [], b);
        // Each loose button gets its own wrapper: they were separate items in the original row.
        if (b.name === 'core/button' && parent?.name !== 'core/buttons') res.push(createBlock('core/buttons', b.c2tFlex ? { style: { layout: b.c2tFlex } } : {}, [b]));
        else res.push(b);
      }
      return res;
    };
    out = wrapButtons(out, null);
    // Menus and button rows: the gap between items as drawn (text to text), not the theme default.
    const rowGap = (bs) => bs.forEach((b) => {
      rowGap(b.innerBlocks || []);
      if (b.name !== 'core/navigation') return; // button gaps are frame to frame, set by the row
      const r = b.innerBlocks.map((c) => elOf.get(c)).filter(Boolean).sort((p, q) => p.x - q.x);
      const g = r.slice(1).map((e, i) => e.x - (r[i].x + r[i].w)).filter((v) => v >= 0);
      if (!g.length) return;
      const s2 = b.attributes.style || {};
      b.attributes.style = { ...s2, spacing: { ...(s2.spacing || {}), blockGap: px(g.reduce((a, v) => a + v, 0) / g.length) } };
    });
    rowGap(out);
    // Vertical gaps: in top-to-bottom lists, each block keeps the original's gap to the block above.
    const rect = (b) => {
      const e = elOf.get(b);
      let r = e ? { top: e.y, bottom: e.y + e.h } : null;
      for (const c of b.innerBlocks || []) {
        const s = rect(c);
        if (s) r = r ? { top: Math.min(r.top, s.top), bottom: Math.max(r.bottom, s.bottom) } : s;
      }
      return r;
    };
    const gaps = (bs, parent) => {
      const horizontal = parent && (parent.name === 'core/columns' || parent.name === 'core/navigation' || parent.name === 'core/buttons' || parent.attributes.layout?.type === 'flex');
      let prev = null;
      for (const b of bs) {
        gaps(b.innerBlocks || [], b);
        const r = rect(b);
        if (!horizontal && prev && r && r.top >= prev.bottom - 2) {
          const s = b.attributes.style || {};
          b.attributes.style = { ...s, spacing: { ...(s.spacing || {}), margin: { ...(s.spacing?.margin || {}), top: px(Math.min(240, Math.max(0, r.top - prev.bottom))) } } };
        }
        if (r) prev = r;
      }
    };
    gaps(out, null);
    return out;
  }

  // Section background as hex, skipping transparent ones.
  function solid(c) {
    const [r, g, b, a = 1] = (c || '').match(/[\d.]+/g)?.map(Number) || [];
    if (r === undefined || a < 0.5) return null;
    return '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
  }
}
