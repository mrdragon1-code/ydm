/**
 * Runs the security checks for the background: the checks on the device,
 * then (with the user's own key) the online lookups, through a cache and
 * VirusTotal's free-tier rate limit.
 */

import type { Settings } from './policy';
import {
  type Cache,
  cached,
  checkContent,
  checkName,
  checkUrl,
  decide,
  ENDPOINTS,
  type Endpoints,
  type Finding,
  type Keys,
  type Lookup,
  lookUpHash,
  lookUpUrl,
  RateGate,
  remember,
  type Source,
  type Verdict,
} from './security';

const CACHE_KEY = 'securityCache';

/** Test builds point the services at a local stand-in; release builds
 * cannot (the variable is empty there). Pages testing a key use it too. */
export function endpoints(): Endpoints {
  const base = import.meta.env.YDM_SCAN_BASE as string | undefined;
  if (!base) return ENDPOINTS;
  return { virusTotal: `${base}/vt`, urlhaus: `${base}/urlhaus`, malwareBazaar: `${base}/bazaar` };
}

export class Scanner {
  private gate = new RateGate(4);
  private cache: Cache | null = null;
  private readonly at = endpoints();

  constructor(private readonly fetcher: typeof fetch = (...args) => fetch(...args)) {}

  /** The address, when the download starts: local checks, then online. */
  async link(url: string, settings: Settings): Promise<Verdict> {
    const local = settings.scanLocal ? checkUrl(url) : [];
    const online = await this.online(`url:${url}`, settings, (keys) => lookUpUrl(url, keys, this.fetcher, this.at));
    return this.verdict(local, online, settings);
  }

  /** The finished file, before it reaches the Downloads folder. */
  async file(name: string, sha256: string | null, head: Uint8Array, settings: Settings): Promise<Verdict> {
    const local = settings.scanLocal ? [...checkName(name), ...checkContent(name, head)] : [];
    const online = sha256
      ? await this.online(`sha256:${sha256}`, settings, (keys) => lookUpHash(sha256, keys, this.fetcher, this.at))
      : { findings: [], checked: [] };
    return { ...this.verdict(local, online, settings, !!sha256), sha256: sha256 ?? undefined };
  }

  private verdict(local: Finding[], online: Lookup, settings: Settings, canAsk = true): Verdict {
    const checked: Source[] = settings.scanLocal ? ['local', ...online.checked] : online.checked;
    return decide([...local, ...online.findings], checked, canAsk && keysOf(settings) !== null);
  }

  private async online(key: string, settings: Settings, ask: (keys: Keys) => Promise<Lookup>): Promise<Lookup> {
    const keys = keysOf(settings);
    if (!keys) return { findings: [], checked: [] };
    const cache = await this.load();
    const hit = cached(cache, key);
    if (hit) return hit;
    // Only VirusTotal's free tier is this tight; abuse.ch is not limited so.
    if (keys.virusTotal) await this.gate.take();
    const found = await ask(keys).catch(() => ({ findings: [], checked: [] }) as Lookup);
    this.cache = remember(await this.load(), key, found);
    void browser.storage.local.set({ [CACHE_KEY]: this.cache }).catch(() => {});
    return found;
  }

  private async load(): Promise<Cache> {
    if (!this.cache) {
      const stored = await browser.storage.local.get(CACHE_KEY).catch(() => ({}));
      this.cache = ((stored as Record<string, unknown>)[CACHE_KEY] as Cache | undefined) ?? {};
    }
    return this.cache;
  }

  /** After a key changes, earlier answers may be from a service no longer asked. */
  async forget() {
    this.cache = {};
    await browser.storage.local.remove(CACHE_KEY).catch(() => {});
  }
}

function keysOf(settings: Settings): Keys | null {
  const keys: Keys = {};
  if (settings.virusTotalKey) keys.virusTotal = settings.virusTotalKey;
  if (settings.abuseChKey) keys.abuseCh = settings.abuseChKey;
  return keys.virusTotal || keys.abuseCh ? keys : null;
}
