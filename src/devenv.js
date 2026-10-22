// Thin wrapper around `vip dev-env exec -- wp ...` for one local VIP dev-env.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const NOISE = /^\[\d{2}-\w{3}-\d{4} [\d:]+ UTC\]/;

export function devenv(site) {
  const infoFile = path.join(os.homedir(), '.local/share/vip/dev-environment', site, 'instance_data.json');
  if (!fs.existsSync(infoFile)) throw new Error(`dev-env "${site}" not found (vip dev-env list)`);
  const info = JSON.parse(fs.readFileSync(infoFile, 'utf8'));
  if (info.appCode?.mode !== 'local') throw new Error(`dev-env "${site}" needs local app code (vip dev-env update --app-code=<dir>)`);
  const host = `${site}.vipdev.lndo.site`;

  const wp = (args, { url, allowFail = false } = {}) => {
    const full = ['dev-env', 'exec', `--slug=${site}`, '--quiet', '--', 'wp', ...args, ...(url ? [`--url=${url}`] : [])];
    let out;
    try {
      out = execFileSync('vip', full, { input: '', encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      if (allowFail && e.stdout) return e.stdout.split('\n').filter((l) => !NOISE.test(l)).join('\n').trim();
      const msg = `${e.stdout || ''}${e.stderr || ''}`.split('\n').filter((l) => l && !NOISE.test(l)).join('\n');
      throw new Error(`wp ${args.slice(0, 3).join(' ')} failed: ${msg.slice(0, 500)}`);
    }
    const clean = out.split('\n').filter((l) => !NOISE.test(l)).join('\n').trim();
    if (!allowFail && /^Error:/m.test(clean)) throw new Error(`wp ${args.slice(0, 3).join(' ')}: ${clean.match(/^Error:.*$/m)[0]}`);
    return clean;
  };

  // Any working site lets us run network commands; the root site may not resolve.
  let anchor = null;
  const anchorUrl = () => {
    if (anchor) return anchor;
    const rows = wp(['db', 'query', "SELECT domain, path FROM wp_blogs WHERE deleted=0 AND archived=0 ORDER BY (domain LIKE 'c2t-%') DESC, blog_id DESC LIMIT 20", '--skip-column-names']);
    for (const line of rows.split('\n')) {
      const [domain, p] = line.split('\t');
      const url = `http://${domain}${p}`;
      try { wp(['option', 'get', 'siteurl'], { url }); anchor = url; return url; } catch { /* try next */ }
    }
    throw new Error(`no reachable site in dev-env "${site}"`);
  };

  // Subdomain subsites resolve reliably on lndo.site, so each run gets one.
  const ensureSite = (slug, title) => {
    const url = `http://${slug}.${host}/`;
    try { wp(['option', 'get', 'siteurl'], { url }); return url; } catch { /* create it */ }
    wp(['site', 'create', `--slug=${slug}`, `--title=${title}`, '--porcelain'], { url: anchorUrl() });
    wp(['option', 'get', 'siteurl'], { url });
    return url;
  };

  const loginKey = () => {
    const out = execFileSync('vip', ['dev-env', 'info', `--slug=${site}`], { input: '', encoding: 'utf8' });
    return out.match(/vip-dev-autologin=([\w-]+)/)?.[1] || null;
  };

  return {
    site,
    host,
    wp,
    ensureSite,
    loginKey,
    themesDir: path.join(info.appCode.dir, 'themes'),
    containerThemes: '/wp/wp-content/themes',
  };
}
