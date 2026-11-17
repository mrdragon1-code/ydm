import { type BrowserContext, chromium, test as base, expect, type Page, type Worker } from '@playwright/test';
import { createCipheriv } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { ydmWorker } from './ready';

// Videos on pages: found while the page loads them, listed in the popup,
// downloaded as one MP4 (HLS streams joined and converted), protected
// streams refused. A local server plays the sites, with real (tiny) video.

const EXTENSION = path.resolve(import.meta.dirname, '../.output/chrome-mv3');
const FIXTURES = path.resolve(import.meta.dirname, 'fixtures');
const KEY = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
const TS = readdirSync(path.join(FIXTURES, 'hls-ts')).filter((f) => f.endsWith('.m2ts')).length;

type Ext = typeof globalThis & {
  chrome: {
    downloads: { search(q: object): Promise<{ url: string; filename: string; state: string }[]> };
    storage: {
      session: { get(k: string): Promise<Record<string, unknown>> };
      local: { get(k: string): Promise<Record<string, unknown>> };
    };
    tabs: { query(q: object): Promise<{ id: number; url: string }[]> };
  };
};

interface Site {
  base: string;
  /** Requests per path, to tell what was fetched again. */
  hits: Map<string, number>;
  slow: boolean;
}

function startSite(): Promise<{ site: Site; server: Server }> {
  const site: Site = { base: '', hits: new Map(), slow: false };
  const fixture = (p: string) => readFileSync(path.join(FIXTURES, p));
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://x');
    const p = url.pathname;
    site.hits.set(p, (site.hits.get(p) ?? 0) + 1);
    const send = (type: string, body: Buffer | string) => {
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
      res.end(body);
    };
    const page = (title: string, body: string) => send('text/html', `<!doctype html><title>${title}</title><body>${body}</body>`);
    if (p === '/page-direct') return page('Holiday clip', '<video src="/movie.mp4" muted autoplay></video>');
    // A player fetching its playlist, as hls.js does.
    if (p === '/page-stream') return page(url.searchParams.get('title') ?? 'Stream', `<script>fetch(${JSON.stringify(url.searchParams.get('src'))})</script>`);
    if (p === '/movie.mp4') return send('video/mp4', Buffer.concat([fixture('hls-fmp4/init.mp4'), Buffer.alloc(1200 * 1024, 7)]));
    // A CDN on another host that serves only to the site's own pages.
    if (p === '/cdn/index.m3u8') {
      const port = (server.address() as AddressInfo).port;
      return send('application/vnd.apple.mpegurl', fixture('hls-ts/index.m3u8').toString().replace(/^seg/gm, `http://localhost:${port}/guarded/seg`));
    }
    const guarded = /^\/guarded\/(seg\d+\.m2ts)$/.exec(p);
    if (guarded) {
      if (!(req.headers.referer ?? '').startsWith(site.base)) return void res.writeHead(403).end();
      return send('video/mp2t', fixture(`hls-ts/${guarded[1]}`));
    }
    if (p === '/master.m3u8') {
      return send('application/vnd.apple.mpegurl', '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=120000,RESOLUTION=160x90,CODECS="avc1.42c00c,mp4a.40.2"\n/hls-ts/index.m3u8\n');
    }
    if (p === '/drm/index.m3u8') {
      return send('application/vnd.apple.mpegurl', '#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://k",KEYFORMAT="com.apple.streamingkeydelivery"\n#EXTINF:1,\n/hls-ts/seg0.m2ts\n#EXT-X-ENDLIST\n');
    }
    if (p === '/enc/index.m3u8') {
      const plain = fixture('hls-ts/index.m3u8').toString();
      return send('application/vnd.apple.mpegurl', plain.replace('#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-KEY:METHOD=AES-128,URI="/enc/key"'));
    }
    if (p === '/enc/key') return send('application/octet-stream', KEY);
    const enc = /^\/enc\/seg(\d+)\.m2ts$/.exec(p);
    if (enc) {
      // No IV in the playlist: the segment's sequence number is the IV.
      const iv = Buffer.alloc(16);
      iv.writeUInt32BE(Number(enc[1]), 12);
      const cipher = createCipheriv('aes-128-cbc', KEY, iv);
      return send('video/mp2t', Buffer.concat([cipher.update(fixture(`hls-ts/seg${enc[1]}.m2ts`)), cipher.final()]));
    }
    const file = /^\/(hls-ts|hls-fmp4)\/([\w.]+)$/.exec(p);
    if (file) {
      if (site.slow && file[2]!.startsWith('seg')) await new Promise((r) => setTimeout(r, 700));
      const type = file[2]!.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : file[2]!.endsWith('.m2ts') ? 'video/mp2t' : 'video/mp4';
      return send(type, fixture(`${file[1]}/${file[2]}`));
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      site.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve({ site, server });
    }),
  );
}

