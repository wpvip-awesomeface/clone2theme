import fs from 'node:fs';
import { chromium } from 'playwright-core';
import { systemBrowser } from './sysbrowser.js';

// Local dev-env pages must skip any system SOCKS proxy (e.g. an ssh -D tunnel),
// or *.lndo.site resolves on the far side of the tunnel.
export async function launch({ local = false } = {}) {
  // Playwright's own Chromium if downloaded, else an installed Chrome/Brave/Edge.
  const own = (() => { try { return fs.existsSync(chromium.executablePath()); } catch { return false; } })();
  return chromium.launch({ headless: true, args: local ? ['--proxy-server=direct://'] : [], ...(own ? {} : { executablePath: systemBrowser() || undefined }) });
}
