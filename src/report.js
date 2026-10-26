// report.json (small, for Claude) + report.html (side-by-side visual check, for humans).
import path from 'node:path';
import { STEPS, exists, read, write } from './guard.js';
import { CLOSE } from './verify.js';

export function report(ctx) {
  const get = (name) => (exists(path.join(ctx.dir, name, 'done.json')) ? read(path.join(ctx.dir, name, 'done.json')) : null);
  const s = Object.fromEntries(STEPS.map((n) => [n, get(n)]));
  const sections = exists(path.join(ctx.dir, 'extract', 'sections.json')) ? read(path.join(ctx.dir, 'extract', 'sections.json')) : [];
  const conv = Object.fromEntries((s.convert?.sections || []).map((c) => [c.id, c]));

  const needsHuman = [];
  for (const c of s.convert?.sections || []) {
    if (c.unclear) needsHuman.push({ section: c.id, why: `mostly raw HTML blocks (${Math.round(c.unclearShare * 100)}%)`, fix: `c2t step convert --run ${ctx.run} --section ${Number(c.id)}` });
  }
  for (const c of s.convert?.sections || []) {
    if (c.ai?.startsWith('failed')) needsHuman.push({ section: c.id, why: `AI ${c.ai}`, fix: `c2t step convert --run ${ctx.run} --section ${Number(c.id)}` });
  }
  const noKey = (s.convert?.sections || []).filter((c) => c.ai?.includes('no Anthropic credentials'));
  const badKey = (s.convert?.sections || []).filter((c) => c.ai?.includes('rejected the API key'));
  if (badKey.length) needsHuman.push({ why: 'Anthropic rejected the API key (401): check ANTHROPIC_API_KEY in .env', fix: `c2t step convert --run ${ctx.run}` });
  if (noKey.length) needsHuman.push({ why: `AI pass skipped for ${noKey.length} weak sections: no Anthropic credentials`, fix: `export ANTHROPIC_API_KEY=... && c2t step convert --run ${ctx.run}` });
  const forms = sections.filter((x) => x.forms);
  if (forms.length) needsHuman.push({ why: `${forms.reduce((a, x) => a + x.forms, 0)} forms kept as text only (fields need a form plugin): sections ${forms.map((x) => x.id).join(', ')}` });
  if (s.push?.mediaMissing) needsHuman.push({ why: `${s.push.mediaMissing} images did not import` });
  if (s.verify?.brokenImages?.length) needsHuman.push({ why: `${s.verify.brokenImages.length} broken images on the local page` });
  const scores = Object.fromEntries((s.verify?.sections || []).map((v) => [v.id, v]));
  const failing = (s.verify?.sections || []).filter((v) => v.status === 'fail');
  if (failing.length) needsHuman.push({ why: `${failing.length} of ${s.verify.sections.length} sections look different (below ${Math.round(CLOSE * 100)}% match): ${failing.map((v) => v.id).join(', ')}` });
  if (s.verify?.mobile?.overflow) needsHuman.push({ why: `the clone scrolls sideways on a phone (${s.verify.mobile.width}px wide at 390px): ${s.verify.mobile.wide.join(', ')}` });
  if (s.verify?.editability?.invalid) needsHuman.push({ why: `${s.verify.editability.invalid} blocks show "unexpected content" in the editor` });
  if (s.verify && s.verify.status !== 200) needsHuman.push({ why: `local page returned HTTP ${s.verify.status}` });

  const data = {
    run: ctx.run,
    url: ctx.url,
    steps: Object.fromEntries(STEPS.map((n) => [n, s[n] ? 'done' : 'pending'])),
    local: s.push?.siteUrl || null,
    theme: s.push?.themePath || s.build?.themeDir || null,
    sections: sections.map((x) => ({ id: x.id, role: x.role, heading: x.heading, blocks: conv[x.id]?.blocks ?? null, unclear: conv[x.id]?.unclear ?? null, score: scores[x.id]?.score ?? null, match: scores[x.id]?.status ?? null,
      elements: scores[x.id]?.dom ?? null, pixels: scores[x.id]?.pixelScore ?? null, gaps: scores[x.id]?.gaps || null, worst: scores[x.id]?.worst || [] })),
    scores: s.verify ? { page: s.verify.pageScore, avg: s.verify.avgScore, passing: s.verify.passing, of: s.verify.sections.length } : null,
    gaps: gapTotals(s.verify?.sections || []),
    editability: s.verify?.editability || null,
    mobile: s.verify?.mobile ? { overflow: s.verify.mobile.overflow, width: s.verify.mobile.width, height: s.verify.mobile.height } : null,
    ai: s.convert?.ai ? { used: s.convert.ai.used, calls: s.convert.ai.calls, cached: s.convert.ai.cached, tokens: s.convert.ai.spent, cap: s.convert.ai.cap } : null,
    needsHuman,
  };
  write(path.join(ctx.dir, 'report.json'), data);
  write(path.join(ctx.dir, 'report.html'), html(data, s, sections, conv, scores));
  return data;
}

