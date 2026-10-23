#!/usr/bin/env node
// clone2theme: live page -> WordPress block theme on a local VIP dev-env.
import path from 'node:path';
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { STEPS, ROOT, step, runDir, slugify, exists, read, write, log } from '../src/guard.js';
import { capture } from '../src/capture.js';
import { extract } from '../src/extract.js';
import { convert } from '../src/convert.js';
import { build } from '../src/build.js';
import { push } from '../src/push.js';
import { verify } from '../src/verify.js';
import { report } from '../src/report.js';
import { CLOSE } from '../src/verify.js';
import { guardAi } from '../src/convert.js';

// Local secrets (ANTHROPIC_API_KEY) live in .env next to package.json; never committed.
if (exists(path.join(ROOT, '.env'))) process.loadEnvFile(path.join(ROOT, '.env'));

const FNS = { capture, extract, convert, build, push, verify };
const HELP = `c2t run <url> [--site vip-local] [--run slug] [--no-ai] [--ai-budget tokens] [--fresh] [--until step]
c2t step <${STEPS.join('|')}> --run <slug> [--section n] [--only]
c2t open <slug>
c2t list

steps cache in runs/<slug>/<step>/done.json. "step X" reruns X and everything after it
(--only: just X). Without --no-ai, sections that convert to raw HTML or score below
65% after verify go to Haiku once (cached by section hash, capped by --ai-budget). report.json is the small summary to read; report.html is the visual check.`;

const { values: o, positionals: [cmd, arg] } = parseArgs({
  allowPositionals: true,
  options: {
    site: { type: 'string' }, 'ai-budget': { type: 'string' }, run: { type: 'string' }, section: { type: 'string' }, until: { type: 'string' },
    'no-ai': { type: 'boolean' }, fresh: { type: 'boolean' }, only: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  },
});

async function pipeline(ctx, to = STEPS.length - 1) {
  await runSteps(ctx, to);
  // One AI pass: re-convert weak sections now that verify has scored them.
  const v = exists(path.join(ctx.dir, 'verify', 'done.json')) ? read(path.join(ctx.dir, 'verify', 'done.json')) : null;
  const conv = exists(path.join(ctx.dir, 'convert', 'done.json')) ? read(path.join(ctx.dir, 'convert', 'done.json')) : null;
  const weak = (v?.sections || []).filter((x) => x.score !== null && x.score < CLOSE && !conv?.ai?.used?.includes(x.id)
    && !conv?.sections.find((c) => c.id === x.id)?.keepPlain);
  if (!process.exitCode && to === STEPS.length - 1 && !ctx.noAi && weak.length && !ctx.aiPass) {
    log('ai', `pass for ${weak.length} weak sections: ${weak.map((x) => x.id).join(', ')}`);
    ctx.aiPass = true;
    ctx.force = new Set(STEPS.slice(STEPS.indexOf('convert')));
    await runSteps(ctx, to);
  }
  // Haiku only stays where it scored higher than the plain conversion.
  const reverted = !process.exitCode && to === STEPS.length - 1 ? guardAi(ctx.dir) : [];
  if (reverted.length) {
    log('ai', `kept plain for ${reverted.join(', ')} (Haiku scored no higher)`);
    ctx.force = new Set(STEPS.slice(STEPS.indexOf('build')));
    await runSteps(ctx, to);
  }
  const r = report(ctx);
  log('report', path.join(ctx.dir, 'report.html'));
  console.log(JSON.stringify({ run: r.run, steps: r.steps, local: r.local, scores: r.scores, ai: r.ai, needsHuman: r.needsHuman.length }, null, 0));
}

async function runSteps(ctx, to) {
  for (const name of STEPS.slice(0, to + 1)) {
    try {
      await step(ctx, name, (dir) => FNS[name](ctx, dir));
    } catch (e) {
      log(name, `FAILED: ${e.message.split('\n')[0]}`);
      write(path.join(ctx.dir, name, 'error.txt'), e.stack || e.message);
      report(ctx);
      process.exitCode = 1;
      break;
    }
  }
}

function loadCtx(run) {
  const file = path.join(runDir(run), 'run.json');
  if (!exists(file)) throw new Error(`no run "${run}" (c2t list)`);
  const meta = read(file);
  return { ...meta, run, dir: runDir(run), force: new Set(), noAi: o['no-ai'] ?? meta.noAi, aiBudget: Number(o['ai-budget']) || meta.aiBudget };
}

try {
  if (!cmd || o.help) {
    console.log(HELP);
  } else if (cmd === 'run') {
    if (!arg) throw new Error('usage: c2t run <url>');
    const url = new URL(arg).href;
    const run = o.run || slugify(url);
    const meta = { url, site: o.site || 'vip-local', noAi: !!o['no-ai'], aiBudget: Number(o['ai-budget']) || undefined };
    write(path.join(runDir(run), 'run.json'), meta);
    const ctx = { ...meta, run, dir: runDir(run), force: new Set(o.fresh ? STEPS : []) };
    await pipeline(ctx, o.until ? STEPS.indexOf(o.until) : undefined);
  } else if (cmd === 'step') {
    const i = STEPS.indexOf(arg);
    if (i < 0 || !o.run) throw new Error(`usage: c2t step <${STEPS.join('|')}> --run <slug>`);
    const ctx = loadCtx(o.run);
    ctx.section = o.section;
    ctx.force = new Set(o.only ? [arg] : STEPS.slice(i));
    await pipeline(ctx, o.only ? i : undefined);
  } else if (cmd === 'open') {
    const file = path.join(runDir(arg || ''), 'report.html');
    if (!exists(file)) throw new Error(`no report at ${file}`);
    execFileSync('open', [file]);
  } else if (cmd === 'list') {
    const fs = await import('node:fs');
    for (const d of fs.readdirSync(path.join(runDir(''))).filter((d) => exists(path.join(runDir(d), 'run.json')))) {
      const r = exists(path.join(runDir(d), 'report.json')) ? read(path.join(runDir(d), 'report.json')) : null;
      console.log(`${d}\t${read(path.join(runDir(d), 'run.json')).url}\t${r?.local || '-'}`);
    }
  } else {
    console.log(HELP);
    process.exitCode = 1;
  }
} catch (e) {
  console.error(`c2t: ${e.message}`);
  process.exitCode = 1;
}
