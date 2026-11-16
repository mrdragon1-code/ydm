import { type BrowserContext, test as base, chromium, expect, type Page, type Worker } from '@playwright/test';
import { type ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { type FakeScanners, GOOD_KEY, startFakeScanners } from './fake-scanners';

// The security checks, end to end: a stand-in VirusTotal says which files
// are viruses; YDM must keep them out of the Downloads folder, ask about
// suspicious ones, and let clean ones through untouched.

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

interface Download {
  url: string;
  filename: string;
  state: string;
  exists: boolean;
}

type Ext = typeof globalThis & {
  chrome: {
    downloads: { search(q: object): Promise<Download[]> };
    storage: { local: { set(v: object): Promise<void>; get(k: string): Promise<Record<string, unknown>> } };
  };
};

interface Row {
  id: number;
  name: string;
  state: string;
  security?: { level: string; findings: { source: string }[] };
}

const test = base.extend<{ context: BrowserContext; worker: Worker; served: Served[]; scanners: FakeScanners }>({
  scanners: async ({}, use) => {
    const fake = await startFakeScanners();
    await use(fake);
    await fake.close();
  },
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
    // A just-installed extension: let its listeners register first.
    await new Promise((r) => setTimeout(r, 1000));
    await use(worker);
  },
});

const local = (worker: Worker, v: object) => worker.evaluate((v) => (globalThis as Ext).chrome.storage.local.set(v), v);
const downloads = (worker: Worker) => worker.evaluate(() => (globalThis as Ext).chrome.downloads.search({}));
const items = async (worker: Worker) =>
  ((await worker.evaluate(() => (globalThis as Ext).chrome.storage.local.get('items'))).items as Row[] | undefined) ?? [];
const savedByYdm = async (worker: Worker) => (await downloads(worker)).filter((d) => d.url.startsWith('blob:'));

async function until<T>(get: () => Promise<T>, ok: (v: T) => boolean, ms = 30_000): Promise<T> {
  for (const deadline = Date.now() + ms; ; ) {
    const v = await get();
    if (ok(v)) return v;
    if (Date.now() > deadline) throw new Error(`timed out; last value: ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function start(context: BrowserContext, url: string) {
  await (await context.newPage()).goto(url).catch(() => {});
}

/** The warning window YDM opened, once it is there. */
async function warning(context: BrowserContext): Promise<Page> {
  const found = context.pages().find((p) => p.url().includes('/alert.html'));
  return found ?? (await context.waitForEvent('page', { predicate: (p) => p.url().includes('/alert.html'), timeout: 15_000 }));
}

test('a clean file is saved as always, and marked as checked', async ({ context, worker, served, scanners }) => {
  const server = await serve('--size', '6', '--filename', 'clean.iso');
  served.push(server);
  await local(worker, { virusTotalKey: GOOD_KEY });
  await start(context, server.url);
  await until(() => savedByYdm(worker), (d) => d.some((x) => x.state === 'complete'));
  const [row] = await until(() => items(worker), (i) => i[0]?.state === 'completed');
  expect(row!.security?.level).toBe('clean');
  // Asked about the file by its hash, with the user's key.
  expect(scanners.requests.some((r) => r.path === `/vt/files/${server.sha256}` && r.key === GOOD_KEY)).toBe(true);
});

test('a known virus never reaches the Downloads folder', async ({ context, worker, served, scanners }) => {
  const server = await serve('--size', '6', '--filename', 'free-game.zip');
  served.push(server);
  scanners.set({ files: { [server.sha256]: 41 } });
  await local(worker, { virusTotalKey: GOOD_KEY });
  await start(context, server.url);

  const [row] = await until(() => items(worker), (i) => i[0]?.state === 'blocked');
  expect(row!.security?.level).toBe('malicious');
  expect(await savedByYdm(worker)).toEqual([]);

  // The warning names the cause and offers no way to download it.
  const alert = await warning(context);
  await expect(alert.locator('h1')).toHaveText('Virus blocked');
  await expect(alert.locator('#reasons')).toContainText('41 antivirus engines of 70 recognize this file as a virus');
  await expect(alert.getByRole('button', { name: 'Download anyway' })).toBeHidden();
  await expect(alert.getByRole('button', { name: 'OK, keep it blocked' })).toBeFocused();
});

test('suspicious: it waits, "Don\'t download" saves nothing', async ({ context, worker, served, scanners }) => {
  const server = await serve('--size', '6', '--filename', 'tool.zip');
  served.push(server);
  scanners.set({ files: { [server.sha256]: 1 } });
  await local(worker, { virusTotalKey: GOOD_KEY });
  const t = Date.now();
  await start(context, server.url);

  const alert = await warning(context);
  const shownAfter = Date.now() - t;
  await expect(alert.locator('h1')).toHaveText('This download looks suspicious');
  await expect(alert.locator('#name')).toHaveText('tool.zip');
  // The safe choice has the focus.
  await expect(alert.getByRole('button', { name: "Don't download" })).toBeFocused();
  // The list is written to storage a moment after it changes.
  await until(() => items(worker), (i) => i[0]?.state === 'held');
  expect(await savedByYdm(worker)).toEqual([]);
  console.log(`warning shown ${shownAfter} ms after the download started`);

  await alert.getByRole('button', { name: "Don't download" }).click();
  await until(() => items(worker), (i) => i[0]?.state === 'cancelled');
  expect(await savedByYdm(worker)).toEqual([]);
});

test('suspicious: "Download anyway" saves the very same file', async ({ context, worker, served, scanners }) => {
  const server = await serve('--size', '6', '--filename', 'tool.zip');
  served.push(server);
  scanners.set({ files: { [server.sha256]: 2 } });
  await local(worker, { virusTotalKey: GOOD_KEY });
  await start(context, server.url);
  const alert = await warning(context);
  await alert.getByRole('button', { name: 'Download anyway' }).click();
  const [saved] = await until(() => savedByYdm(worker), (d) => d[0]?.state === 'complete');
  const hash = createHash('sha256');
  hash.update(await import('node:fs').then((fs) => fs.readFileSync(saved!.filename)));
  expect(hash.digest('hex')).toBe(server.sha256);
  await until(() => items(worker), (i) => i[0]?.state === 'completed');
});

test('a program dressed as a PDF is caught on the device, with no key', async ({ context, worker, scanners }) => {
  // "MZ": the first bytes of every Windows program.
  const body = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(6 * 1024 * 1024, 0x41)]);
  const http: Server = createServer((_, res) => {
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'attachment; filename="invoice.pdf"',
      'Content-Length': body.length,
      'Accept-Ranges': 'none',
    });
    res.end(body);
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  try {
    await start(context, `http://127.0.0.1:${(http.address() as AddressInfo).port}/invoice.pdf`);
    const alert = await warning(context);
    await expect(alert.locator('#reasons')).toContainText('is named like a .pdf but is actually a program');
    await expect(alert.locator('#reasons')).toContainText('on your device');
    expect(await savedByYdm(worker)).toEqual([]);
    // No key: nothing was sent anywhere.
    expect(scanners.requests).toEqual([]);
  } finally {
    http.close();
  }
});

