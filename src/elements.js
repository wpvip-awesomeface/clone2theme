// Element-level comparison: every text block and image in a section, with its box and computed style,
// matched between the original and the clone. Scores say *what* is off (missing, position, size,
// font size, weight, font, color, case), not just how many pixels differ.

// Runs in the page (capture and verify). attr names the section marker attribute.
export function collectElements(attr) {
  const visible = (el) => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.05 && r.width > 1 && r.height > 1;
  };
  const shown = (el) => { for (let n = el; n; n = n.parentElement) { if (n.hasAttribute?.('data-c2t-hidden') || !visible(n)) return false; if (n.hasAttribute?.(attr)) return true; } return true; };
  const SKIP = 'script,style,noscript,template,svg,button.screen-reader-text,.screen-reader-text';
  const out = {};
  document.querySelectorAll(`[${attr}]`).forEach((sec) => {
    const base = sec.getBoundingClientRect();
    const box = (el) => {
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left - base.left), y: Math.round(r.top - base.top), w: Math.round(r.width), h: Math.round(r.height) };
    };
    const blocks = new Map();
    const walker = document.createTreeWalker(sec, NodeFilter.SHOW_TEXT);
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      const text = t.textContent.replace(/\s+/g, ' ').trim();
      const p = t.parentElement;
      if (!text || !p || p.closest(SKIP) || !shown(p)) continue;
      let blk = p;
      while (blk !== sec && blk.parentElement && getComputedStyle(blk).display.startsWith('inline')) blk = blk.parentElement;
      const e = blocks.get(blk) || { kind: 'text', parts: [], styleFrom: p, longest: 0 };
      e.parts.push(text);
      if (text.length > e.longest) { e.longest = text.length; e.styleFrom = p; }
      blocks.set(blk, e);
    }
    const list = [];
    for (const [blk, e] of blocks) {
      const cs = getComputedStyle(e.styleFrom);
      list.push({
        kind: 'text',
        text: e.parts.join(' ').slice(0, 400),
        ...box(blk),
        style: {
          size: parseFloat(cs.fontSize),
          weight: Number(cs.fontWeight) || 400,
          font: cs.fontFamily.split(',')[0].replace(/["']/g, '').trim().toLowerCase(),
          color: cs.color,
          upper: cs.textTransform === 'uppercase',
          align: getComputedStyle(blk).textAlign,
        },
      });
    }
    sec.querySelectorAll('img').forEach((img) => {
      if (!shown(img)) return;
      list.push({ kind: 'img', src: img.getAttribute('data-c2t-src') || img.currentSrc || img.src, ...box(img) });
    });
    list.sort((a, b) => a.y - b.y || a.x - b.x);
    out[sec.getAttribute(attr)] = list;
  });
  return out;
}

