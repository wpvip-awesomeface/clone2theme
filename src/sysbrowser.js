// An installed Chromium-family browser, used when Playwright's own Chromium isn't downloaded. No dependencies.
import fs from 'node:fs';

const APPS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];

export const systemBrowser = () => APPS.find((p) => fs.existsSync(p)) || null;