// Where the element points go across the page: each section's gap shares averaged, largest first.
function gapTotals(list) {
  const withGaps = list.filter((v) => v.gaps);
  const sum = {};
  for (const v of withGaps) for (const [k, n] of Object.entries(v.gaps)) sum[k] = (sum[k] || 0) + n / withGaps.length;
  return Object.fromEntries(Object.entries(sum).sort((a, b) => b[1] - a[1]).map(([k, n]) => [k, Math.round(n * 1000) / 1000]));
}

const e = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const GAP_COLORS = { missing: '#b3261e', position: '#c77700', size: '#8a6d00', 'font-size': '#2b6cb0', weight: '#5a4fcf', font: '#7a3e9d', color: '#1f7a4d', case: '#6b6b66' };
// One bar: how the points a section lost split between gap kinds.
function gapBar(gaps) {
  const total = Object.values(gaps).reduce((a, n) => a + n, 0);
  if (!total) return '';
  const parts = Object.entries(gaps).sort((a, b) => b[1] - a[1]);
  return `<div class="gapbar" title="where the element points went">${parts.map(([k, n]) => `<i style="flex:${n};background:${GAP_COLORS[k] || '#999'}"></i>`).join('')}</div>
    <p class="meta">${parts.map(([k, n]) => `<span class="key" style="--c:${GAP_COLORS[k] || '#999'}">${e(k)} ${Math.round(n * 100)}</span>`).join(' ')}</p>`;
}