test('a service that is down or a wrong key does not stop downloads', async ({ context, worker, served, scanners }) => {
  const server = await serve('--size', '6', '--filename', 'movie.mkv');
  served.push(server);
  scanners.set({ status: 503 });
  await local(worker, { virusTotalKey: GOOD_KEY });
  await start(context, server.url);
  await until(() => savedByYdm(worker), (d) => d[0]?.state === 'complete');
  const [row] = await until(() => items(worker), (i) => i[0]?.state === 'completed');
  expect(row!.security?.level).toBe('unknown');
});

test('a service too slow to answer: YDM asks, and "Download anyway" saves the file', async ({
  context,
  worker,
  served,
  scanners,
}) => {
  test.setTimeout(90_000);
  const server = await serve('--size', '6', '--filename', 'slow-check.zip');
  served.push(server);
  scanners.set({ hang: true });
  await local(worker, { virusTotalKey: GOOD_KEY });
  await start(context, server.url);
  // After the service's time runs out (15 s), the question appears.
  await until(() => items(worker), (i) => i[0]?.state === 'held', 45_000);
  const alert = await warning(context);
  await expect(alert.locator('body')).toContainText('did not answer in time', { timeout: 30_000 });
  expect(await savedByYdm(worker)).toEqual([]);
  const [held] = await items(worker);
  expect(held!.state).toBe('held');
  expect(held!.security?.level).toBe('unknown');
  await alert.getByRole('button', { name: 'Download anyway' }).click();
  await until(() => savedByYdm(worker), (d) => d[0]?.state === 'complete', 60_000);
  await until(() => items(worker), (i) => i[0]?.state === 'completed', 60_000);
});

test('without a key nothing leaves the computer', async ({ context, worker, served, scanners }) => {
  const server = await serve('--size', '6', '--filename', 'plain.iso');
  served.push(server);
  await start(context, server.url);
  await until(() => savedByYdm(worker), (d) => d[0]?.state === 'complete');
  expect(scanners.requests).toEqual([]);
});

test('a small file the browser downloads is stopped when its address is flagged', async ({ context, worker, served, scanners }) => {
  const server = await serve('--size', '1', '--filename', 'small.exe');
  served.push(server);
  scanners.set({ urls: { [server.url]: 12 } });
  await local(worker, { virusTotalKey: GOOD_KEY });
  await start(context, server.url);
  const [row] = await until(() => items(worker), (i) => i[0]?.state === 'blocked');
  expect(row!.security?.findings[0]?.source).toBe('virustotal');
  // Nothing of it is left: no finished browser download, and no file.
  const left = (await downloads(worker)).filter((d) => d.url.startsWith('http') && d.state === 'complete' && d.exists);
  expect(left).toEqual([]);
});

test('the security screen saves and tests a key, and never shows it again', async ({ context, worker, scanners }) => {
  const id = new URL(worker.url()).host;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/app.html#security`);
  await expect(page.locator('#secTitle')).toHaveText('Protected on your device');

  await page.locator('#vtKey').fill('too-short');
  await page.locator('#vtForm').getByRole('button', { name: 'Save and test' }).click();
  await expect(page.locator('#vtError')).toContainText('does not look like an API key');

  await page.locator('#vtKey').fill('wrong-key-0123456789abcdef');
  await page.locator('#vtForm').getByRole('button', { name: 'Save and test' }).click();
  await expect(page.locator('#vtError')).toContainText('did not accept this key');

  await page.locator('#vtKey').fill(GOOD_KEY);
  await page.locator('#vtForm').getByRole('button', { name: 'Save and test' }).click();
  await expect(page.locator('#vtState')).toHaveText('On');
  await expect(page.locator('#secTitle')).toHaveText('Protected: on your device and online');
  await expect(page.locator('#vtKey')).toHaveValue('');
  expect((await worker.evaluate(() => (globalThis as Ext).chrome.storage.local.get('virusTotalKey'))).virusTotalKey).toBe(GOOD_KEY);
  // The page never holds the key: not in its inputs, not in its text.
  expect(await page.content()).not.toContain(GOOD_KEY);
  expect(scanners.requests.at(-1)?.key).toBe(GOOD_KEY);

  await page.getByRole('button', { name: 'Remove key' }).first().click();
  await expect(page.locator('#vtState')).toHaveText('Off');
});
