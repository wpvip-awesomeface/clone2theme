// Screenshot the local clone. Per-section diff scores (pixelmatch) come in build step 3.
import path from 'node:path';
import { launch } from './browser.js';
import { read } from './guard.js';

export async function verify(ctx, dir) {
  const { siteUrl } = read(path.join(ctx.dir, 'push', 'done.json'));
  const browser = await launch({ local: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
    const res = await page.goto(siteUrl, { waitUntil: 'networkidle', timeout: 60000 });
    await page.screenshot({ path: path.join(dir, 'full.png'), fullPage: true });
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    const broken = await page.evaluate(() => [...document.images].filter((i) => i.complete && !i.naturalWidth).map((i) => i.src).slice(0, 20));
    return { siteUrl, status: res?.status() ?? 0, height, brokenImages: broken, diff: 'not built yet' };
  } finally {
    await browser.close();
  }
}
