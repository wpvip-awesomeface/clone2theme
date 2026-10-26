#!/usr/bin/env node
// clone2theme: live page -> WordPress block theme on a local VIP dev-env.
import path from 'node:path';
import { parseArgs } from 'node:util';
import os from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { STEPS, ROOT, step, runDir, slugify, exists, read, write, log } from '../src/guard.js';
import { setup, missing } from '../src/setup.js';

// The pipeline needs installed dependencies (Playwright etc.); load it only after setup has checked them.
let FNS, report, CLOSE, guardAi, fitPass, keepBetter, tidyPass;
async function loadPipeline() {
  const [cap, ext, conv, bld, psh, ver, rep, fit, tidy] = await Promise.all(['capture', 'extract', 'convert', 'build', 'push', 'verify', 'report', 'fit', 'tidy'].map((m) => import(`../src/${m}.js`)));
  FNS = { capture: cap.capture, extract: ext.extract, convert: conv.convert, build: bld.build, push: psh.push, verify: ver.verify };
  ({ report } = rep); ({ CLOSE } = ver); ({ guardAi } = conv); ({ fitPass, keepBetter } = fit); ({ tidyPass } = tidy);
}

// Local secrets (ANTHROPIC_API_KEY) live in .env next to package.json; never committed.
if (exists(path.join(ROOT, '.env'))) process.loadEnvFile(path.join(ROOT, '.env'));

