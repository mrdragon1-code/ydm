import { type BrowserContext, test as base, chromium, expect, type Page, type Worker } from '@playwright/test';
import { type ChildProcess, spawn } from 'node:child_process';
import path from 'node:path';

// The 1.0 features: languages, the downloads page, adding URLs, picking a
// page's links, SHA-256, and the layout holding together.
const EXTENSION = path.resolve(import.meta.dirname, '../.output/chrome-mv3');
const SERVER = path.resolve(import.meta.dirname, '../../engine/target/release/ydm-testserver.exe');

interface Served {
  url: string;
  sha256: string;
  process: ChildProcess;
}

function serve(...args: string[]): Promise<Served> {
  return new Promise((resolve, reject) => {
    const process = spawn(SERVER, ['--port', '0', ...args]);
    let out = '';
    process.on('error', reject);
    process.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      const url = /serving \d+ MB at (\S+)/.exec(out)?.[1];
      const sha256 = /sha256 ([0-9a-f]{64})/.exec(out)?.[1];
      if (url && sha256) resolve({ url, sha256, process });
    });
  });
}

type Ext = typeof globalThis & {
  chrome: {
    storage: { local: { set(v: object): Promise<void>; get(k: string): Promise<Record<string, unknown>> } };
    downloads: { search(q: object): Promise<{ state: string; url: string }[]> };
  };
};

const test = base.extend<{ context: BrowserContext; worker: Worker; served: Served[]; id: string }>({
  served: async ({}, use) => {
    const list: Served[] = [];
    await use(list);
    for (const s of list) s.process.kill();
  },
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: true,
      acceptDownloads: true,
      args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
    });
    await use(context);
    await context.close();
  },
  worker: async ({ context }, use) => {
    await use(context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker')));
  },
  id: async ({ worker }, use) => {
    await use(new URL(worker.url()).host);
  },
});

async function completedCount(worker: Worker): Promise<number> {
  const all = await worker.evaluate(() => (globalThis as Ext).chrome.downloads.search({ state: 'complete' }));
  return all.filter((d) => d.url.startsWith('blob:')).length;
}

async function waitFor(check: () => Promise<boolean>, ms = 60_000) {
  for (const deadline = Date.now() + ms; Date.now() < deadline; ) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('timed out');
}

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

test('English by default; Italian when chosen, everywhere at once', async ({ context, worker, id }) => {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await expect(popup.locator('#empty')).toContainText('No downloads yet.');
  await expect(popup.locator('html')).toHaveAttribute('lang', 'en');

  const settings = await context.newPage();
  await settings.goto(`chrome-extension://${id}/options.html`);
  await expect(settings.locator('h1')).toHaveText('Settings');
  await settings.getByLabel('Language').selectOption('it');
  await expect(settings.locator('h1')).toHaveText('Impostazioni');
  await expect(settings.getByLabel('Lascia al browser i programmi')).toBeVisible();
  // Every visible text is translated: no message key left on the page.
  const keys = await settings.locator('body').innerText();
  expect(keys).not.toMatch(/\b(settings|popup|downloads)\.[a-z]+/i);

  await popup.reload();
  await expect(popup.locator('#empty')).toContainText('Nessun download per ora.');
  expect(await worker.evaluate(() => (globalThis as Ext).chrome.storage.local.get('language'))).toEqual({
    language: 'it',
  });
});

test('pasted URLs are downloaded, and the downloads page shows the SHA-256', async ({
  context,
  worker,
  served,
  id,
}) => {
  const a = await serve('--size', '2', '--filename', 'small-a.bin');
  const b = await serve('--size', '3', '--filename', 'small-b.bin');
  served.push(a, b);
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await popup.getByRole('button', { name: 'Add URLs' }).click();
  // Small files too: chosen by hand, no minimum size.
  await popup.locator('#urls').fill(`${a.url}\nnot a link\n${b.url}`);
  await popup.getByRole('button', { name: 'Download', exact: true }).click();
  await expect(popup.locator('#addStatus')).toHaveText('2 downloads added');
  await waitFor(async () => (await completedCount(worker)) === 2);

  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/downloads.html`);
  await page.locator('#list li', { hasText: 'small-a.bin' }).click();
  await expect(page.locator('#dHash')).toHaveText(a.sha256, { timeout: 15_000 });
  await page.locator('#dCheck').fill(a.sha256.toUpperCase());
  await expect(page.locator('#dVerdict')).toHaveAttribute('data-ok', 'true');
  await page.locator('#dCheck').fill('0'.repeat(64));
  await expect(page.locator('#dVerdict')).toHaveAttribute('data-ok', 'false');

  // Search and filters narrow the list.
  await page.locator('#search').fill('small-b');
  await expect(page.locator('#list li')).toHaveCount(1);
  await page.locator('#search').fill('');
  await page.getByRole('radio', { name: 'Problems' }).click();
  await expect(page.locator('#list li')).toHaveCount(0);
  await expect(page.locator('#empty')).toBeVisible();
});

test("picking a page's links queues the chosen ones", async ({ context, worker, id }) => {
  // A page with a link to a file, one to a page, and one without an extension.
  const site = await context.newPage();
  await site.route('http://files.test/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><a href="/download?id=1">x</a>
             <a href="http://files.test/game.iso">game</a>
             <a href="http://files.test/about">about</a>`,
    }),
  );
  await site.goto('http://files.test/');
  const tabId = await worker.evaluate(async () => {
    const [tab] = await (globalThis as unknown as { chrome: { tabs: { query(q: object): Promise<{ id: number }[]> } } }).chrome.tabs.query({
      url: 'http://files.test/*',
    });
    return tab!.id;
  });
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/downloads.html#grab=${tabId}`);
  await expect(page.locator('#grabTitle')).toHaveText('Links on files.test');
  // Only the link to a file is offered; the page link is not.
  await expect(page.locator('#grabList li')).toHaveCount(1);
  await expect(page.locator('#grabList li')).toContainText('game.iso');
  await expect(page.getByRole('button', { name: 'Download 1 file' })).toBeEnabled();
  await page.locator('#grabAll').uncheck();
  await expect(page.locator('#grabSubmit')).toBeDisabled();
  await page.locator('#grabAll').check();
  await page.locator('#grabSubmit').click();
  await expect(page.locator('#grab')).toBeHidden();
  await expect(page.locator('#list li', { hasText: 'game.iso' })).toHaveCount(1);
});

test('pages hold together at their sizes, in light and dark', async ({ context, id }) => {
  for (const scheme of ['light', 'dark'] as const) {
    const popup = await context.newPage();
    await popup.emulateMedia({ colorScheme: scheme });
    await popup.setViewportSize({ width: 380, height: 500 });
    await popup.goto(`chrome-extension://${id}/popup.html`);
    await noHorizontalScroll(popup);
    for (const width of [1280, 420]) {
      const page = await context.newPage();
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width, height: 800 });
      await page.goto(`chrome-extension://${id}/downloads.html`);
      await noHorizontalScroll(page);
      await page.goto(`chrome-extension://${id}/options.html`);
      await noHorizontalScroll(page);
      await page.close();
    }
    await popup.close();
  }
});
