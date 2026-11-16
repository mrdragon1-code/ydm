/**
 * Is a download safe? A verdict from checks on the device (always on,
 * nothing leaves the computer) and, only if the user entered their own
 * free API key, from public malware databases.
 *
 * Online, YDM sends only the file's SHA-256 and the download's address,
 * never the file. Keys belong to the user: YDM ships none, runs no server,
 * and the free tiers of these services allow personal, non-commercial use.
 *
 * Everything here is pure: the network comes in as `fetcher`, so the tests
 * stand in for the services.
 */

import type { Text } from './i18n';

export type Level = 'clean' | 'unknown' | 'suspicious' | 'malicious';

export interface Finding {
  /** `unknown`: a service did not answer in time, so the file is unchecked. */
  level: Exclude<Level, 'clean'>;
  /** What the user reads: the cause, in plain words. */
  reason: Text;
  source: Source;
}

export type Source = 'local' | 'virustotal' | 'urlhaus' | 'malwarebazaar';

export interface Verdict {
  level: Level;
  findings: Finding[];
  /** Services that answered; the rest could not be asked. */
  checked: Source[];
  /** For a link to the full report. */
  sha256?: string;
  at: number;
}

const ORDER: Level[] = ['clean', 'unknown', 'suspicious', 'malicious'];

export function worst(a: Level, b: Level): Level {
  return ORDER.indexOf(a) >= ORDER.indexOf(b) ? a : b;
}

/** Combines findings: the worst one decides. With no finding, `clean` if
 * at least one online service answered or only local checks were asked,
 * else `unknown` (a service was asked and none could answer). */
export function decide(findings: Finding[], checked: Source[], askedOnline: boolean, sha256?: string): Verdict {
  let level: Level = askedOnline && !checked.some((s) => s !== 'local') ? 'unknown' : 'clean';
  for (const f of findings) level = worst(level, f.level);
  return { level, findings, checked, sha256, at: Date.now() };
}

// --- on the device ------------------------------------------------------------

/** Extensions Windows, macOS or Linux run directly. */
const RUNS = new Set([
  'exe', 'msi', 'msix', 'com', 'scr', 'pif', 'cpl', 'bat', 'cmd', 'ps1', 'vbs', 'vbe', 'js', 'jse',
  'wsf', 'wsh', 'hta', 'lnk', 'reg', 'jar', 'dll', 'apk', 'sh', 'run', 'appimage',
]);

/** Kinds people open without thinking twice: a program wearing one of
 * these names is the classic disguise. */
const LOOKS_HARMLESS = new Set([
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'rtf', 'odt', 'csv',
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'heic',
  'mp3', 'wav', 'flac', 'mp4', 'mkv', 'avi', 'mov', 'webm',
]);

function extOf(name: string): string {
  return /\.([a-z0-9]{1,10})$/i.exec(name)?.[1]?.toLowerCase() ?? '';
}

/** What a download's address says, before a byte is fetched. */
export function checkUrl(raw: string): Finding[] {
  const out: Finding[] = [];
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return out;
  }
  const add = (level: Finding['level'], key: string, params?: Text['params']) =>
    out.push({ level, reason: { key: `security.local.${key}`, params }, source: 'local' });
  const host = url.hostname;
  // A name and password in the address: hides the real site behind "@".
  if (url.username || url.password) add('suspicious', 'credentials', { host });
  // Lookalike letters from another alphabet, written as xn-- by the browser.
  if (host.split('.').some((label) => label.startsWith('xn--'))) add('suspicious', 'punycode', { host });
  const ipv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  const ipv6 = host.startsWith('[');
  // Real sites have names; bare numbers are typical of malware hosting.
  // Not this computer, the home or office network, or the carrier's.
  if ((ipv4 || ipv6) && !isLocalIp(host)) add('suspicious', 'ipHost', { host });
  return out;
}

/** An address on this computer or a private network: a NAS, a router, a
 * development server. Not the open internet. */
