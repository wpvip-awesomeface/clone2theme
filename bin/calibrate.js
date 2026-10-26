#!/usr/bin/env node
// Fit the grade to human labels: which mix of element and pixel scores, and which thresholds,
// best agree with "looks right" / "close enough" / "wrong" verdicts on the same renders.
// usage: node bin/calibrate.js <snapshot.json> <labels dir (one JSON per section, from the review page)>
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../src/guard.js';

const [snapFile, labelDir] = process.argv.slice(2);
if (!snapFile || !labelDir) { console.error('usage: calibrate.js <snapshot.json> <labels dir>'); process.exit(1); }
const snap = Object.fromEntries(JSON.parse(fs.readFileSync(snapFile, 'utf8')).map((x) => [x.key, x]));
const labels = fs.readdirSync(labelDir, { recursive: true }).filter((f) => f.endsWith('.json')).map((f) => {
  const d = JSON.parse(fs.readFileSync(path.join(labelDir, f), 'utf8'));
  return { key: path.basename(f, '.json'), ...(d.data || d) };
}).filter((l) => snap[l.key] && l.verdict);
if (labels.length < 10) { console.error(`only ${labels.length} labeled sections; label at least 10`); process.exit(1); }

const rows = labels.map((l) => ({ ...snap[l.key], verdict: l.verdict }));
// Score for a mix: elements (when the section has any) and pixels, times readability as verify does.
const scoreOf = (r, w) => ((r.dom != null ? w * r.dom + (1 - w) * r.pixels : r.pixels) * (r.readable ?? 1));
// Balanced accuracy of a threshold split: positives at or above it.
const balanced = (pos, neg, t, w) => {
  const tp = pos.filter((r) => scoreOf(r, w) >= t).length / (pos.length || 1);
  const tn = neg.filter((r) => scoreOf(r, w) < t).length / (neg.length || 1);
  return (tp + tn) / 2;
};
let best = null;
for (let w = 0; w <= 1.0001; w += 0.05) {
  const acceptable = rows.filter((r) => r.verdict !== 'bad'), bad = rows.filter((r) => r.verdict === 'bad');
  const good = rows.filter((r) => r.verdict === 'good'), notGood = rows.filter((r) => r.verdict !== 'good');
  for (let a = 0.3; a <= 0.95; a += 0.01) {
    const accA = balanced(acceptable, bad, a, w);
    for (let p = a; p <= 0.99; p += 0.01) {
      const accP = balanced(good, notGood, p, w);
      const fit = accA * 0.6 + accP * 0.4;
      if (!best || fit > best.fit) best = { fit, domWeight: Math.round(w * 100) / 100, acceptable: Math.round(a * 100) / 100, pass: Math.round(p * 100) / 100, accAcceptable: accA, accPass: accP };
    }
  }
}
const out = { ...best, labeled: rows.length, counts: { good: rows.filter((r) => r.verdict === 'good').length, ok: rows.filter((r) => r.verdict === 'ok').length, bad: rows.filter((r) => r.verdict === 'bad').length }, at: new Date().toISOString() };
// Where the fitted grade still disagrees with a human, for a look.
out.disagree = rows.map((r) => {
  const s = scoreOf(r, best.domWeight);
  const g = s >= best.pass ? 'good' : s >= best.acceptable ? 'ok' : 'bad';
  return g === r.verdict ? null : `${r.key}: human ${r.verdict}, grade ${g} (${Math.round(s * 100)}%)`;
}).filter(Boolean);
fs.mkdirSync(path.join(ROOT, 'calibration'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'calibration', 'weights.json'), JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
