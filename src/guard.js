// Step caching, retry limits, and small file helpers shared by every step.
import fs from 'node:fs';
import path from 'node:path';

export const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
export const STEPS = ['capture', 'extract', 'convert', 'build', 'push', 'verify'];

export const runDir = (run) => path.join(ROOT, 'runs', run);
export const exists = (p) => fs.existsSync(p);
export const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
export const write = (p, data) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
};

export function slugify(url) {
  const u = new URL(url);
  const s = (u.hostname.replace(/^www\./, '') + u.pathname).toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return s.replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
}

// Runs fn once per run; a done.json marks the step finished so reruns skip it.
export async function step(ctx, name, fn) {
  const dir = path.join(runDir(ctx.run), name);
  const done = path.join(dir, 'done.json');
  if (!ctx.force.has(name) && exists(done)) {
    log(name, 'cached');
    return read(done);
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.rmSync(path.join(dir, 'error.txt'), { force: true });
  const t = Date.now();
  log(name, 'running');
  const out = await fn(dir);
  out.ms = Date.now() - t;
  write(done, out);
  log(name, `done in ${(out.ms / 1000).toFixed(1)}s`);
  return out;
}

export async function withRetry(key, fn, max = 2) {
  let lastErr = null;
  for (let i = 0; i <= max; i++) {
    try { return await fn(lastErr); }
    catch (e) {
      if (lastErr && e.message === lastErr.message) break; // same error twice = stop
      lastErr = e;
    }
  }
  return { status: 'needs-human', key, error: lastErr?.message };
}

export function log(name, msg) {
  process.stderr.write(`c2t ${name.padEnd(8)} ${msg}\n`);
}
