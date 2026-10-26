// First-run setup: check every prerequisite and install what's missing (asking first unless --yes).
// npm lifecycle scripts are often disabled (safe-npm), so this runs from the CLI, not postinstall.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { ROOT } from './guard.js';
import { systemBrowser } from './sysbrowser.js';

const SKELETON = 'https://github.com/Automattic/vip-go-skeleton.git';
const APP_CODE = path.join(os.homedir(), 'clone2theme', 'app-code');

const has = (cmd, args = ['--version']) => spawnSync(cmd, args, { stdio: 'ignore' }).status === 0;
const out = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8', input: '', stdio: ['pipe', 'pipe', 'ignore'] }); } catch { return ''; } };
const run = (cmd, args, opts = {}) => {
  console.log(`  $ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.status !== 0) throw new Error(`"${cmd} ${args[0]}" failed`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const instance = (site) => path.join(os.homedir(), '.local/share/vip/dev-environment', site, 'instance_data.json');

function chromiumReady() {
  try {
    const p = execFileSync(process.execPath, ['--input-type=module', '-e', "import { chromium } from 'playwright-core'; console.log(chromium.executablePath())"], { cwd: ROOT, encoding: 'utf8' }).trim();
    return fs.existsSync(p);
  } catch { return false; }
}

// Each check: ok() says whether it's in place; fix() installs it; manual is what to tell people when we can't.
function checks(site) {
  return [
    {
      name: 'Node.js 20.12 or newer',
      ok: () => { const [a, b] = process.versions.node.split('.').map(Number); return a > 20 || (a === 20 && b >= 12); },
      manual: 'Install Node 22 from https://nodejs.org (or `nvm install 22`), then reinstall clone2theme.',
    },
    {
      name: 'Tool dependencies',
      ok: () => fs.existsSync(path.join(ROOT, 'node_modules', 'playwright-core')),
      fix: () => run('npm', ['ci'], { cwd: ROOT }),
    },
    {
      name: 'Browser engine (for measuring pages)',
      ok: () => chromiumReady() || !!systemBrowser(),
      fix: () => run(process.execPath, [path.join(ROOT, 'node_modules', 'playwright-core', 'cli.js'), 'install', 'chromium'], { cwd: ROOT }),
    },
    {
      name: 'Docker installed',
      ok: () => has('docker'),
      fix: () => {
        if (!has('brew')) throw new Error('Homebrew not found');
        run('brew', ['install', '--cask', 'docker']);
      },
      manual: 'Install Docker Desktop from https://www.docker.com/products/docker-desktop/ and open it once.',
    },
    {
      name: 'Docker running',
      ok: () => has('docker', ['info']),
      fix: async () => {
        run('open', ['-a', 'Docker']);
        console.log('  waiting for Docker to start (up to 2 minutes)...');
        for (let i = 0; i < 60; i++) { if (has('docker', ['info'])) return; await wait(2000); }
        throw new Error('Docker did not start; open Docker Desktop and accept its prompts');
      },
      manual: 'Open Docker Desktop and wait until it says "running".',
    },
    {
      name: 'VIP CLI',
      ok: () => has('vip'),
      fix: () => run('npm', ['install', '-g', '@automattic/vip']),
    },
    {
      name: `Local WordPress (VIP dev-env "${site}")`,
      ok: () => fs.existsSync(instance(site)),
      fix: () => {
        if (!fs.existsSync(path.join(APP_CODE, 'themes'))) {
          fs.mkdirSync(path.dirname(APP_CODE), { recursive: true });
          run('git', ['clone', '--depth', '1', SKELETON, APP_CODE]);
        }
        // Subdomain multisite: every clone gets its own subsite.
        run('vip', ['dev-env', 'create', `--slug=${site}`, '--title=clone2theme', '--multisite=y', `--app-code=${APP_CODE}`, '--mu-plugins=demo',
          '--wordpress=latest', '--php=8.2', '--phpmyadmin=n', '--xdebug=n', '--elasticsearch=n', '--mailpit=n', '--photon=y', '--cron=n']);
      },
    },
    {
      name: 'Local WordPress uses local theme folder',
      ok: () => { try { return JSON.parse(fs.readFileSync(instance(site), 'utf8')).appCode?.mode === 'local'; } catch { return false; } },
      manual: `Point it at a folder: vip dev-env update --slug=${site} --app-code=<folder with themes/>`,
    },
    {
      name: 'Local WordPress running',
      ok: () => /STATUS\s+UP/.test(out('vip', ['dev-env', 'info', `--slug=${site}`])),
      fix: () => run('vip', ['dev-env', 'start', `--slug=${site}`, '--skip-wp-versions-check']),
    },
  ];
}

async function ask(q, yes) {
  if (yes) return true;
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(`  ${q} [Y/n] `)).trim().toLowerCase();
  rl.close();
  return a === '' || a === 'y' || a === 'yes';
}

// Fast check used before every clone: names of what's missing (no installs).
export function missing(site = 'vip-local') {
  const list = checks(site);
  const out = [];
  for (const c of list) {
    if (c.ok()) continue;
    out.push(c.name);
    break; // later checks depend on earlier ones
  }
  return out;
}

export async function setup({ site = 'vip-local', yes = false } = {}) {
  console.log('clone2theme setup\n');
  for (const c of checks(site)) {
    if (c.ok()) { console.log(`✓ ${c.name}`); continue; }
    console.log(`✗ ${c.name}`);
    if (!c.fix || !(await ask(`Install/fix "${c.name}" now?`, yes))) {
      console.log(`\n  To fix by hand: ${c.manual || 'run `clone2theme setup` in a terminal and answer yes.'}`);
      return false;
    }
    try { await c.fix(); } catch (e) {
      console.log(`\n  Could not fix automatically (${e.message}).${c.manual ? `\n  To fix by hand: ${c.manual}` : ''}`);
      return false;
    }
    if (!c.ok()) { console.log(`\n  Still not ready after the fix.${c.manual ? ` ${c.manual}` : ''}`); return false; }
    console.log(`✓ ${c.name}`);
  }
  console.log('\nAll set. Try: clone2theme example.com');
  return true;
}
