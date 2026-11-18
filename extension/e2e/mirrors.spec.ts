import { type BrowserContext, test as base, chromium, expect, type Worker } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { ydmWorker } from './ready';

// Mirrors (RFC 6249): the server names copies of its file on other
// servers and gives its SHA-256. YDM downloads from all of them at once,
// checks the result against the hash, and fetches again from the server
// itself whatever a bad mirror got wrong. Local servers on different ports
// play the download site and its mirrors.

const EXTENSION = path.resolve(import.meta.dirname, '../.output/chrome-mv3');
const SIZE = 24 << 20;
/** Bytes per second per connection: the origin alone can do 6 × this. */
const RATE = 256 << 10;

interface Host {
  url: string;
  /** Range requests received, and whether any came with cookies. */
  ranged: number;
  cookies: boolean;
  server: Server;
}

interface Options {
  data: Buffer;
  headers?: () => Record<string, string>;
  /** Sends every byte of its answers wrong. */
  corrupt?: boolean;
}

function host({ data, headers, corrupt }: Options): Promise<Host> {
  const h: Host = { url: '', ranged: 0, cookies: false, server: null! };
  h.server = createServer(async (req, res) => {
    if (req.headers.cookie) h.cookies = true;
    const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
    const from = m ? Number(m[1]) : 0;
    const to = m && m[2] ? Math.min(Number(m[2]), data.length - 1) : data.length - 1;
    if (m) h.ranged++;
    res.writeHead(m ? 206 : 200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': 'attachment; filename="distro.iso"',
      'Content-Length': to - from + 1,
      'Accept-Ranges': 'bytes',
      ETag: `"${h.url}"`, // every server its own, as real mirrors
      ...(m ? { 'Content-Range': `bytes ${from}-${to}/${data.length}` } : {}),
      ...(headers?.() ?? {}),
    });
    let closed = false;
    res.on('close', () => (closed = true));
    const chunk = 16 << 10;
    for (let at = from; at <= to && !closed; at += chunk) {
      let part = data.subarray(at, Math.min(at + chunk, to + 1));
      if (corrupt) part = Buffer.from(part.map((b) => b ^ 0xff));
      if (!res.write(part)) await new Promise((r) => res.once('drain', r));
      await new Promise((r) => setTimeout(r, (chunk / RATE) * 1000));
    }
    res.end();
  });
  return new Promise((resolve) =>
    h.server.listen(0, '127.0.0.1', () => {
      h.url = `http://127.0.0.1:${(h.server.address() as AddressInfo).port}/pub/distro.iso`;
      resolve(h);
    }),
  );
}

/** A download site with `mirrors` copies; `digest` is the SHA-256 it gives. */
async function site(mirrors: Omit<Options, 'data'>[], digest?: (sha: Buffer) => Buffer) {
  const data = randomBytes(SIZE);
  const sha = createHash('sha256').update(data).digest();
  const copies = await Promise.all(mirrors.map((o) => host({ data, ...o })));
  const origin = await host({
    data,
    headers: () => ({
      Link: copies.map((c, i) => `<${c.url}>; rel=duplicate; pri=${i + 1}`).join(', '),
      Digest: `SHA-256=${(digest ? digest(sha) : sha).toString('base64')}`,
    }),
  });
  return { origin, copies, sha: sha.toString('hex'), all: [origin, ...copies] };
}

const test = base.extend<{ context: BrowserContext; worker: Worker; hosts: Host[] }>({
  hosts: async ({}, use) => {
    const list: Host[] = [];
    await use(list);
    for (const h of list) {
      h.server.closeAllConnections();
      h.server.close();
    }
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
    await use(await ydmWorker(context));
  },
});

type Ext = typeof globalThis & {
  chrome: {
    downloads: {
      search(q: object): Promise<{ url: string; filename: string; state: string; byExtensionId?: string }[]>;
    };
    storage: { local: { get(k: string): Promise<Record<string, unknown>>; set(v: object): Promise<void> } };
  };
};

interface Stored {
  id: number;
  state: string;
  servers?: number;
  verified?: boolean;
}

