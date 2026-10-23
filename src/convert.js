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
  const palette = read(path.join(exDir, 'tokens.json')).palette;
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
      const html = fs.readFileSync(path.join(exDir, 'sections', `${s.id}.html`), 'utf8');
      const shot = path.join(ctx.dir, 'capture', 'sections', `${s.id}.png`);
      const base = { html, bg: s.bg, height: s.height, width: sectionWidth(s), pad: !s.bg && exists(shot) ? padding(shot) : null, bgColor: s.bgColor, textColor: s.textColor, linkColor: s.linkColor, role: s.role };
      let out = await page.evaluate(toBlocks, base);
      const plainUnclear = !html || (out.total ? out.unclear / out.total : 1) > 0.5;
      // Plain score: the last verify of a plain conversion, carried over while Haiku's version is live.
      const p = prevBy[s.id];
      const plainScore = (p && !isAi(p.ai) ? lastScore[s.id] : p?.plainScore) ?? null;
      const keepPlain = p?.keepPlain?.scorer === SCORER ? p.keepPlain : null;
      let ai = ctx.noAi ? 'skipped (--no-ai)' : 'not needed';
      if (aiStop) ai = aiStop;
      else if (keepPlain && only !== s.id && aiOn) ai = `kept plain (${keepPlain.model || 'Haiku'} ${pct(keepPlain.haiku)} vs plain ${pct(keepPlain.plain)})`;
      else if (aiOn && html && (plainUnclear || weak.has(s.id) || only === s.id)) {
        const got = await withRetry(`ai:${s.id}`, async (lastErr) => {
          const r = await patternFor({ html, screenshot: path.join(ctx.dir, 'capture', 'sections', `${s.id}.png`), palette, lastError: lastErr?.message, b });
          const o = await page.evaluate(toBlocks, { ...base, aiMarkup: r.markup });
          if (o.aiError) throw new Error(o.aiError);
          if (o.total && o.unclear / o.total > 0.3) throw new Error(`${o.unclear} of ${o.total} blocks were raw HTML`);
          const lost = fidelity(html, r.markup);
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
        unclear: !html || unclearShare > 0.5,
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
function toBlocks({ html, bg, height, width, pad, bgColor, textColor, linkColor, role, aiMarkup }) {
  const { rawHandler, createBlock, serialize, parse, getBlockType } = wp.blocks;

  // rawHandler keeps nested wrappers as raw HTML, so flatten to a run of real blocks first.
  const BLOCK = /^(H[1-6]|P|UL|OL|TABLE|BLOCKQUOTE|PRE|FIGURE|HR|IMG)$/;
  const INLINE = /^(A|SPAN|STRONG|EM|B|I|SMALL|BR|SUP|SUB|CODE|MARK|U|S|TIME|ABBR|LABEL)$/;
  const HAS_BLOCK = 'h1,h2,h3,h4,h5,h6,p,div,ul,ol,table,section,article,figure,blockquote';
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const parts = [];
  let run = [];
  const flush = () => {
    const box = document.createElement('p');
    run.forEach((n) => box.append(n.cloneNode(true)));
    if (box.textContent.trim() || box.querySelector('img')) parts.push(box.outerHTML);
    run = [];
  };
  const visit = (node) => {
    for (const n of [...node.childNodes]) {
      if (n.nodeType === 3) { if (n.textContent.trim()) run.push(n); continue; }
      if (n.nodeType !== 1) continue;
      if (BLOCK.test(n.tagName)) {
        flush();
        n.querySelectorAll('div,section,article,header,footer,nav,aside').forEach((d) => d.replaceWith(...d.childNodes));
        parts.push(n.outerHTML);
      } else if (INLINE.test(n.tagName) && !n.querySelector(HAS_BLOCK)) {
        run.push(n);
      } else {
        flush();
        visit(n);
        flush();
      }
    }
  };
  visit(doc.body);
  flush();

  let inner = parts.length ? rawHandler({ HTML: parts.join('\n') }) : [];
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
  if (!aiMarkup && (role === 'header' || role === 'footer')) inner = rows(inner);
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

  // Header/footer: link-only lists become horizontal navigation; the header sits on one row,
  // and in the footer a menu shares a row with the short text next to it (copyright).
  function rows(list) {
    const navs = list.map((b) => {
      if (b.name !== 'core/list') return b;
      const links = b.innerBlocks.map((li) => !li.innerBlocks.length && String(li.attributes.content).trim().match(/^<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>$/));
      if (!links.length || !links.every(Boolean)) return b;
      return createBlock('core/navigation', { layout: { type: 'flex', flexWrap: 'wrap' }, overlayMenu: 'mobile' },
        links.map(([a, url, label]) => createBlock('core/navigation-link', { label: label.replace(/<[^>]+>/g, '').trim(), url, kind: 'custom', ...(/target="_blank"/.test(a) ? { opensInNewTab: true } : {}) })));
    });
    const row = (items) => createBlock('core/group', { layout: { type: 'flex', justifyContent: 'space-between', flexWrap: 'wrap' } }, items);
    if (role === 'header') return [row(navs)];
    const out = [];
    navs.forEach((b) => {
      const prev = out[out.length - 1];
      const short = b.name === 'core/paragraph' && String(b.attributes.content).replace(/<[^>]+>/g, '').split(/\s+/).length < 15;
      if (prev?.name === 'core/navigation' && short) out[out.length - 1] = row([prev, b]);
      else out.push(b);
    });
    return out;
  }

  // Section background as hex, skipping transparent ones.
  function solid(c) {
    const [r, g, b, a = 1] = (c || '').match(/[\d.]+/g)?.map(Number) || [];
    if (r === undefined || a < 0.5) return null;
    return '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
  }
}
