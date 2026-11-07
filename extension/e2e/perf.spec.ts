import { chromium, expect, test } from '@playwright/test';
import { type ChildProcess, spawn } from 'node:child_process';
import path from 'node:path';

// Benchmarks, not run by default: `PERF=1 npx playwright test perf`.
// They time YDM on the local test server, where the network is not the
// limit, so they measure YDM's own overhead (writes, copies, messages).
const EXTENSION = path.resolve(import.meta.dirname, '../.output/chrome-mv3');
const SERVER = path.resolve(import.meta.dirname, '../../engine/target/release/ydm-testserver.exe');

test.skip(!process.env.PERF, 'set PERF=1 to run the benchmarks');

function serve(...args: string[]): Promise<{ url: string; process: ChildProcess }> {
  return new Promise((resolve, reject) => {
    const process = spawn(SERVER, ['--port', '0', ...args]);
    let out = '';
    process.on('error', reject);
    process.stdout.on('data', (c: Buffer) => {
      out += c.toString();
      const url = /serving \d+ MB at (\S+)/.exec(out)?.[1];
      if (url && /sha256/.test(out)) resolve({ url, process });
    });
  });
}

type Ext = typeof globalThis & {
  chrome: {
    downloads: { search(q: object): Promise<{ state: string; url: string }[]> };
    storage: { local: { get(k: string): Promise<{ items?: { state: string; elapsed?: number }[] }> } };
  };
};

for (const mb of [512]) {
  test(`${mb} MB from localhost, unthrottled`, async () => {
    test.setTimeout(300_000);
    const server = await serve('--size', String(mb), '--filename', 'perf.bin');
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: true,
      acceptDownloads: true,
      args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
    });
    try {
      const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
      const t = Date.now();
      await (await context.newPage()).goto(server.url).catch(() => {});
      // Saved: the browser finished copying YDM's file into Downloads.
      for (const deadline = Date.now() + 280_000; Date.now() < deadline; ) {
        const saved = await worker.evaluate(() => (globalThis as Ext).chrome.downloads.search({ state: 'complete' }));
        if (saved.some((d) => d.url.startsWith('blob:'))) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      const total = (Date.now() - t) / 1000;
      let item: { state: string; elapsed?: number } | undefined;
      for (const deadline = Date.now() + 5000; item?.state !== 'completed' && Date.now() < deadline; ) {
        const { items } = await worker.evaluate(() => (globalThis as Ext).chrome.storage.local.get('items'));
        item = items?.[0];
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(item?.state).toBe('completed');
      const transfer = (item!.elapsed ?? 0) / 1000;
      console.log(
        `${mb} MB: transfer ${transfer.toFixed(2)} s (${(mb / transfer).toFixed(0)} MB/s), ` +
          `until saved ${total.toFixed(2)} s`,
      );
    } finally {
      await context.close();
      server.process.kill();
    }
  });
}