const HELP = `clone2theme <url> [--ai] [--no-open] [--fresh]   clone a page: zero AI by default, opens the report and the clone when done
clone2theme setup [--yes]                         check and install everything it needs (runs by itself on first use)

c2t run <url> [--site vip-local] [--run slug] [--no-ai] [--ai-budget tokens] [--fresh] [--until step]
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
    'no-ai': { type: 'boolean' }, ai: { type: 'boolean' }, 'no-open': { type: 'boolean' }, yes: { type: 'boolean', short: 'y' }, 'keep-ai': { type: 'boolean' }, 'no-fit': { type: 'boolean' }, 'no-tidy': { type: 'boolean' }, fresh: { type: 'boolean' }, only: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  },
});

const FIT_ROUNDS = 2;

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
  const reverted = !process.exitCode && to === STEPS.length - 1 && !ctx.keepAi ? guardAi(ctx.dir) : [];
  if (reverted.length) {
    log('ai', `kept plain for ${reverted.join(', ')} (AI scored no higher)`);
    ctx.force = new Set(STEPS.slice(STEPS.indexOf('build')));
    await runSteps(ctx, to);
  }
  // Fit: correct vertical gaps from what the clone rendered; a section keeps a round only if it scores higher.
  for (let round = 1; round <= FIT_ROUNDS && !process.exitCode && to === STEPS.length - 1 && !ctx.noFit; round++) {
    const before = Object.fromEntries(read(path.join(ctx.dir, 'verify', 'done.json')).sections.map((x) => [x.id, x.score]));
    const changed = await fitPass(ctx);
    if (!changed.length) break;
    log('fit', `round ${round}: ${changed.map((c) => `${c.id} (${c.moved} gaps)`).join(', ')}`);
    ctx.force = new Set(STEPS.slice(STEPS.indexOf('build')));
    await runSteps(ctx, to);
    const reverted = keepBetter(ctx, before);
    if (reverted.length) {
      log('fit', `round ${round}: kept the earlier spacing for ${reverted.join(', ')}`);
      await runSteps(ctx, to);
    }
    if (reverted.length === changed.length) break;
  }
  // Tidy last: presets instead of one-off values, palette colors, patterns; then rebuild the theme with them.
  if (!process.exitCode && to === STEPS.length - 1 && !ctx.noTidy) {
    const t = await tidyPass(ctx);
    log('tidy', `${t.spacing} spacing steps, ${t.fonts} font sizes, ${t.colors} added colors, ${t.patterns} patterns`);
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

// Open the report, then the local clone. While a system SOCKS proxy is on (vip proxy tunnel), a normal
// browser sends *.lndo.site through the tunnel and gets an SSH banner, so use a Chromium window that bypasses it.
function openResults(dir) {
  const r = exists(path.join(dir, 'report.json')) ? read(path.join(dir, 'report.json')) : null;
  try { execFileSync('open', [path.join(dir, 'report.html')]); } catch { /* not macOS */ }
  if (!r?.local) return;
  let socks = null;
  try {
    const p = execFileSync('scutil', ['--proxy'], { encoding: 'utf8' });
    if (/SOCKSEnable : 1/.test(p)) socks = `socks5://${p.match(/SOCKSProxy : (\S+)/)?.[1] || '127.0.0.1'}:${p.match(/SOCKSPort : (\d+)/)?.[1] || '8080'}`;
  } catch { /* no scutil */ }
  const app = socks && ['Google Chrome', 'Brave Browser', 'Microsoft Edge', 'Chromium'].find((a) => exists(`/Applications/${a}.app`));
  if (!app) { try { execFileSync('open', [r.local]); } catch { /* not macOS */ } return; }
  spawn('open', ['-na', app, '--args', `--user-data-dir=${path.join(os.tmpdir(), 'clone2theme-browser')}`, `--proxy-server=${socks}`,
    '--proxy-bypass-list=*.lndo.site;localhost;127.0.0.1', '--no-first-run', r.local], { stdio: 'ignore', detached: true }).unref();
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
  } else if (cmd === 'setup') {
    if (!(await setup({ site: o.site, yes: o.yes }))) process.exitCode = 1;
  } else if (cmd === 'list') {
    const fs = await import('node:fs');
    for (const d of fs.readdirSync(path.join(runDir(''))).filter((d) => exists(path.join(runDir(d), 'run.json')))) {
      const r = exists(path.join(runDir(d), 'report.json')) ? read(path.join(runDir(d), 'report.json')) : null;
      console.log(`${d}\t${read(path.join(runDir(d), 'run.json')).url}\t${r?.local || '-'}`);
    }
  } else if (cmd === 'open') {
    const file = path.join(runDir(arg || ''), 'report.html');
    if (!exists(file)) throw new Error(`no report at ${file}`);
    openResults(runDir(arg));
  } else {
    // clone2theme <url> (or run/step): a bare domain gets https://; check the input before any installs.
    const url = ['run', 'step'].includes(cmd) ? null : new URL(/^https?:\/\//.test(cmd) ? cmd : `https://${cmd}`).href;
    if (url && !/\./.test(new URL(url).hostname)) throw new Error(`unknown command or URL "${cmd}" (clone2theme --help)`);
    if (missing(o.site).length && !(await setup({ site: o.site, yes: o.yes }))) { process.exitCode = 1; } else {
      await loadPipeline();
      await clone(url);
    }
  }
} catch (e) {
  console.error(`c2t: ${e.message}`);
  process.exitCode = 1;
}

async function clone(shortcut) {
  if (shortcut) {
    const run = o.run || slugify(shortcut);
    const meta = { url: shortcut, site: o.site || 'vip-local', noAi: !o.ai, aiBudget: Number(o['ai-budget']) || undefined };
    write(path.join(runDir(run), 'run.json'), meta);
    const ctx = { ...meta, run, dir: runDir(run), force: new Set(o.fresh ? STEPS : []) };
    await pipeline(ctx);
    if (!process.exitCode && !o['no-open']) openResults(ctx.dir);
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
    ctx.noFit = !!o['no-fit'];
    ctx.noTidy = !!o['no-tidy'];
    ctx.keepAi = !!o['keep-ai']; // skip the score guard, to look at an AI version that lost
    ctx.force = new Set(o.only ? [arg] : STEPS.slice(i));
    await pipeline(ctx, o.only ? i : undefined);
  }
}
