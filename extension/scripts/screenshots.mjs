// Screenshots of the popup, downloads page and settings, with real
// downloads from the local test server: for checking the UI and for the
// store listings (1280×800).
//
//   npm run build && node scripts/screenshots.mjs [--lang it] [--dark] [--out dir]
//
// Needs engine/target/release/ydm-testserver(.exe).

import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

const HERE = path.resolve(import.meta.dirname, '..');
const EXTENSION = path.join(HERE, '.output/chrome-mv3');
const exe = process.platform === 'win32' ? 'ydm-testserver.exe' : 'ydm-testserver';
const SERVER = path.resolve(HERE, '../engine/target/release', exe);

const { values } = parseArgs({
  options: {
    lang: { type: 'string', default: 'en' },
    dark: { type: 'boolean', default: false },
    out: { type: 'string', default: path.join(HERE, '../store/screenshots') },
  },
});

function serve(...args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(SERVER, ['--port', '0', ...args]);
    let out = '';
    proc.on('error', reject);
    proc.stdout.on('data', (c) => {
      out += c.toString();
      const url = /serving \d+ MB at (\S+)/.exec(out)?.[1];
      if (url && /sha256/.test(out)) resolve({ url, proc });
    });
  });
}

if (!existsSync(SERVER)) throw new Error(`build the test server first: ${SERVER}`);
mkdirSync(values.out, { recursive: true });

const servers = await Promise.all([
  serve('--size', '64', '--rate', '600', '--filename', 'ubuntu-26.04-desktop-amd64.iso'),
  serve('--size', '40', '--rate', '900', '--filename', 'Blender-5.2-windows.zip'),
  serve('--size', '6', '--filename', 'Annual report 2026.pdf'),
  serve('--size', '12', '--forbid-ranges', '--filename', 'protected-archive.7z'),
]);

const context = await chromium.launchPersistentContext('', {
  channel: 'chromium',
  headless: true,
  acceptDownloads: true,
  colorScheme: values.dark ? 'dark' : 'light',
  viewport: { width: 1280, height: 800 },
  args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
});
try {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const id = new URL(worker.url()).host;
  await worker.evaluate((language) => chrome.storage.local.set({ language, connections: 6 }), values.lang);
  await new Promise((r) => setTimeout(r, 500));
  // The small and the refused ones first, so they are finished in the shots.
  for (const s of [servers[2], servers[3], servers[1], servers[0]]) {
    await (await context.newPage()).goto(s.url).catch(() => {});
    await new Promise((r) => setTimeout(r, 400));
  }
  await new Promise((r) => setTimeout(r, 4000));

  const page = await context.newPage();
  const suffix = `${values.lang}${values.dark ? '-dark' : ''}`;

  await page.goto(`chrome-extension://${id}/downloads.html`);
  await page.locator('#list li').first().waitFor();
  await page.locator('#list li').nth(1).click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(values.out, `downloads-${suffix}.png`) });

  // The popup in its real size, centred on a plain backdrop.
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 380, height: 520 });
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await popup.locator('#list li').first().waitFor();
  await popup.waitForTimeout(800);
  await popup.screenshot({ path: path.join(values.out, `popup-${suffix}.png`) });

  await page.goto(`chrome-extension://${id}/options.html`);
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(values.out, `settings-${suffix}.png`) });
  console.log(`screenshots in ${values.out}`);
} finally {
  await context.close();
  for (const s of servers) s.proc.kill();
}