export function isLocalIp(host: string): boolean {
  if (host.startsWith('[')) {
    const v6 = host.slice(1, -1).toLowerCase();
    return (
      v6 === '::1' ||
      v6 === '::' ||
      /^fe[89ab][0-9a-f]:/.test(v6) || // link-local fe80::/10
      /^f[cd][0-9a-f]{2}:/.test(v6) || // unique local fc00::/7
      /^::ffff:(127|10|192\.168)\./.test(v6)
    );
  }
  const [a, b] = host.split('.').map(Number) as [number, number];
  return (
    a === 127 || // this computer
    a === 10 ||
    a === 0 || // 0.0.0.0, "this computer" for local servers
    (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 169 && b === 254) || // link-local: routers, printers
    (a === 100 && b >= 64 && b <= 127) // carrier-grade NAT, Tailscale
  );
}

/** What a file's name says. */
export function checkName(name: string): Finding[] {
  const out: Finding[] = [];
  const ext = extOf(name);
  const before = extOf(name.slice(0, name.length - ext.length - 1));
  // "invoice.pdf.exe": Windows hides the last part, so it looks like a PDF.
  if (RUNS.has(ext) && LOOKS_HARMLESS.has(before)) {
    out.push({
      level: 'suspicious',
      reason: { key: 'security.local.doubleExtension', params: { name, looks: before, is: ext } },
      source: 'local',
    });
  }
  return out;
}

/** What kind of file the first bytes say it is, whatever its name. */
export function sniff(head: Uint8Array): 'windows' | 'linux' | 'mac' | 'script' | null {
  const b = head;
  if (b[0] === 0x4d && b[1] === 0x5a) return 'windows'; // MZ
  if (b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46) return 'linux'; // ELF
  const mach = (b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!;
  if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe].includes(mach >>> 0)) return 'mac';
  if (b[0] === 0x23 && b[1] === 0x21) return 'script'; // #!
  return null;
}

/** A program that pretends to be a document, a picture or a video. */
export function checkContent(name: string, head: Uint8Array): Finding[] {
  const kind = sniff(head);
  const ext = extOf(name);
  if (!kind || !LOOKS_HARMLESS.has(ext)) return [];
  return [
    {
      level: 'suspicious',
      reason: { key: 'security.local.disguised', params: { name, looks: ext } },
      source: 'local',
    },
  ];
}

// --- online, with the user's own key -------------------------------------------

export interface Keys {
  virusTotal?: string;
  abuseCh?: string;
}

export interface Endpoints {
  virusTotal: string;
  urlhaus: string;
  malwareBazaar: string;
}

export const ENDPOINTS: Endpoints = {
  virusTotal: 'https://www.virustotal.com/api/v3',
  urlhaus: 'https://urlhaus-api.abuse.ch/v1',
  malwareBazaar: 'https://mb-api.abuse.ch/api/v1',
};

/** Engines that must agree before a file counts as a known virus: one or
 * two alone are often false alarms on new or rare programs. */
export const MALICIOUS_AT = 3;

type Fetch = typeof fetch;

interface Stats {
  malicious?: number;
  suspicious?: number;
  harmless?: number;
  undetected?: number;
}

/** A VirusTotal analysis, as a finding. `null`: nothing to report. */
export function fromVirusTotal(stats: Stats, what: 'file' | 'url'): Finding | null {
  const bad = stats.malicious ?? 0;
  const odd = stats.suspicious ?? 0;
  const total = bad + odd + (stats.harmless ?? 0) + (stats.undetected ?? 0);
  const params = { count: bad, total };
  if (bad >= MALICIOUS_AT) return { level: 'malicious', reason: { key: `security.vt.${what}Malicious`, params }, source: 'virustotal' };
  if (bad > 0 || odd > 0) {
    return { level: 'suspicious', reason: { key: `security.vt.${what}Suspicious`, params: { count: bad + odd, total } }, source: 'virustotal' };
  }
  return null;
}

