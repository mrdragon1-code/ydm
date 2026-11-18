import { type BrowserContext, chromium, test as base, expect, type Worker } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { ydmWorker } from './ready';

// Sorting into folders inside Downloads (by kind, by rules) and links in
// series. Playwright stores downloads under random names, so the tests
// check the path YDM asks the browser for: they watch its calls to
// downloads.download.

const EXTENSION = path.resolve(import.meta.dirname, '../.output/chrome-mv3');

type Ext = typeof globalThis & {
  chrome: {
    storage: { local: { set(v: object): Promise<void>; get(k: string): Promise<Record<string, unknown>> } };
    downloads: { download(o: { filename?: string }): Promise<number> };
  };
  asked?: (string | null)[];
};

function startSite(): Promise<{ base: string; server: Server }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    const size = Number(url.searchParams.get('kb') ?? 6 * 1024) * 1024;
    const name = path.basename(url.pathname);
    res.writeHead(200, {
      'Content-Type': name.endsWith('.mp4') ? 'video/mp4' : 'application/octet-stream',
      'Content-Length': size,
      'Content-Disposition': `attachment; filename="${name}"`,
      'Accept-Ranges': 'none',
    });
    if (!url.searchParams.has('slow')) return void res.end(Buffer.alloc(size, 1));
    // About 1 MB/s: long enough to cancel it halfway.
    let sent = 0;
    const timer = setInterval(() => {
      const n = Math.min(64 * 1024, size - sent);
      res.write(Buffer.alloc(n, 1));
      sent += n;
      if (sent >= size) {
        clearInterval(timer);
        res.end();
      }
    }, 60);
    res.on('close', () => clearInterval(timer));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server })));
}

const test = base.extend<{ context: BrowserContext; worker: Worker; id: string; site: string }>({
  site: async ({}, use) => {
    const { base, server } = await startSite();
    await use(base);
    server.close();
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
    const worker = await ydmWorker(context);
    // Every path YDM asks the browser to save to.
    await worker.evaluate(() => {
      const g = globalThis as Ext;
      const original = g.chrome.downloads.download.bind(g.chrome.downloads);
      g.asked = [];
      g.chrome.downloads.download = (o) => {
        g.asked!.push(o.filename ?? null);
        return original(o);
      };
    });
    await use(worker);
  },
  id: async ({ worker }, use) => use(new URL(worker.url()).host),
});

