import { type BrowserContext, test as base, chromium, expect, type Worker } from '@playwright/test';
import { type ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const EXTENSION = path.resolve(import.meta.dirname, '../.output/chrome-mv3');
const SERVER = path.resolve(import.meta.dirname, '../../engine/target/release/ydm-testserver.exe');

interface Served {
  url: string;
  sha256: string;
  process: ChildProcess;
}

interface Download {
  url: string;
  finalUrl: string;
  filename: string;
  state: string;
  byExtensionId?: string;
}

/** Starts the Rust test server; it prints its URL and the file's SHA-256. */
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

const test = base.extend<{ context: BrowserContext; worker: Worker; served: Served[] }>({
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
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    await use(worker);
  },
});

// `chrome` only exists inside the extension's service worker.
type ExtensionGlobal = typeof globalThis & {
  chrome: {
    downloads: { search(q: object): Promise<Download[]> };
    storage: {
      local: {
        set(v: object): Promise<void>;
        get(k: string | string[]): Promise<{ items?: { name: string; state: string }[] } & Record<string, unknown>>;
      };
    };
  };
};

function downloads(worker: Worker): Promise<Download[]> {
  return worker.evaluate(() => (globalThis as ExtensionGlobal).chrome.downloads.search({}));
}

function setLocal(worker: Worker, values: object) {
  return worker.evaluate((v) => (globalThis as ExtensionGlobal).chrome.storage.local.set(v), values);
}

async function ydmItems(worker: Worker) {
  const { items } = await worker.evaluate(() => (globalThis as ExtensionGlobal).chrome.storage.local.get('items'));
  return items ?? [];
}