const test = base.extend<{ context: BrowserContext; worker: Worker; id: string; site: Site }>({
  site: async ({}, use) => {
    const { site, server } = await startSite();
    await use(site);
    server.closeAllConnections();
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
  worker: async ({ context }, use) => use(await ydmWorker(context)),
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

/** The tab showing `url`, once YDM has listed a video for it. */
async function tabWithVideos(worker: Worker, url: string): Promise<number> {
  const [tab] = await worker.evaluate((url) => (globalThis as Ext).chrome.tabs.query({ url }), url);
  const id = tab!.id;
  await until(
    () => worker.evaluate((key) => (globalThis as Ext).chrome.storage.session.get(key), `media:${id}`),
    (v) => Array.isArray(v[`media:${id}`]) && (v[`media:${id}`] as unknown[]).length > 0,
  );
  return id;
}

async function popupFor(context: BrowserContext, id: string, tabId: number): Promise<Page> {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html#tab=${tabId}`);
  await expect(popup.locator('#videos')).toBeVisible();
  return popup;
}

/** The name YDM saved it under (Playwright stores downloads under random names). */
async function ydmName(worker: Worker): Promise<string> {
  const [item] = await until(
    async () => ((await worker.evaluate(() => (globalThis as Ext).chrome.storage.local.get('items'))).items ?? []) as { name: string; state: string }[],
    (items) => items[0]?.state === 'completed',
  );
  return item!.name;
}

async function savedFile(worker: Worker): Promise<{ filename: string; bytes: Buffer }> {
  const [d] = await until(
    () => worker.evaluate(() => (globalThis as Ext).chrome.downloads.search({})),
    (list) => list.some((d) => d.url.startsWith('blob:') && d.state === 'complete'),
    60_000,
  ).then((list) => list.filter((d) => d.url.startsWith('blob:') && d.state === 'complete'));
  return { filename: d!.filename, bytes: readFileSync(d!.filename) };
}

/** Top-level MP4 boxes, and the number of tracks in the movie box. */
function mp4Structure(b: Buffer): { boxes: string[]; tracks: number } {
  const boxes: string[] = [];
  let tracks = 0;
  for (let at = 0; at + 8 <= b.length; ) {
    const size = b.readUInt32BE(at);
    const type = b.toString('latin1', at + 4, at + 8);
    if (size < 8 || at + size > b.length) break;
    boxes.push(type);
    if (type === 'moov') {
      for (let inner = at + 8; inner + 8 <= at + size; inner += b.readUInt32BE(inner) || size) {
        if (b.toString('latin1', inner + 4, inner + 8) === 'trak') tracks++;
      }
    }
    at += size;
  }
  return { boxes, tracks };
}

test('a video file on a page is listed with its size and downloaded as it is', async ({ context, worker, id, site }) => {
  const page = await context.newPage();
  await page.goto(`${site.base}/page-direct`);
  const tabId = await tabWithVideos(worker, `${site.base}/page-direct`);
  const popup = await popupFor(context, id, tabId);
  const row = popup.locator('#videoList li');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('Holiday clip');
  await expect(row).toContainText(/1\.\d MB/);
  await row.getByRole('button', { name: 'Download' }).click();
  await expect(row.getByRole('button', { name: 'Added' })).toBeDisabled();
  const { bytes } = await savedFile(worker);
  expect(await ydmName(worker)).toBe('Holiday clip.mp4');
  expect(bytes.length).toBe(readFileSync(path.join(FIXTURES, 'hls-fmp4/init.mp4')).length + 1200 * 1024);
});

test('an HLS stream is listed by quality and saved as one playable MP4', async ({ context, worker, id, site }) => {
  const page = await context.newPage();
  const at = `${site.base}/page-stream?title=Concert&src=/master.m3u8`;
  await page.goto(at);
  const tabId = await tabWithVideos(worker, at);
  const popup = await popupFor(context, id, tabId);
  const row = popup.locator('#videoList li');
  // One entry for the stream, not one per quality playlist.
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('Concert');
  await expect(row).toContainText('90p');
  await row.getByRole('button', { name: 'Download' }).click();
  const { bytes } = await savedFile(worker);
  expect(await ydmName(worker)).toBe('Concert.mp4');
  const mp4 = mp4Structure(bytes);
  expect(mp4.boxes.slice(0, 2)).toEqual(['ftyp', 'moov']);
  expect(mp4.boxes).toContain('moof');
  expect(mp4.tracks).toBe(2); // video and audio
  // Every segment fetched once.
  for (let i = 0; i < TS; i++) expect(site.hits.get(`/hls-ts/seg${i}.m2ts`), `seg${i}`).toBe(1);
});

test("a stream whose pieces are on a hotlink-protected CDN gets the page's Referer there too", async ({ context, worker, id, site }) => {
  const page = await context.newPage();
  const at = `${site.base}/page-stream?title=Guarded&src=/cdn/index.m3u8`;
  await page.goto(at);
  const tabId = await tabWithVideos(worker, at);
  const popup = await popupFor(context, id, tabId);
  await popup.locator('#videoList li').getByRole('button', { name: 'Download' }).click();
  const { bytes } = await savedFile(worker);
  expect(mp4Structure(bytes).tracks).toBe(2);
  for (let i = 0; i < TS; i++) expect(site.hits.get(`/guarded/seg${i}.m2ts`), `seg${i}`).toBe(1);
});

test('a pasted AES-128 stream link is decrypted and converted', async ({ context, worker, id, site }) => {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await popup.locator('#add').click();
  await popup.locator('#urls').fill(`${site.base}/enc/index.m3u8`);
  await popup.getByRole('button', { name: 'Download', exact: true }).click();
  const { bytes } = await savedFile(worker);
  const mp4 = mp4Structure(bytes);
  expect(mp4.boxes.slice(0, 2)).toEqual(['ftyp', 'moov']);
  expect(mp4.tracks).toBe(2);
  expect(site.hits.get('/enc/key')).toBe(1); // the key, once
});

test('an fMP4 stream is joined byte for byte', async ({ context, worker, id, site }) => {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await popup.locator('#add').click();
  await popup.locator('#urls').fill(`${site.base}/hls-fmp4/index.m3u8`);
  await popup.getByRole('button', { name: 'Download', exact: true }).click();
  const { bytes } = await savedFile(worker);
  const dir = path.join(FIXTURES, 'hls-fmp4');
  const segments = readdirSync(dir).filter((f) => f.endsWith('.m4s')).length;
  const expected = Buffer.concat([readFileSync(path.join(dir, 'init.mp4')), ...Array.from({ length: segments }, (_, i) => readFileSync(path.join(dir, `seg${i}.m4s`)))]);
  expect(bytes.equals(expected)).toBe(true);
});

test('a protected (DRM) stream is shown as such and cannot be downloaded', async ({ context, worker, id, site }) => {
  const page = await context.newPage();
  const at = `${site.base}/page-stream?title=Premium&src=/drm/index.m3u8`;
  await page.goto(at);
  const tabId = await tabWithVideos(worker, at);
  const popup = await popupFor(context, id, tabId);
  const row = popup.locator('#videoList li');
  await expect(row).toContainText('Protected (DRM)');
  await expect(row.getByRole('button', { name: 'Download' })).toBeDisabled();
});

test('a stream paused halfway resumes without fetching its segments again', async ({ context, worker, id, site }) => {
  test.setTimeout(90_000);
  site.slow = true;
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await popup.locator('#add').click();
  await popup.locator('#urls').fill(`${site.base}/hls-ts/index.m3u8`);
  await popup.getByRole('button', { name: 'Download', exact: true }).click();
  const row = popup.locator('#list li').first();
  await until(async () => [...site.hits.keys()].filter((k) => k.startsWith('/hls-ts/seg')).length, (n) => n >= 6);
  await row.getByRole('button', { name: 'Pause' }).click();
  await expect(row).toHaveAttribute('data-state', 'paused');
  await new Promise((r) => setTimeout(r, 1500));
  await row.getByRole('button', { name: 'Resume' }).click();
  const { bytes } = await savedFile(worker);
  expect(mp4Structure(bytes).tracks).toBe(2);
  // The first segments were on disk: not one of them was fetched twice.
  const twice = [...site.hits.entries()].filter(([k, n]) => k.startsWith('/hls-ts/seg') && n > 1).map(([k]) => k);
  expect(twice.length).toBeLessThanOrEqual(4); // at most the ones in flight at the pause
  expect(site.hits.get('/hls-ts/seg0.m2ts')).toBe(1);
});
