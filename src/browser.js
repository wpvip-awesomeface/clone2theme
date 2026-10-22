import { chromium } from 'playwright-core';

// Local dev-env pages must skip any system SOCKS proxy (e.g. an ssh -D tunnel),
// or *.lndo.site resolves on the far side of the tunnel.
export async function launch({ local = false } = {}) {
  return chromium.launch({ headless: true, args: local ? ['--proxy-server=direct://'] : [] });
}