async function waitForCompleted(worker: Worker, match: (d: Download) => boolean): Promise<Download> {
  for (const deadline = Date.now() + 90_000; Date.now() < deadline; ) {
    const found = (await downloads(worker)).find((d) => d.state === 'complete' && match(d));
    if (found) return found;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('download did not complete');
}

/** Opens a download URL in a tab, as a user clicking a link would. */
async function start(context: BrowserContext, url: string) {
  const page = await context.newPage();
  // The navigation turns into a download, which Playwright reports as an error.
  await page.goto(url).catch(() => {});
}

function sha256(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file)
      .on('data', (c) => hash.update(c))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

const fromYdm = (d: Download) => d.url.startsWith('blob:chrome-extension://');
const fromBrowser = (d: Download) => d.url.startsWith('http');

test('a large download goes through YDM, with the site cookies, byte-exact and faster', async ({
  context,
  worker,
  served,
}) => {
  // 2 MB/s per connection, and only for logged-in users.
  const server = await serve('--size', '24', '--rate', '2048', '--filename', 'big.bin', '--require-cookie', 'sid=42');
  served.push(server);
  await context.addCookies([{ name: 'sid', value: '42', url: server.url }]);

  let t = Date.now();
  await start(context, server.url);
  const ydm = await waitForCompleted(worker, fromYdm);
  const ydmSeconds = (Date.now() - t) / 1000;

  // Playwright stores downloads under random names; check the one YDM asked for.
  expect(await ydmItems(worker)).toEqual([expect.objectContaining({ name: 'big.bin', state: 'completed' })]);
  expect(await sha256(ydm.filename)).toBe(server.sha256);
  // The browser's own copy of the download was taken over and removed.
  expect((await downloads(worker)).filter(fromBrowser)).toHaveLength(0);

  // The same file through the browser alone.
  await worker.evaluate(() => (globalThis as ExtensionGlobal).chrome.storage.local.set({ enabled: false }));
  t = Date.now();
  await start(context, server.url);
  const plain = await waitForCompleted(worker, fromBrowser);
  const browserSeconds = (Date.now() - t) / 1000;
  expect(await sha256(plain.filename)).toBe(server.sha256);

  console.log(`24 MB at 2 MB/s per connection: browser ${browserSeconds.toFixed(1)} s, YDM ${ydmSeconds.toFixed(1)} s`);
  expect(ydmSeconds * 2).toBeLessThan(browserSeconds);
});

test('small files stay with the browser', async ({ context, worker, served }) => {
  const server = await serve('--size', '1', '--filename', 'small.bin');
  served.push(server);
  await start(context, server.url);
  const d = await waitForCompleted(worker, () => true);
  expect(fromBrowser(d)).toBe(true);
});

test('servers without range support still work, on one connection', async ({ context, worker, served }) => {
  const server = await serve('--size', '8', '--no-ranges', '--filename', 'plain.bin');
  served.push(server);
  await start(context, server.url);
  const d = await waitForCompleted(worker, fromYdm);
  expect(await sha256(d.filename)).toBe(server.sha256);
});

test('sites that check the Referer (hotlink protection) still go through YDM', async ({
  context,
  worker,
  served,
}) => {
  const server = await serve('--size', '8', '--require-referer', 'http://127.0.0.1', '--filename', 'game.bin');
  served.push(server);
  const page = await context.newPage();
  await page.goto(`${new URL(server.url).origin}/page`);
  await page.click('#dl');
  const d = await waitForCompleted(worker, fromYdm);
  expect(await sha256(d.filename)).toBe(server.sha256);
  expect(await ydmItems(worker)).toEqual([expect.objectContaining({ name: 'game.bin', state: 'completed' })]);
});

test('when YDM is refused, the download goes back to the browser and is not lost', async ({
  context,
  worker,
  served,
}) => {
  const server = await serve('--size', '8', '--forbid-ranges', '--filename', 'guarded.bin');
  served.push(server);
  await start(context, server.url);
  const d = await waitForCompleted(worker, fromBrowser);
  expect(await sha256(d.filename)).toBe(server.sha256);
  // The popup says why: the site refused YDM.
  expect(await ydmItems(worker)).toEqual([
    expect.objectContaining({ state: 'browser', reason: { key: 'reason.forbidden', params: { status: 403 } } }),
  ]);
});

test('closing the browser mid-download resumes where it stopped', async ({ served }) => {
  // 24 MB at 512 KB/s per connection: about 12 s with four connections.
  const server = await serve('--size', '24', '--rate', '512', '--filename', 'resume.bin', '--log');
  served.push(server);
  let log = '';
  server.process.stdout!.on('data', (c: Buffer) => (log += c.toString()));
  const profile = mkdtempSync(path.join(tmpdir(), 'ydm-profile-'));
  const launch = () =>
    chromium.launchPersistentContext(profile, {
      channel: 'chromium',
      headless: true,
      acceptDownloads: true,
      args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
    });
  const workerOf = async (c: BrowserContext) => c.serviceWorkers()[0] ?? (await c.waitForEvent('serviceworker'));

  let context = await launch();
  let worker = await workerOf(context);
  // A just-installed extension: let its listeners register before the click.
  await new Promise((r) => setTimeout(r, 1000));
  await start(context, server.url);
  // Close once a checkpoint says about a third is on disk.
  const missingBytes = async () => {
    const { items } = await worker.evaluate(() =>
      (globalThis as ExtensionGlobal).chrome.storage.local.get('items'),
    );
    const missing = (items as { checkpoint?: { missing: [number, number][] } }[] | undefined)?.[0]?.checkpoint?.missing;
    return missing ? missing.reduce((n, [a, b]) => n + b - a, 0) : null;
  };
  for (const deadline = Date.now() + 30_000; ; ) {
    const left = await missingBytes();
    if (left !== null && left <= 16 * 2 ** 20) break;
    if (Date.now() > deadline) throw new Error('no checkpoint with progress');
    await new Promise((r) => setTimeout(r, 200));
  }
  const before = log.length;
  await context.close();

  context = await launch();
  try {
    worker = await workerOf(context);
    const d = await waitForCompleted(worker, fromYdm);
    expect(await sha256(d.filename)).toBe(server.sha256);
    // After the restart only the missing part was fetched again.
    const refetched = log
      .slice(before)
      .split('\n')
      .map((l) => /^GET \/file range=bytes=(\d+)-(\d+) /.exec(l))
      .filter((m) => m !== null && m[1] !== m[2] && !(m[1] === '0' && m[2] === '0'))
      .reduce((n, m) => n + Number(m![2]) - Number(m![1]) + 1, 0);
    console.log(`after restart: ${(refetched / 2 ** 20).toFixed(1)} MB of 24 fetched again`);
    expect(refetched).toBeGreaterThan(0);
    expect(refetched).toBeLessThan(18 * 2 ** 20);
    expect(await ydmItems(worker)).toEqual([expect.objectContaining({ name: 'resume.bin', state: 'completed' })]);
  } finally {
    await context.close();
    rmSync(profile, { recursive: true, force: true });
  }
});

test('programs go to the browser unless that setting is off', async ({ context, worker, served }) => {
  const server = await serve('--size', '8', '--filename', 'setup.exe');
  served.push(server);
  await start(context, server.url);
  const d = await waitForCompleted(worker, fromBrowser);
  expect(await sha256(d.filename)).toBe(server.sha256);
  expect(await ydmItems(worker)).toEqual([
    expect.objectContaining({ state: 'browser', reason: { key: 'reason.program' } }),
  ]);

  await setLocal(worker, { programsToBrowser: false });
  await start(context, server.url);
  const ydm = await waitForCompleted(worker, fromYdm);
  expect(await sha256(ydm.filename)).toBe(server.sha256);
});

test('excluded sites and the number of connections follow the settings', async ({ context, worker, served }) => {
  const server = await serve('--size', '8', '--filename', 'data.bin', '--log');
  served.push(server);
  let log = '';
  server.process.stdout!.on('data', (c: Buffer) => (log += c.toString()));

  await setLocal(worker, { excluded: ['127.0.0.1'] });
  await start(context, server.url);
  expect(fromBrowser(await waitForCompleted(worker, () => true))).toBe(true);
  expect(await ydmItems(worker)).toEqual([]);

  // One connection: a single request, which is also the probe.
  await setLocal(worker, { excluded: [], connections: 1 });
  log = '';
  await start(context, server.url);
  const d = await waitForCompleted(worker, fromYdm);
  expect(await sha256(d.filename)).toBe(server.sha256);
  // (`range=-` is the browser's own request, before YDM takes over.)
  expect(log.split('\n').filter((l) => l.startsWith('GET /file range=bytes'))).toEqual([
    'GET /file range=bytes=0- cookie=no',
  ]);
});

test('pause keeps what is on disk; resume fetches only the rest', async ({ context, worker, served }) => {
  const server = await serve('--size', '24', '--rate', '512', '--filename', 'paused.bin', '--log');
  served.push(server);
  let log = '';
  server.process.stdout!.on('data', (c: Buffer) => (log += c.toString()));
  await start(context, server.url);
  const id = new URL(worker.url()).host;
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  const row = popup.locator('#list li').first();
  await expect(row).toHaveAttribute('data-state', 'running');
  await popup.waitForTimeout(3000);
  await row.getByRole('button', { name: 'Pausa' }).click();
  await expect(row).toHaveAttribute('data-state', 'paused');
  await expect(row.locator('.meta')).toContainText(/In pausa · \d+%/);
  const before = log.length;
  await popup.waitForTimeout(1500);
  await row.getByRole('button', { name: 'Riprendi' }).click();
  const d = await waitForCompleted(worker, fromYdm);
  expect(await sha256(d.filename)).toBe(server.sha256);
  const refetched = log
    .slice(before)
    .split('\n')
    .map((l) => /^GET \/file range=bytes=(\d+)-(\d+) /.exec(l))
    .filter((m) => m !== null)
    .reduce((n, m) => n + Number(m![2]) - Number(m![1]) + 1, 0);
  // About three seconds at 2 MB/s were kept.
  expect(refetched).toBeLessThan(21 * 2 ** 20);
  await expect(row).toHaveAttribute('data-state', 'completed');
});

test('a cancelled download can be tried again', async ({ context, worker, served }) => {
  const server = await serve('--size', '8', '--rate', '512', '--filename', 'again.bin');
  served.push(server);
  await start(context, server.url);
  const id = new URL(worker.url()).host;
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  const row = popup.locator('#list li').first();
  await row.getByRole('button', { name: 'Annulla' }).click();
  await expect(row).toHaveAttribute('data-state', 'cancelled');
  await row.getByRole('button', { name: 'Riprova' }).click();
  const d = await waitForCompleted(worker, fromYdm);
  expect(await sha256(d.filename)).toBe(server.sha256);
  await expect(row).toHaveAttribute('data-state', 'completed');
});

test('the speed limit holds YDM back', async ({ context, worker, served }) => {
  const server = await serve('--size', '8', '--filename', 'limited.bin');
  served.push(server);
  await setLocal(worker, { speedLimit: 2 * 2 ** 20 });
  const t = Date.now();
  await start(context, server.url);
  const d = await waitForCompleted(worker, fromYdm);
  const seconds = (Date.now() - t) / 1000;
  expect(await sha256(d.filename)).toBe(server.sha256);
  console.log(`8 MB with a 2 MB/s limit: ${seconds.toFixed(1)} s`);
  // 8 MB at 2 MB/s is 4 s, less a short initial burst.
  expect(seconds).toBeGreaterThan(3.2);
  expect(seconds).toBeLessThan(8);
});

test('the settings page saves what is changed', async ({ context, worker }) => {
  const id = new URL(worker.url()).host;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/options.html`);
  await page.getByLabel('Lascia al browser i programmi').uncheck();
  await page.getByLabel('Dimensione minima').selectOption('25');
  await page.getByRole('radio', { name: '5' }).click();
  await page.getByLabel('Sito da escludere').fill('https://www.Example.com/file');
  await page.getByRole('button', { name: 'Escludi' }).click();
  await page.getByLabel('Sito da escludere').fill('not a site');
  await page.getByRole('button', { name: 'Escludi' }).click();
  await expect(page.getByRole('alert')).toContainText('Non è un indirizzo');
  await expect(page.locator('#excluded li')).toHaveText(['example.comTogli']);

  const stored = await worker.evaluate(() =>
    (globalThis as ExtensionGlobal).chrome.storage.local.get(['programsToBrowser', 'minSize', 'parallel', 'excluded']),
  );
  expect(stored).toEqual({ programsToBrowser: false, minSize: 25 * 2 ** 20, parallel: 5, excluded: ['example.com'] });

  await page.getByRole('button', { name: 'Ripristina le impostazioni iniziali' }).click();
  await expect(page.getByLabel('Lascia al browser i programmi')).toBeChecked();
  await expect(page.locator('#excluded li')).toHaveCount(0);
});

test('the popup lists the download and its size', async ({ context, worker, served }) => {
  // Throttled, so the transfer takes long enough to report a time.
  const server = await serve('--size', '6', '--rate', '1024', '--filename', '<img src=x onerror=alert(1)>.bin');
  served.push(server);
  await start(context, server.url);
  await waitForCompleted(worker, fromYdm);

  const id = new URL(worker.url()).host;
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  const row = popup.locator('#list li').first();
  // The server's name arrives sanitized and as text, never as markup.
  await expect(row.locator('.name')).toHaveText('_img src=x onerror=alert(1)_.bin');
  await expect(popup.locator('img')).toHaveCount(0);
  // Size, time and average speed, to compare with the browser.
  await expect(row.locator('.meta')).toHaveText(/^6\.0 MB · \d+ s · media [\d.]+ (KB|MB)\/s$/);
  await expect(row).toHaveAttribute('data-state', 'completed');
  await expect(popup.locator('#enabled')).toBeChecked();
});
