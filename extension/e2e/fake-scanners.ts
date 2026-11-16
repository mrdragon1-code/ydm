/**
 * A local stand-in for VirusTotal and abuse.ch, for the end-to-end tests.
 * The test build (`npm run build:e2e`) points YDM at it; release builds
 * cannot. Each test says which hashes and addresses are bad.
 */

import { createServer, type IncomingMessage, type Server } from 'node:http';

export const SCAN_PORT = 47871;
export const SCAN_BASE = `http://127.0.0.1:${SCAN_PORT}`;
export const GOOD_KEY = 'test-key-0123456789abcdef';

export interface Verdicts {
  /** sha256 → VirusTotal engines that flag it as malicious. */
  files?: Record<string, number>;
  /** Address → engines that flag it. */
  urls?: Record<string, number>;
  /** Answer everything with this status (a service down, a limit). */
  status?: number;
  /** Never answer: the service is too slow, YDM must give up and ask. */
  hang?: boolean;
}

export interface FakeScanners {
  set(v: Verdicts): void;
  /** Every request received, for "nothing was sent" checks. */
  requests: { path: string; key: string | undefined; body: string }[];
  close(): Promise<void>;
}

function body(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let s = '';
    req.on('data', (c) => (s += c));
    req.on('end', () => resolve(s));
  });
}

function decodeUrlId(id: string): string {
  return Buffer.from(id.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

export async function startFakeScanners(): Promise<FakeScanners> {
  let verdicts: Verdicts = {};
  const requests: FakeScanners['requests'] = [];
  const server: Server = createServer(async (req, res) => {
    const path = req.url ?? '';
    const text = await body(req);
    const key = (req.headers['x-apikey'] ?? req.headers['auth-key']) as string | undefined;
    requests.push({ path, key, body: text });
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (verdicts.hang) return; // left open until the client gives up
    if (verdicts.status) return json(verdicts.status, {});
    if (key !== GOOD_KEY) return json(401, { error: { code: 'WrongCredentialsError' } });
    const stats = (malicious: number) => ({
      data: { attributes: { last_analysis_stats: { malicious, suspicious: 0, harmless: 10, undetected: 60 - malicious } } },
    });
    const file = /^\/vt\/files\/([0-9a-f]{64})$/.exec(path)?.[1];
    if (file) {
      const n = verdicts.files?.[file];
      return n === undefined ? json(404, { error: { code: 'NotFoundError' } }) : json(200, stats(n));
    }
    const urlId = /^\/vt\/urls\/([\w-]+)$/.exec(path)?.[1];
    if (urlId) {
      const n = verdicts.urls?.[decodeUrlId(urlId)];
      return n === undefined ? json(404, { error: { code: 'NotFoundError' } }) : json(200, stats(n));
    }
    if (path.startsWith('/bazaar/')) return json(200, { query_status: 'hash_not_found' });
    if (path.startsWith('/urlhaus/')) return json(200, { query_status: 'no_results' });
    json(404, {});
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(SCAN_PORT, '127.0.0.1', resolve);
  });
  return {
    set(v) {
      verdicts = v;
    },
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
