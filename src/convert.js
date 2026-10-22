// HTML -> blocks using WordPress's own converter, running in the dev-env block editor.
import fs from 'node:fs';
import path from 'node:path';
import { launch } from './browser.js';
import { devenv } from './devenv.js';
import { read, write, exists } from './guard.js';

export async function convert(ctx, dir) {
  const exDir = path.join(ctx.dir, 'extract');
  const sections = read(path.join(exDir, 'sections.json'));
  const prev = exists(path.join(dir, 'done.json')) ? read(path.join(dir, 'done.json')) : null;
  const only = ctx.section && prev ? String(ctx.section).padStart(2, '0') : null;

  const env = devenv(ctx.site);
  const siteUrl = env.ensureSite('c2t-converter', 'clone2theme converter');
  const key = env.loginKey();
  if (!key) throw new Error('no dev-env autologin key (vip dev-env info)');

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
      const out = await page.evaluate(toBlocks, { html, bg: s.bg, role: s.role });
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
        ai: ctx.noAi ? 'skipped (--no-ai)' : 'not built yet',
      });
    }
  } finally {
    await browser.close();
  }
  return { converter: siteUrl, sections: results, unclear: results.filter((r) => r.unclear).map((r) => r.id) };
}

// Runs in the block editor page.
function toBlocks({ html, bg, role }) {
  const { rawHandler, createBlock, serialize } = wp.blocks;

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
  // Keep images at the size they rendered on the original page.
  const widths = Object.fromEntries([...doc.querySelectorAll('img[width]')].map((i) => [i.getAttribute('src'), Number(i.getAttribute('width'))]));
  const size = (list) => list.forEach((b) => {
    const w = b.name === 'core/image' && widths[b.attributes.url];
    if (w && w < 1000) b.attributes.width = `${w}px`;
    size(b.innerBlocks || []);
  });
  size(inner);
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
    ? createBlock('core/cover', { url: bg, dimRatio: 40, align: 'full', minHeight: 420, minHeightUnit: 'px', layout: { type: 'constrained' } }, inner)
    : createBlock('core/group', {
        tagName: role === 'header' ? 'header' : role === 'footer' ? 'footer' : 'section',
        align: 'full',
        layout: { type: 'constrained' },
        style: { spacing: { padding: { top: 'var:preset|spacing|50', bottom: 'var:preset|spacing|50' } } },
      }, inner);
  return { markup: serialize([block]), total, unclear, counts };
}