/** The `nth` file YDM saved, once the browser has it all, and YDM's entry. */
async function finished(worker: Worker, nth = 1): Promise<{ sha: string; item: Stored; at: number }> {
  for (const deadline = Date.now() + 90_000; Date.now() < deadline; ) {
    const saved = (await worker.evaluate(() => (globalThis as Ext).chrome.downloads.search({ orderBy: ['startTime'] }))).filter(
      (d) => d.state === 'complete' && d.url.startsWith('blob:'),
    )[nth - 1];
    if (saved) {
      const at = Date.now();
      const sha = createHash('sha256').update(readFileSync(saved.filename)).digest('hex');
      // The entry is written a moment after it changes.
      for (const until = Date.now() + 5000; ; ) {
        const items = ((await worker.evaluate(() => (globalThis as Ext).chrome.storage.local.get('items'))).items ?? []) as Stored[];
        const item = items.filter((i) => i.state === 'completed').sort((a, b) => a.id - b.id)[nth - 1];
        if (item?.servers !== undefined || Date.now() > until) return { sha, item: item ?? { id: -1, state: '?' }, at };
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('download did not complete');
}

async function start(context: BrowserContext, url: string) {
  // The site's cookie: sent to the site, never to its mirrors.
  await context.addCookies([{ name: 'session', value: 'secret', domain: '127.0.0.1', path: '/' }]);
  await (await context.newPage()).goto(url).catch(() => {});
}

test('a file is downloaded from the server and its mirrors at once, and checked', async ({ context, worker, hosts }) => {
  // The same file from the server alone first, mirrors turned off.
  const alone = await site([{}, {}]);
  hosts.push(...alone.all);
  await worker.evaluate(() => (globalThis as Ext).chrome.storage.local.set({ mirrors: false }));
  const t0 = Date.now();
  await start(context, alone.origin.url);
  const one = await finished(worker);
  expect(one.item.servers).toBeUndefined();
  const single = (one.at - t0) / 1000;
  await worker.evaluate(() => (globalThis as Ext).chrome.storage.local.set({ mirrors: true }));

  const s = await site([{}, {}]);
  hosts.push(...s.all);
  const t = Date.now();
  await start(context, s.origin.url);
  const { sha, item, at } = await finished(worker, 2);
  expect(sha).toBe(s.sha);
  expect(item).toMatchObject({ servers: 3, verified: true });
  for (const m of s.copies) {
    expect(m.ranged).toBeGreaterThan(0);
    expect(m.cookies).toBe(false);
  }
  const seconds = (at - t) / 1000;
  console.log(`24 MB at 256 KB/s per connection: server alone ${single.toFixed(1)} s, with 2 mirrors ${seconds.toFixed(1)} s`);
  expect(seconds).toBeLessThan(single * 0.7);
});

test('what a bad mirror sent is fetched again from the server itself', async ({ context, worker, hosts }) => {
  const s = await site([{ corrupt: true }]);
  hosts.push(...s.all);
  await start(context, s.origin.url);
  const before = () => s.origin.ranged;
  const { sha, item } = await finished(worker);
  expect(sha).toBe(s.sha);
  expect(item).toMatchObject({ servers: 2, verified: true });
  expect(s.copies[0]!.ranged).toBeGreaterThan(0);
  expect(before()).toBeGreaterThan(1);
});

test('when the file does not match the hash the server gave, it is kept and says so', async ({ context, worker, hosts }) => {
  const s = await site([{}], (sha) => createHash('sha256').update(sha).digest());
  hosts.push(...s.all);
  await start(context, s.origin.url);
  const { sha, item } = await finished(worker);
  expect(sha).toBe(s.sha);
  expect(item).toMatchObject({ servers: 2, verified: false });
});

test('no hash, no mirrors: only the server itself is asked', async ({ context, worker, hosts }) => {
  const data = randomBytes(SIZE);
  const mirror = await host({ data });
  const origin = await host({ data, headers: () => ({ Link: `<${mirror.url}>; rel=duplicate` }) });
  hosts.push(origin, mirror);
  await start(context, origin.url);
  const { sha, item } = await finished(worker);
  expect(sha).toBe(createHash('sha256').update(data).digest('hex'));
  expect(mirror.ranged).toBe(0);
  expect(item.servers).toBeUndefined();
});
