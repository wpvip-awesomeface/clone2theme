// report.json (small, for Claude) + report.html (side-by-side visual check, for humans).
import path from 'node:path';
import { STEPS, exists, read, write } from './guard.js';

export function report(ctx) {
  const get = (name) => (exists(path.join(ctx.dir, name, 'done.json')) ? read(path.join(ctx.dir, name, 'done.json')) : null);
  const s = Object.fromEntries(STEPS.map((n) => [n, get(n)]));
  const sections = exists(path.join(ctx.dir, 'extract', 'sections.json')) ? read(path.join(ctx.dir, 'extract', 'sections.json')) : [];
  const conv = Object.fromEntries((s.convert?.sections || []).map((c) => [c.id, c]));

  const needsHuman = [];
  for (const c of s.convert?.sections || []) {
    if (c.unclear) needsHuman.push({ section: c.id, why: `mostly raw HTML blocks (${Math.round(c.unclearShare * 100)}%)`, fix: `c2t step convert --run ${ctx.run} --section ${Number(c.id)}` });
  }
  if (s.push?.mediaMissing) needsHuman.push({ why: `${s.push.mediaMissing} images did not import` });
  if (s.verify?.brokenImages?.length) needsHuman.push({ why: `${s.verify.brokenImages.length} broken images on the local page` });
  if (s.verify && s.verify.status !== 200) needsHuman.push({ why: `local page returned HTTP ${s.verify.status}` });

  const data = {
    run: ctx.run,
    url: ctx.url,
    steps: Object.fromEntries(STEPS.map((n) => [n, s[n] ? 'done' : 'pending'])),
    local: s.push?.siteUrl || null,
    theme: s.push?.themePath || s.build?.themeDir || null,
    sections: sections.map((x) => ({ id: x.id, role: x.role, heading: x.heading, blocks: conv[x.id]?.blocks ?? null, unclear: conv[x.id]?.unclear ?? null })),
    needsHuman,
  };
  write(path.join(ctx.dir, 'report.json'), data);
  write(path.join(ctx.dir, 'report.html'), html(data, s, sections, conv));
  return data;
}

const e = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function html(d, s, sections, conv) {
  const palette = s.extract?.tokens?.palette || [];
  const fonts = s.extract?.tokens?.fonts || [];
  const steps = Object.entries(d.steps).map(([k, v]) => `<li class="${v}">${k}</li>`).join('');
  const issues = d.needsHuman.length
    ? `<ul class="issues">${d.needsHuman.map((n) => `<li><b>${n.section ? `section ${e(n.section)}: ` : ''}${e(n.why)}</b>${n.fix ? ` <code>${e(n.fix)}</code>` : ''}</li>`).join('')}</ul>`
    : '<p class="ok">nothing needs a human right now.</p>';
  const cards = sections.map((x) => {
    const c = conv[x.id];
    const badge = !c ? '<span class="badge wait">not converted</span>' : c.unclear ? '<span class="badge bad">needs review</span>' : '<span class="badge good">converted</span>';
    const counts = c ? Object.entries(c.counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${e(k.replace('core/', ''))} ${v}`).join(' · ') : '';
    return `<article class="card"><header><h3>${e(x.id)} · ${e(x.role)}${x.heading ? ` · ${e(x.heading)}` : ''}</h3>${badge}</header>
      <img loading="lazy" src="capture/sections/${e(x.id)}.png" alt="original section ${e(x.id)}">
      <p class="meta">${x.words} words · ${x.images} images · ${x.links} links${c ? ` · ${c.blocks} blocks` : ''}</p>
      ${counts ? `<p class="meta">${counts}</p>` : ''}
      <p class="meta"><a href="extract/sections/${e(x.id)}.html">cleaned html</a>${c ? ` · <a href="convert/blocks/${e(x.id)}.html">block markup</a>` : ''}</p></article>`;
  }).join('');
  const local = s.verify ? '<img loading="lazy" src="verify/full.png" alt="local clone">' : '<p class="meta">run push + verify to see the local clone.</p>';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>c2t: ${e(d.run)}</title><style>
:root{--bg:#f6f6f4;--card:#fff;--ink:#1d1d1b;--mute:#6b6b66;--line:#e3e3de;--good:#1f7a4d;--bad:#b3261e;--wait:#8a6d00}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--card:#1e1e1c;--ink:#ecebe6;--mute:#9b9a94;--line:#2e2e2b;--good:#5fc28f;--bad:#f2867c;--wait:#e0c060}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,sans-serif}
main{max-width:1400px;margin:0 auto;padding:24px 16px 64px}h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:32px 0 12px}
a{color:inherit}.meta{color:var(--mute);font-size:13px;margin:6px 0}code{font-size:12px;background:var(--line);padding:2px 6px;border-radius:4px}
.steps{display:flex;flex-wrap:wrap;gap:6px;list-style:none;padding:0;margin:12px 0}.steps li{padding:3px 10px;border-radius:99px;font-size:13px;border:1px solid var(--line)}
.steps .done{background:var(--good);color:var(--card);border-color:transparent}
.issues{padding-left:18px}.issues li{margin:6px 0}.ok{color:var(--good)}
.swatches{display:flex;flex-wrap:wrap;gap:10px}.sw{display:flex;align-items:center;gap:8px;font-size:13px}.sw i{width:28px;height:28px;border-radius:6px;border:1px solid var(--line);display:inline-block}
.compare{display:grid;grid-template-columns:1fr 1fr;gap:16px}.compare figure{margin:0;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px;max-height:900px;overflow:auto}
.compare img,.card img{width:100%;height:auto;display:block;border-radius:6px}figcaption{font-size:13px;color:var(--mute);margin-bottom:8px}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:16px}.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px}
.card header{display:flex;justify-content:space-between;gap:8px;align-items:start;margin-bottom:8px}.card h3{font-size:14px;margin:0}
.badge{font-size:12px;padding:2px 8px;border-radius:99px;white-space:nowrap;border:1px solid currentColor}.good{color:var(--good)}.bad{color:var(--bad)}.wait{color:var(--wait)}
@media (max-width:760px){.compare{grid-template-columns:1fr}}
</style></head><body><main>
<h1>${e(d.run)}</h1><p class="meta"><a href="${e(d.url)}">${e(d.url)}</a>${d.local ? ` → <a href="${e(d.local)}">${e(d.local)}</a>` : ''}</p>
<ul class="steps">${steps}</ul>
<h2>needs a human</h2>${issues}
<h2>design tokens</h2><div class="swatches">${palette.map((p) => `<span class="sw"><i style="background:${e(p.color)}"></i>${e(p.slug)} ${e(p.color)}</span>`).join('')}</div>
<p class="meta">fonts: ${fonts.map((f) => `${e(f.slug)} = ${e(f.name)}`).join(' · ')} · content width ${e(s.extract?.tokens?.contentSize)}</p>
<h2>original vs local</h2><div class="compare"><figure><figcaption>original</figcaption>${s.capture ? '<img loading="lazy" src="capture/full.png" alt="original page">' : ''}</figure><figure><figcaption>local clone</figcaption>${local}</figure></div>
<h2>sections</h2><div class="cards">${cards}</div>
</main></body></html>`;
}
