import { type BrowserContext, test as base, chromium, expect, type Worker } from '@playwright/test';
import { type ChildProcess, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// The Mark-of-the-Web on a file YDM saved, compared with the same file saved
// by the browser alone. Chrome writes it in the same step that hands the file
// to the antivirus, so its presence also means the file was scanned.

const EXTENSION = path.resolve(import.meta.dirname, '../.output/chrome-mv3');
const SERVER = path.resolve(import.meta.dirname, '../../engine/target/release/ydm-testserver.exe');

interface Download {
  url: string;
  filename: string;
  state: string;
}

type ExtensionGlobal = typeof globalThis & {
  chrome: {
    downloads: { search(q: object): Promise<Download[]> };
    storage: { local: { set(v: object): Promise<void> } };
  };
};

const test = base.extend<{ context: BrowserContext; worker: Worker }>({
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
});

const downloads = (worker: Worker) =>
  worker.evaluate(() => (globalThis as ExtensionGlobal).chrome.downloads.search({}));
const settings = (worker: Worker, v: object) =>
  worker.evaluate((v) => (globalThis as ExtensionGlobal).chrome.storage.local.set(v), v);
const fromYdm = (d: Download) => d.url.startsWith('blob:chrome-extension://');
const fromBrowser = (d: Download) => d.url.startsWith('http');

/** Waits until a matching download stops. */
async function settled(worker: Worker, match: (d: Download) => boolean): Promise<Download> {
  for (const deadline = Date.now() + 60_000; Date.now() < deadline; ) {
    const found = (await downloads(worker)).find((d) => d.state !== 'in_progress' && match(d));
    if (found) return found;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('download did not settle');
}

async function start(context: BrowserContext, url: string) {
  await (await context.newPage()).goto(url).catch(() => {});
}

function zone(file: string): string | null {
  try {
    return readFileSync(`${file}:Zone.Identifier`, 'utf8');
  } catch {
    return null;
  }
}

test('files saved by YDM carry the Mark-of-the-Web, like the browser', async ({ context, worker }) => {
  const server: ChildProcess = spawn(SERVER, ['--port', '0', '--size', '6', '--filename', 'setup.exe']);
  const url = await new Promise<string>((resolve) => {
    let out = '';
    server.stdout!.on('data', (c) => {
      out += c;
      const m = /serving \d+ MB at (\S+)/.exec(out);
      if (m && /sha256/.test(out)) resolve(m[1]!);
    });
  });
  try {
    // A program: with the default settings it would go to the browser.
    await settings(worker, { programsToBrowser: false });
    await start(context, url);
    const ydm = await settled(worker, fromYdm);
    await settings(worker, { enabled: false });
    await start(context, url);
    const plain = await settled(worker, fromBrowser);

    console.log(`browser: ${JSON.stringify(zone(plain.filename))}`);
    console.log(`YDM:     ${JSON.stringify(zone(ydm.filename))}`);
    expect(plain.state).toBe('complete');
    expect(ydm.state).toBe('complete');
    expect(zone(ydm.filename)).toMatch(/ZoneId=3/);
  } finally {
    server.kill();
  }
});
