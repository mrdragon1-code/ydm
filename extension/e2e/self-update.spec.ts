import { chromium, expect, test } from '@playwright/test';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// A copy loaded unpacked in Chrome cannot be updated by Chrome. The
// installer's scheduled task replaces its files; YDM must notice the newer
// version on disk and reload itself (its list is saved first), once nothing
// is running and no YDM page is open.

const BUILT = path.resolve(import.meta.dirname, '../.output/chrome-mv3');

type Ext = typeof globalThis & {
  chrome: {
    runtime: { getManifest(): { version: string } };
  };
};

test('a newer version on disk is loaded by itself, once no YDM page is open', async () => {
  // A copy of its own: the test changes its files.
  const dir = mkdtempSync(path.join(tmpdir(), 'ydm-self-update-'));
  cpSync(BUILT, dir, { recursive: true });
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`],
  });
  try {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const id = new URL(worker.url()).host;
    await new Promise((r) => setTimeout(r, 1000));
    const before = await worker.evaluate(() => (globalThis as Ext).chrome.runtime.getManifest().version);

    // What update-chrome.ps1 does last: the new manifest.
    const file = path.join(dir, 'manifest.json');
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    manifest.version = '99.0.0';
    writeFileSync(file, JSON.stringify(manifest));

    // Opening a page makes it look; it waits until the page is closed.
    let reloaded = false;
    const stopped = new Promise<void>((resolve) =>
      worker.once('close', () => {
        reloaded = true;
        resolve();
      }),
    );
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${id}/popup.html`);
    await new Promise((r) => setTimeout(r, 1500));
    expect(reloaded).toBe(false); // not while a YDM page is open
    await popup.close();
    // runtime.reload() stops this service worker; the new version starts at
    // its next event. (Chromium driven by Playwright, unlike a real Chrome,
    // disables an extension loaded from the command line when it reloads, so
    // the new worker itself cannot be observed here.)
    await stopped;
    expect(reloaded).toBe(true);
    expect(before).not.toBe('99.0.0');
  } finally {
    await context.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
