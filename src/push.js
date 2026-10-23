// Ship the theme to the dev-env: own subsite, media import, URL rewrite, front page.
import fs from 'node:fs';
import path from 'node:path';
import { devenv } from './devenv.js';
import { read, write, exists } from './guard.js';

const esc = (s) => s.replace(/&/g, '&amp;');

export async function push(ctx, dir) {
  const env = devenv(ctx.site);
  const b = read(path.join(ctx.dir, 'build', 'done.json'));
  const dom = read(path.join(ctx.dir, 'capture', 'dom.json'));
  const prev = exists(path.join(dir, 'state.json')) ? read(path.join(dir, 'state.json')) : {};
  const siteSlug = b.themeSlug;
  const url = env.ensureSite(siteSlug, read(path.join(ctx.dir, 'capture', 'done.json')).title || ctx.run);
  const target = path.join(env.themesDir, b.themeSlug);
  const inContainer = `${env.containerThemes}/${b.themeSlug}`;

  // Copy the theme plus a staging folder for media and content (removed at the end).
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(b.themeDir, target, { recursive: true });
  const stage = path.join(target, '.c2t');
  fs.mkdirSync(stage, { recursive: true });

  // Media: import once per run and keep the original -> local URL map.
  // A saved entry only counts if the upload carries its own file name (older runs matched by position).
  const stem = (file) => file.replace(/\.\w+$/, '');
  const media = Object.fromEntries(Object.entries(prev.siteUrl === url && prev.media ? prev.media : {})
    .filter(([orig, local]) => dom.assets[orig] && path.basename(local).startsWith(stem(dom.assets[orig]))));
  const todo = Object.entries(dom.assets).filter(([orig]) => !media[orig]);
  if (todo.length) {
    env.allowImageTypes(url);
    for (const [, file] of todo) fs.copyFileSync(path.join(ctx.dir, 'capture', 'assets', file), path.join(stage, file));
    // A refused file (type not allowed) must not stop the run: unmatched images stay hotlinked.
    let out = '';
    try { out = env.wp(['media', 'import', ...todo.map(([, f]) => `${inContainer}/.c2t/${f}`), '--porcelain=url'], { url, allowFail: true }); }
    catch { /* nothing imported */ }
    const urls = out.split('\n').map((l) => l.trim()).filter((l) => /^https?:\/\//.test(l));
    // Match by file name: a failed import would shift positions in the output.
    for (const [orig, file] of todo) {
      const hit = urls.find((u) => path.basename(u).startsWith(stem(file)));
      if (hit) media[orig] = hit;
    }
  }
  const rewrite = (html) => Object.entries(media).reduce((h, [orig, local]) => h.split(orig).join(local).split(esc(orig)).join(local), html);

  for (const part of ['header', 'footer']) {
    const f = path.join(target, 'parts', `${part}.html`);
    fs.writeFileSync(f, rewrite(fs.readFileSync(f, 'utf8')));
  }
  fs.writeFileSync(path.join(stage, 'front.html'), rewrite(fs.readFileSync(path.join(ctx.dir, 'build', 'front.html'), 'utf8')));

  env.wp(['theme', 'enable', b.themeSlug], { url });
  env.wp(['theme', 'activate', b.themeSlug], { url });

  let pageId = prev.siteUrl === url ? prev.pageId : null;
  if (pageId) {
    try { env.wp(['post', 'update', String(pageId), `${inContainer}/.c2t/front.html`], { url }); }
    catch { pageId = null; }
  }
  if (!pageId) {
    pageId = Number(env.wp(['post', 'create', `${inContainer}/.c2t/front.html`, '--post_type=page', '--post_title=Home', '--post_status=publish', '--porcelain'], { url }));
  }
  env.wp(['option', 'update', 'show_on_front', 'page'], { url });
  env.wp(['option', 'update', 'page_on_front', String(pageId)], { url });
  fs.rmSync(stage, { recursive: true, force: true });

  const state = { siteUrl: url, pageId, media, theme: b.themeSlug, themePath: target };
  write(path.join(dir, 'state.json'), state);
  return { siteUrl: url, pageId, theme: b.themeSlug, themePath: target, media: Object.keys(media).length, mediaMissing: Object.keys(dom.assets).length - Object.keys(media).length };
}