async function until<T>(get: () => Promise<T>, ok: (v: T) => boolean, ms = 30_000): Promise<T> {
  for (const deadline = Date.now() + ms; ; ) {
    const v = await get();
    if (ok(v)) return v;
    if (Date.now() > deadline) throw new Error(`timed out; last value: ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

const set = (worker: Worker, v: object) => worker.evaluate((v) => (globalThis as Ext).chrome.storage.local.set(v), v);
const asked = (worker: Worker) => worker.evaluate(() => (globalThis as Ext).asked ?? []);
const start = async (context: BrowserContext, url: string) => (await context.newPage()).goto(url).catch(() => {});

const FOLDERS = { video: 'Video', audio: 'Music', images: 'Images', documents: 'Documents', archives: 'Archives', programs: 'Programs' };

test('nothing moves while sorting is off', async ({ context, worker, site }) => {
  await start(context, `${site}/clip.mp4`);
  expect(await until(() => asked(worker), (a) => a.length > 0)).toEqual(['clip.mp4']);
});

test('files YDM saves go to their kind’s folder, rules first', async ({ context, worker, site }) => {
  await set(worker, { organize: true, folders: FOLDERS, rules: [{ kind: 'ext', match: 'iso', folder: 'Disks/Linux' }] });
  await start(context, `${site}/clip.mp4`);
  await start(context, `${site}/distro.iso`);
  const paths = await until(() => asked(worker), (a) => a.length >= 2);
  expect(paths.sort()).toEqual(['Disks/Linux/distro.iso', 'Video/clip.mp4']);
});

test('a site rule sends everything from that site to one folder', async ({ context, worker, site }) => {
  await set(worker, { organize: true, folders: FOLDERS, rules: [{ kind: 'site', match: '127.0.0.1', folder: 'Local' }] });
  await start(context, `${site}/clip.mp4`);
  expect(await until(() => asked(worker), (a) => a.length > 0)).toEqual(['Local/clip.mp4']);
});

test('a link with a range adds the whole series', async ({ context, worker, id, site }) => {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await popup.locator('#add').click();
  await popup.locator('#urls').fill(`${site}/part[1-3].bin?kb=6144`);
  await popup.getByRole('button', { name: 'Download', exact: true }).click();
  await expect(popup.locator('#addStatus')).toHaveText('3 downloads added');
  await until(
    async () => (((await worker.evaluate(() => (globalThis as Ext).chrome.storage.local.get('items'))).items ?? []) as { name: string }[]).map((i) => i.name).sort(),
    (names) => names.join() === 'part1.bin,part2.bin,part3.bin',
  );
});

test('the Folders settings: off by default; turned on, names in the interface language', async ({ context, worker, id }) => {
  await set(worker, { language: 'it' });
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/app.html#settings`);
  const toggle = page.getByLabel('Ordina in cartelle');
  await expect(toggle).not.toBeChecked();
  await expect(page.getByLabel('Cartella per Musica e audio')).toBeDisabled();
  await toggle.check();
  await expect(page.getByLabel('Cartella per Musica e audio')).toHaveValue('Musica');
  // A folder that would leave Downloads is refused.
  const docs = page.getByLabel('Cartella per Documenti');
  await docs.fill('../fuori');
  await docs.press('Tab');
  await expect(page.locator('#folderError')).toContainText('non utilizzabile');
  // A rule from a pasted address.
  await page.locator('#ruleMatch').fill('https://www.Example.com/file');
  await page.locator('#ruleFolder').fill('Esempio');
  await page.getByRole('button', { name: 'Aggiungi regola' }).click();
  await expect(page.locator('#rules li')).toContainText('example.com → Esempio');
  const stored = await worker.evaluate(() => (globalThis as Ext).chrome.storage.local.get('rules'));
  expect(stored.rules).toEqual([{ kind: 'site', match: 'example.com', folder: 'Esempio' }]);
});

test('the downloads page: kinds, Delete, "Retry failed", paste anywhere', async ({ context, worker, id, site }) => {
  await start(context, `${site}/clip.mp4`);
  await start(context, `${site}/report.pdf`);
  await until(() => asked(worker), (a) => a.length >= 2);
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/app.html#downloads`);
  const rows = page.locator('#list li');
  await expect(rows).toHaveCount(2);

  // One kind only, then all again.
  await page.locator('#kinds').getByRole('button', { name: 'Documents' }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText('report.pdf');
  await page.locator('#kinds').getByRole('button', { name: 'Documents' }).click();
  await expect(rows).toHaveCount(2);

  // Delete removes the focused row.
  const pdf = rows.filter({ hasText: 'report.pdf' });
  // Only a finished download can be removed (not while it is being saved).
  await expect(pdf).toHaveAttribute('data-state', 'completed');
  await pdf.click();
  await pdf.press('Delete');
  await expect(rows).toHaveCount(1);

  // A cancelled download comes back with "Retry failed".
  await start(context, `${site}/slow.bin?slow=1`);
  const slow = rows.filter({ hasText: 'slow.bin' });
  await expect(slow).toHaveAttribute('data-state', 'running');
  await slow.getByRole('button', { name: 'Cancel' }).click();
  await expect(slow).toHaveAttribute('data-state', 'cancelled');
  await page.getByRole('button', { name: 'Retry failed' }).click();
  await expect(slow).not.toHaveAttribute('data-state', 'cancelled');
  await expect(page.getByRole('button', { name: 'Retry failed' })).toBeHidden();

  // Links pasted outside any field land in "Add URLs".
  await page.locator('h1').first().click();
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.setData('text/plain', 'see https://example.com/a.zip');
    document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect(page.locator('#adder')).toBeVisible();
  await expect(page.locator('#urls')).toHaveValue('see https://example.com/a.zip');
});