/** VirusTotal's id for an address: base64url, without padding. */
export function urlId(url: string): string {
  const bytes = new TextEncoder().encode(url);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** How long a service may take before the user is asked instead. */
export const TIMEOUT_MS = 15_000;

/** A service that did not answer in time. */
export const TIMED_OUT = Symbol('timed out');
type TimedOut = typeof TIMED_OUT;

const request = (fetcher: Fetch, url: string, init: RequestInit, timeout = TIMEOUT_MS) =>
  fetcher(url, {
    ...init,
    credentials: 'omit',
    cache: 'no-store',
    referrerPolicy: 'no-referrer',
    signal: AbortSignal.timeout(timeout),
  });

/** A failed request: too slow, or simply unavailable (offline, refused). */
const failure = (e: unknown): TimedOut | null =>
  e instanceof DOMException && (e.name === 'TimeoutError' || e.name === 'AbortError') ? TIMED_OUT : null;

/** `undefined`: the service could not answer (offline, limit, bad key). */
async function vtLookup(fetcher: Fetch, base: string, key: string, path: string, timeout?: number): Promise<Stats | null | undefined | TimedOut> {
  const res = await request(fetcher, `${base}/${path}`, { headers: { 'x-apikey': key } }, timeout).catch(failure);
  if (res === TIMED_OUT) return TIMED_OUT;
  if (!res) return undefined;
  if (res.status === 404) return null; // never seen: nothing known against it
  if (!res.ok) return undefined;
  const body = (await res.json().catch(() => null)) as { data?: { attributes?: { last_analysis_stats?: Stats } } } | null;
  return body?.data?.attributes?.last_analysis_stats ?? null;
}

async function abuseLookup(
  fetcher: Fetch,
  url: string,
  key: string,
  form: Record<string, string>,
  timeout?: number,
): Promise<Record<string, unknown> | undefined | TimedOut> {
  const res = await request(
    fetcher,
    url,
    {
      method: 'POST',
      headers: { 'Auth-Key': key, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    },
    timeout,
  ).catch(failure);
  if (res === TIMED_OUT) return TIMED_OUT;
  if (!res?.ok) return undefined;
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  const status = body?.query_status ?? body?.query_staus;
  // A refused or broken query is "could not answer", not "clean".
  if (!body || (status !== 'ok' && status !== 'no_results' && status !== 'hash_not_found')) return undefined;
  return body;
}

export interface Lookup {
  findings: Finding[];
  checked: Source[];
}

const NAMES: Record<Exclude<Source, 'local'>, string> = {
  virustotal: 'VirusTotal',
  urlhaus: 'URLhaus',
  malwarebazaar: 'MalwareBazaar',
};

function timedOut(source: Exclude<Source, 'local'>): Finding {
  return { level: 'unknown', reason: { key: 'security.timeout', params: { service: NAMES[source] } }, source };
}

/** Whether a service ran out of time: the answer is incomplete. */
export function incomplete(findings: Finding[]): boolean {
  return findings.some((f) => f.level === 'unknown');
}

/** The address, before downloading. */
export async function lookUpUrl(url: string, keys: Keys, fetcher: Fetch = fetch, at: Endpoints = ENDPOINTS, timeout = TIMEOUT_MS): Promise<Lookup> {
  const findings: Finding[] = [];
  const checked: Source[] = [];
  const jobs: Promise<void>[] = [];
  if (keys.virusTotal) {
    jobs.push(
      vtLookup(fetcher, at.virusTotal, keys.virusTotal, `urls/${urlId(url)}`, timeout).then((stats) => {
        if (stats === TIMED_OUT) return void findings.push(timedOut('virustotal'));
        if (stats === undefined) return;
        checked.push('virustotal');
        const f = stats && fromVirusTotal(stats, 'url');
        if (f) findings.push(f);
      }),
    );
  }
  if (keys.abuseCh) {
    jobs.push(
      abuseLookup(fetcher, `${at.urlhaus}/url/`, keys.abuseCh, { url }, timeout).then((body) => {
        if (body === TIMED_OUT) return void findings.push(timedOut('urlhaus'));
        if (!body) return;
        checked.push('urlhaus');
        if (body.query_status === 'ok' && body.threat === 'malware_download') {
          findings.push({ level: 'malicious', reason: { key: 'security.urlhaus.malware' }, source: 'urlhaus' });
        }
      }),
    );
  }
  await Promise.all(jobs);
  return { findings, checked };
}

/** The finished file, by its SHA-256. */
export async function lookUpHash(sha256: string, keys: Keys, fetcher: Fetch = fetch, at: Endpoints = ENDPOINTS, timeout = TIMEOUT_MS): Promise<Lookup> {
  const findings: Finding[] = [];
  const checked: Source[] = [];
  const jobs: Promise<void>[] = [];
  if (keys.virusTotal) {
    jobs.push(
      vtLookup(fetcher, at.virusTotal, keys.virusTotal, `files/${sha256}`, timeout).then((stats) => {
        if (stats === TIMED_OUT) return void findings.push(timedOut('virustotal'));
        if (stats === undefined) return;
        checked.push('virustotal');
        const f = stats && fromVirusTotal(stats, 'file');
        if (f) findings.push(f);
      }),
    );
  }
  if (keys.abuseCh) {
    jobs.push(
      abuseLookup(fetcher, `${at.malwareBazaar}/`, keys.abuseCh, { query: 'get_info', hash: sha256 }, timeout).then((body) => {
        if (body === TIMED_OUT) return void findings.push(timedOut('malwarebazaar'));
        if (!body) return;
        checked.push('malwarebazaar');
        if (body.query_status === 'ok') {
          const data = (body.data as { signature?: string | null }[] | undefined)?.[0];
          findings.push({
            level: 'malicious',
            reason: data?.signature
              ? { key: 'security.bazaar.knownNamed', params: { name: data.signature } }
              : { key: 'security.bazaar.known' },
            source: 'malwarebazaar',
          });
        }
      }),
    );
  }
  await Promise.all(jobs);
  return { findings, checked };
}

/** Whether a key works: one cheap lookup of a hash nobody has. */
export async function testKey(service: 'virusTotal' | 'abuseCh', key: string, fetcher: Fetch = fetch, at: Endpoints = ENDPOINTS): Promise<boolean> {
  const probe = '0'.repeat(64);
  if (service === 'virusTotal') {
    const res = await request(fetcher, `${at.virusTotal}/files/${probe}`, { headers: { 'x-apikey': key } }).catch(() => null);
    // 404: the key was accepted and the hash is unknown, as expected.
    return res?.status === 404 || res?.ok === true;
  }
  const body = await abuseLookup(fetcher, `${at.malwareBazaar}/`, key, { query: 'get_info', hash: probe });
  return body !== undefined && body !== TIMED_OUT;
}

// --- limits and memory ----------------------------------------------------------

/** VirusTotal's free tier: four requests a minute. Calls wait their turn. */
export class RateGate {
  private times: number[] = [];

  constructor(
    private readonly perMinute: number,
    private readonly now: () => number = Date.now,
    private readonly wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  /** How long to wait before one more request, 0 if none. */
  delay(): number {
    const now = this.now();
    this.times = this.times.filter((t) => now - t < 60_000);
    if (this.times.length < this.perMinute) return 0;
    return 60_000 - (now - this.times[0]!);
  }

  async take(): Promise<void> {
    for (let d = this.delay(); d > 0; d = this.delay()) await this.wait(d);
    this.times.push(this.now());
  }
}

/** Verdicts are remembered for a week: the same file or address is not
 * asked about again, which saves the free quota. */
export const CACHE_MS = 7 * 24 * 3600 * 1000;
export const CACHE_MAX = 2000;

export type Cache = Record<string, { at: number; findings: Finding[]; checked: Source[] }>;

export function cached(cache: Cache, key: string, now = Date.now()): Lookup | null {
  const hit = cache[key];
  return hit && now - hit.at < CACHE_MS ? { findings: hit.findings, checked: hit.checked } : null;
}

/** The cache with `key` added and the oldest entries dropped. */
export function remember(cache: Cache, key: string, lookup: Lookup, now = Date.now()): Cache {
  // An answer from nobody, or one cut short, is not worth keeping: next
  // time may work.
  if (!lookup.checked.length || incomplete(lookup.findings)) return cache;
  const next: Cache = { ...cache, [key]: { at: now, ...lookup } };
  const keys = Object.keys(next).filter((k) => now - next[k]!.at < CACHE_MS);
  keys.sort((a, b) => next[b]!.at - next[a]!.at);
  return Object.fromEntries(keys.slice(0, CACHE_MAX).map((k) => [k, next[k]!]));
}

/** The public report page, for "See on VirusTotal". */
export function reportUrl(sha256: string): string {
  return `https://www.virustotal.com/gui/file/${sha256}`;
}