const words = (s) => (s.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
const rgb = (c) => (c?.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
const ratio = (a, b) => (a && b ? Math.min(a / b, b / a) : 0);
// Uploaded copies get renamed and resized, so compare images by the media map, then by file stem.
const stem = (u) => (u || '').split('?')[0].split('/').pop().replace(/-\d+x\d+(?=\.)/, '').replace(/-scaled(?=\.)/, '').replace(/\.\w+$/, '');

// Text similarity: Dice on word multisets, plus containment for blocks the clone merged.
function similarity(a, b) {
  const wa = words(a), wb = words(b);
  if (!wa.length || !wb.length) return { dice: 0, contained: 0 };
  const count = new Map();
  wb.forEach((w) => count.set(w, (count.get(w) || 0) + 1));
  let common = 0;
  wa.forEach((w) => { const n = count.get(w); if (n) { common++; count.set(w, n - 1); } });
  return { dice: (2 * common) / (wa.length + wb.length), contained: common / wa.length };
}

export const CATEGORIES = ['missing', 'position', 'size', 'font-size', 'weight', 'font', 'color', 'case'];
const POS_TOLERANCE = 80; // px of combined drift that zeroes the position part

export function compareSection(orig = [], clone = [], media = {}) {
  const pairs = new Array(orig.length).fill(null);
  // Images: media map first, then file stem.
  const localStem = Object.fromEntries(Object.entries(media).map(([o, l]) => [stem(o), stem(l)]));
  const freeImg = clone.map((c, i) => (c.kind === 'img' ? i : -1)).filter((i) => i >= 0);
  orig.forEach((o, i) => {
    if (o.kind !== 'img') return;
    const want = localStem[stem(o.src)] || stem(o.src);
    const k = freeImg.findIndex((j) => stem(clone[j].src) === want);
    if (k >= 0) { pairs[i] = { j: freeImg[k] }; freeImg.splice(k, 1); }
  });
  // Text: best Dice one-to-one, then containment (clone merged blocks) many-to-one.
  const cand = [];
  orig.forEach((o, i) => {
    if (o.kind !== 'text') return;
    clone.forEach((c, j) => { if (c.kind === 'text') { const s = similarity(o.text, c.text); if (s.dice >= 0.6 || s.contained >= 0.85) cand.push({ i, j, ...s }); } });
  });
  const used = new Set();
  cand.sort((a, b) => b.dice - a.dice);
  for (const c of cand) if (!pairs[c.i] && !used.has(c.j) && c.dice >= 0.6) { pairs[c.i] = { j: c.j }; used.add(c.j); }
  for (const c of cand.sort((a, b) => b.contained - a.contained)) if (!pairs[c.i] && c.contained >= 0.85) pairs[c.i] = { j: c.j, merged: true };

  // Score in reading order; vertical position is relative to the previous matched element so one
  // early offset doesn't fail everything below it.
  let prev = null;
  const elements = orig.map((o, i) => {
    const weight = Math.sqrt(Math.max(1, o.w * o.h));
    const label = o.kind === 'img' ? `image ${stem(o.src)}` : `"${o.text.slice(0, 48)}${o.text.length > 48 ? '…' : ''}"`;
    if (!pairs[i]) return { label, kind: o.kind, weight, score: 0, loss: { missing: 1 }, issues: ['missing'] };
    const c = clone[pairs[i].j];
    const dx = c.x - o.x;
    const dy = prev ? (c.y - prev.c.y) - (o.y - prev.o.y) : c.y - o.y;
    prev = { o, c };
    const pos = Math.max(0, 1 - (Math.abs(dx) + Math.abs(dy)) / POS_TOLERANCE);
    const size = o.kind === 'img' ? (ratio(c.w, o.w) + ratio(c.h, o.h)) / 2 : pairs[i].merged ? 0.5 : (ratio(c.w, o.w) + ratio(c.h, o.h)) / 2;
    const issues = [];
    if (pos < 0.75) issues.push(`${Math.abs(dy) >= Math.abs(dx) ? `${Math.abs(dy)}px ${dy > 0 ? 'lower' : 'higher'}` : `${Math.abs(dx)}px ${dx > 0 ? 'right' : 'left'}`}`);
    if (size < 0.75) issues.push(`${o.kind === 'img' ? 'image' : 'box'} ${c.w}×${c.h}, want ${o.w}×${o.h}${pairs[i].merged ? ' (merged with other text)' : ''}`);
    if (o.kind === 'img') {
      const parts = { position: pos, size };
      return { label, kind: o.kind, weight, score: 0.5 * pos + 0.5 * size, loss: { position: 0.5 * (1 - pos), size: 0.5 * (1 - size) }, issues, parts };
    }
    const so = o.style, sc = c.style;
    const st = {
      'font-size': ratio(sc.size, so.size) ** 2,
      weight: Math.abs(sc.weight - so.weight) >= 200 ? 0 : 1,
      font: sc.font === so.font ? 1 : 0,
      color: rgb(sc.color).reduce((a, v, k) => a + Math.abs(v - (rgb(so.color)[k] ?? v)), 0) > 60 ? 0 : 1,
      case: sc.upper === so.upper ? 1 : 0,
    };
    if (st['font-size'] < 0.8) issues.push(`font ${sc.size}px, want ${so.size}px`);
    if (!st.weight) issues.push(`weight ${sc.weight}, want ${so.weight}`);
    if (!st.font) issues.push(`font "${sc.font}", want "${so.font}"`);
    if (!st.color) issues.push(`color ${sc.color}, want ${so.color}`);
    if (!st.case) issues.push(so.upper ? 'should be uppercase' : 'should not be uppercase');
    // Style weights: size counts double, the rest once (sum 6).
    const W = { 'font-size': 2, weight: 1, font: 1, color: 1, case: 1 };
    const style = Object.entries(st).reduce((a, [k, v]) => a + W[k] * v, 0) / 6;
    const loss = { position: 0.35 * (1 - pos), size: 0.25 * (1 - size) };
    for (const [k, v] of Object.entries(st)) loss[k] = 0.4 * (W[k] / 6) * (1 - v);
    return { label, kind: o.kind, weight, score: 0.35 * pos + 0.25 * size + 0.4 * style, loss, issues };
  });

  const total = elements.reduce((a, e) => a + e.weight, 0) || 1;
  const score = elements.length ? elements.reduce((a, e) => a + e.weight * e.score, 0) / total : null;
  // Where the missing points went, as shares of the section's total weight.
  const gaps = Object.fromEntries(CATEGORIES.map((k) => [k, round(elements.reduce((a, e) => a + e.weight * (e.loss[k] || 0), 0) / total)]).filter(([, v]) => v >= 0.005));
  const worst = elements.filter((e) => e.issues.length).sort((a, b) => b.weight * (1 - b.score) - a.weight * (1 - a.score)).slice(0, 6)
    .map((e) => `${e.label}: ${e.issues.join(', ')}`);
  return { score: score == null ? null : round(score), matched: pairs.filter(Boolean).length, of: orig.length, gaps, worst, elements };
}

const round = (n) => Math.round(n * 1000) / 1000;