function html(d, s, sections, conv, scores) {
  const pct = (n) => (n == null ? '–' : `${Math.round(n * 100)}%`);
  const palette = s.extract?.tokens?.palette || [];
  const fonts = s.extract?.tokens?.fonts || [];
  const steps = Object.entries(d.steps).map(([k, v]) => `<li class="${v}">${k}</li>`).join('');
  const issues = d.needsHuman.length
    ? `<ul class="issues">${d.needsHuman.map((n) => `<li><b>${n.section ? `section ${e(n.section)}: ` : ''}${e(n.why)}</b>${n.fix ? ` <code>${e(n.fix)}</code>` : ''}</li>`).join('')}</ul>`
    : '<p class="ok">nothing needs a human right now.</p>';
  const cards = sections.map((x) => {
    const c = conv[x.id];
    const v = scores[x.id];
    const badge = !c ? '<span class="badge wait">not converted</span>' : c.unclear ? '<span class="badge bad">needs review</span>' : '<span class="badge good">converted</span>';
    const counts = c ? Object.entries(c.counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${e(k.replace('core/', ''))} ${v}`).join(' · ') : '';
    return `<article class="card"><header><h3>${e(x.id)} · ${e(x.role)}${x.heading ? ` · ${e(x.heading)}` : ''}</h3>${badge}</header>
      ${v ? `<p class="score ${v.status}"><b>${pct(v.score)}</b> match · ${e(v.status)}${v.dom != null ? ` · elements ${pct(v.dom)} (${e(v.matched)} found) · pixels ${pct(v.pixelScore)}` : ''}${v.heightRatio ? ` · height ×${v.heightRatio}` : ''}</p>` : ''}
      ${v?.gaps ? gapBar(v.gaps) : ''}
      ${v?.worst?.length ? `<ul class="worst">${v.worst.map((w) => `<li>${e(w)}</li>`).join('')}</ul>` : ''}
      <div class="trio"><figure><figcaption>original</figcaption><img loading="lazy" src="capture/sections/${e(x.id)}.png" alt="original section ${e(x.id)}"></figure>
      ${v && v.score != null ? `<figure><figcaption>local</figcaption><img loading="lazy" src="verify/sections/${e(x.id)}.png" alt="local section ${e(x.id)}"></figure><figure><figcaption>diff</figcaption><img loading="lazy" src="verify/diff/${e(x.id)}.png" alt="pixel diff ${e(x.id)}"></figure>` : ''}</div>
      <p class="meta">${x.words} words · ${x.images} images · ${x.links} links${c ? ` · ${c.blocks} blocks` : ''}</p>
      ${counts ? `<p class="meta">${counts}</p>` : ''}
      ${c?.ai ? `<p class="meta">ai: ${e(c.ai)}</p>` : ''}
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
.compare.phone{max-width:820px}.compare img,.card img{width:100%;height:auto;display:block;border-radius:6px}figcaption{font-size:13px;color:var(--mute);margin-bottom:8px}
.trio{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;align-items:start}.trio figure{margin:0;max-height:420px;overflow:hidden}.trio figcaption{font-size:11px;margin-bottom:4px}
.gapbar{display:flex;height:10px;border-radius:5px;overflow:hidden;margin:6px 0;background:var(--line)}.gapbar i{display:block}
.key::before{content:"";display:inline-block;width:9px;height:9px;border-radius:2px;background:var(--c);margin-right:4px}
.worst{margin:6px 0;padding-left:18px;font-size:12px;color:var(--mute)}.worst li{margin:2px 0}
.score{margin:0 0 8px;font-size:13px}.score.pass{color:var(--good)}.score.close{color:var(--wait)}.score.fail{color:var(--bad)}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(420px,1fr));gap:16px}.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px}
.card header{display:flex;justify-content:space-between;gap:8px;align-items:start;margin-bottom:8px}.card h3{font-size:14px;margin:0}
.badge{font-size:12px;padding:2px 8px;border-radius:99px;white-space:nowrap;border:1px solid currentColor}.good{color:var(--good)}.bad{color:var(--bad)}.wait{color:var(--wait)}
@media (max-width:760px){.compare{grid-template-columns:1fr}}
</style></head><body><main>
<h1>${e(d.run)}</h1><p class="meta"><a href="${e(d.url)}">${e(d.url)}</a>${d.local ? ` → <a href="${e(d.local)}">${e(d.local)}</a>` : ''}</p>
<ul class="steps">${steps}</ul>
<h2>needs a human</h2>${issues}
<h2>design tokens</h2><div class="swatches">${palette.map((p) => `<span class="sw"><i style="background:${e(p.color)}"></i>${e(p.slug)} ${e(p.color)}</span>`).join('')}</div>
<p class="meta">fonts: ${fonts.map((f) => `${e(f.slug)} = ${e(f.name)}`).join(' · ')} · content width ${e(s.extract?.tokens?.contentSize)}</p>
${d.ai ? `<p class="meta">ai: ${d.ai.used.length ? `Haiku rebuilt ${d.ai.used.join(', ')}` : 'no sections rebuilt'} · ${d.ai.calls} calls, ${d.ai.cached} cached · ${d.ai.tokens.toLocaleString()} of ${d.ai.cap.toLocaleString()} tokens</p>` : ''}
${d.scores ? `<h2>match scores</h2><p class="meta">whole page ${pct(d.scores.page)} · section average ${pct(d.scores.avg)} · ${d.scores.passing} of ${d.scores.of} sections pass (≥85%). a section score is 60% elements (every text block and image found, in place, in the right style) and 40% pixels (backgrounds, borders, icons).</p>` : ''}
${d.editability && !d.editability.error ? `<h2>editable in WordPress</h2><p class="meta">${d.editability.blocks} blocks · <b class="${d.editability.invalid ? 'bad' : 'good'}">${d.editability.invalid} invalid</b> · <b class="${d.editability.rawHtml ? 'bad' : 'good'}">${d.editability.rawHtml} raw HTML</b> · ${d.editability.linkedImages} of ${d.editability.images} images in the media library · ${d.editability.presetValues} styles from theme presets, ${d.editability.customValues} one-off values. (page content; header and footer are template parts)</p>` : ''}
${d.gaps && Object.keys(d.gaps).length ? `<h2>where the points go</h2>${gapBar(d.gaps)}<p class="meta">points lost per gap kind, averaged over sections. missing = not found in the clone; position = offset from where it sits next to its neighbor; size = box or image size; the rest are text styles.</p>` : ''}
${d.mobile ? `<h2>on a phone (390px)</h2><p class="meta">${d.mobile.overflow ? `<b class="bad">scrolls sideways (${d.mobile.width}px)</b>` : '<b class="good">no sideways scroll</b>'} · WordPress stacks columns on phones; the original may use its own mobile layout.</p><div class="compare phone"><figure><figcaption>original</figcaption><img loading="lazy" src="capture/mobile.png" alt="original on a phone"></figure><figure><figcaption>local clone</figcaption><img loading="lazy" src="verify/mobile.png" alt="clone on a phone"></figure></div>` : ''}
<h2>original vs local</h2><div class="compare"><figure><figcaption>original</figcaption>${s.capture ? '<img loading="lazy" src="capture/full.png" alt="original page">' : ''}</figure><figure><figcaption>local clone</figcaption>${local}</figure></div>
<h2>sections</h2><div class="cards">${cards}</div>
</main></body></html>`;
}
