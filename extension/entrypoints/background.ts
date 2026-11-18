import type { Browser } from 'wxt/browser';
import { budgets, freshCaps, type HostCap, hostOf, mergeCap } from '@/lib/budget';
import { pickLocale, setLocale, t, useMachineTranslations } from '@/lib/i18n';
import { createLink } from '@/lib/link';
import { cachedTranslation } from '@/lib/translate';
import { type Available, CHECK_EVERY_MS, isNewer, latestRelease, updatesItself } from '@/lib/updates';
import { bytes } from '@/lib/ui/format';

// Translations made by a page with the browser's translator; the
// background itself cannot use that API.
useMachineTranslations(cachedTranslation);
import { fromUrl, sanitize } from '@/lib/naming';
import {
  DEFAULT_SETTINGS,
  describeSaveError,
  isProgram,
  migrateSettings,
  publicSettings,
  readSettings,
  SETTING_KEYS,
  type Settings,
  scansOnline,
  shouldIntercept,
} from '@/lib/policy';
import type { Checkpoint, EngineEvent, Item, PopupCommand, PopupState, Reason } from '@/lib/protocol';
import { Scanner } from '@/lib/scanner';
import { incomplete, type Verdict } from '@/lib/security';
import { parseMpd } from '@/lib/dash';
import { extOfName } from '@/lib/filetypes';
import { folderFor, withFolder } from '@/lib/folders';
import { type MediaFound, mediaKind, parsePlaylist, qualityOf } from '@/lib/media';

/** The engine page is closed after this long with nothing to do. */
const IDLE_CLOSE_MS = 30_000;
/** Finished downloads kept in the list. */
const HISTORY = 500;
/** Progress reaches open pages at most this often. */
const NOTIFY_MS = 250;
/** State changes are written to storage at most this often. */
const PERSIST_MS = 1000;
const POST_MEMORY_MS = 2 * 60_000;
/** How the browser names YDM as the initiator of its own requests. */
const EXTENSION_HOST = new URL(browser.runtime.getURL('/')).host;

interface Entry extends Item {
  url: string;
  /** A stream (HLS playlist, DASH manifest), joined into one MP4 by its own worker. */
  kind?: 'hls' | 'dash';
  /** Name the browser had chosen, if any. */
  hint?: string;
  /** Page the download came from; sent as Referer like the browser does. */
  referrer?: string;
  startedAt?: number;
  /** The browser download that saves the finished file. */
  downloadId?: number;
  sampledAt?: number;
  sampledDone?: number;
  /** Latest checkpoint, to resume after the browser is closed. */
  checkpoint?: Checkpoint;
  checkpointAt?: number;
  /** Transfer time of earlier runs, before a restart. */
  elapsedBefore?: number;
  /** Being stopped in YDM to go to the browser, for this reason. */
  toBrowser?: Reason;
  /** Being stopped by a pause: the partial file stays. */
  pausing?: boolean;
  /** Speed limit last sent to the engine. */
  limitSent?: number;
  /** Connection budget last sent to the engine. */
  connectionsSent?: number;
  /** Host the file comes from, after redirects. */
  host?: string;
  /** The address after redirects, the one the checks looked at. */
  finalUrl?: string;
  /** Allowed by the user despite a warning: not asked again. */
  allowed?: boolean;
  /** Being stopped because the address is a known virus. */
  blocking?: boolean;
  /** Being stopped, file kept, to ask the user. */
  holding?: boolean;
}

export default defineBackground(() => {
  const items = new Map<number, Entry>();
  let nextId = 0;
  let settings: Settings = { ...DEFAULT_SETTINGS };
  const popups = new Set<Browser.runtime.Port>();
  /** URLs we handed to the browser ourselves, so they are not taken back. */
  const handedBack = new Set<string>();
  /** URLs recently loaded by a form POST, which a plain GET cannot repeat. */
  const posted = new Map<string, number>();
  /** Browser download id → our id, for files being saved. */
  const saving = new Map<number, number>();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  /** Most connections each host accepted before refusing more. */
  let hostCaps: Record<string, HostCap> = {};
  /** A newer release, for copies that cannot update themselves. */
  let newerRelease: Available | null = null;
  /** Items changed since open pages last heard; null: send everything. */
  let dirty: Set<number> | null = null;
  let notifyTimer: ReturnType<typeof setTimeout> | undefined;
  let persistTimer: ReturnType<typeof setTimeout> | undefined;

  const link = createLink(onEngineEvent);
  const scanner = new Scanner();

  /** Settings changed while the stored ones were being read: they win
   * over what that read returned. Null once restored. */
  let early: Record<string, unknown> | null = {};

  // The list survives a service worker restart and the browser being closed.
  const restored = (async () => {
    const stored = await browser.storage.local.get([...SETTING_KEYS, 'items', 'nextId', 'hostCaps', 'settingsRev']);
    const migrated = migrateSettings(stored);
    if (migrated) {
      Object.assign(stored, migrated);
      void browser.storage.local.set(migrated);
    }
    hostCaps = freshCaps((stored.hostCaps as Record<string, HostCap>) ?? {});
    settings = readSettings({ ...stored, ...early });
    early = null;
    await applyLanguage();
    nextId = (stored.nextId as number) ?? 0;
    const engineAlive = await link.alive();
    const resumed: number[] = [];
    for (const entry of (stored.items as Entry[]) ?? []) {
      if (isActive(entry) && !engineAlive) {
        // Interrupted by closing the browser: queued again. The engine goes
        // on from the last checkpoint if the server still has the same file.
        if (entry.startedAt !== undefined && entry.checkpointAt !== undefined) {
          entry.elapsedBefore = (entry.elapsedBefore ?? 0) + Math.max(0, entry.checkpointAt - entry.startedAt);
        }
        entry.state = 'queued';
        entry.speed = 0;
        entry.downloadId = undefined;
        resumed.push(entry.id);
      }
      items.set(entry.id, entry);
    }
    if (resumed.length) {
      // Held ones keep their file too: "Download anyway" still needs it.
      const paused = [...items.values()].filter((i) => i.state === 'paused' || i.state === 'held').map((i) => i.id);
      await link.send({ type: 'prune', keep: [...resumed, ...paused] });
    }
    pump();
    void checkForUpdate();
    void checkInstalledVersion();
    // Referer rules of downloads that are no longer running.
    const rules = await browser.declarativeNetRequest.getSessionRules().catch(() => []);
    const stale = rules.map((r) => r.id).filter((id) => !isActive(items.get(id) ?? { state: 'failed' } as Item));
    if (stale.length) await browser.declarativeNetRequest.updateSessionRules({ removeRuleIds: stale }).catch(() => {});
    update();
  })();

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    // A page just translated YDM: the menu and notifications follow.
    if (changes.translated) void applyLanguage();
    if (!SETTING_KEYS.some((key) => changes[key])) return;
    const next: Record<string, unknown> = { ...settings };
    for (const key of SETTING_KEYS) {
      if (!changes[key]) continue;
      next[key] = changes[key].newValue;
      if (early) early[key] = changes[key].newValue;
    }
    const languageChanged = next.language !== settings.language;
    const keysChanged = next.virusTotalKey !== settings.virusTotalKey || next.abuseChKey !== settings.abuseChKey;
    settings = readSettings(next);
    if (keysChanged) void scanner.forget();
    if (languageChanged) void applyLanguage();
    // More downloads at once may now start.
    void restored.then(() => {
      pump();
      update();
    });
  });

  // --- taking over browser downloads -----------------------------------

  browser.downloads.onCreated.addListener((d) => void intercept(d));

  async function intercept(d: Browser.downloads.DownloadItem) {
    await restored;
    d = await withKnownSize(d);
    const url = d.finalUrl || d.url;
    pruneOld(posted, POST_MEMORY_MS);
    const ours = d.byExtensionId === browser.runtime.id || handedBack.delete(url);
    const candidate = {
      url,
      incognito: d.incognito,
      state: d.state,
      totalBytes: d.totalBytes,
      byUs: ours,
      fromPost: posted.has(url) || posted.has(d.url),
      name: baseName(d.filename),
      mime: d.mime,
    };
    if (!shouldIntercept(candidate, settings)) {
      // The ones the browser keeps (small files, programs, excluded sites):
      // their address is checked while the browser downloads them. Not
      // those YDM handed back: they were checked already.
      if (!ours && !d.incognito && settings.enabled && d.state === 'in_progress' && /^https?:/i.test(url)) {
        void guardBrowserDownload(d, url);
      }
      return;
    }
    try {
      await browser.downloads.cancel(d.id);
    } catch {
      return;
    }
    const [now] = await browser.downloads.search({ id: d.id });
    // Finished before we could take over: keep the browser's copy.
    if (now?.state === 'complete') return;
    await browser.downloads.erase({ id: d.id }).catch(() => {});
    enqueue(url, baseName(d.filename), d.referrer);
  }

  browser.webRequest.onBeforeRequest.addListener(
    (details) => {
      if (details.method === 'POST') posted.set(details.url, Date.now());
      return undefined;
    },
    { urls: ['<all_urls>'], types: ['main_frame', 'sub_frame'] },
  );

  // Wakes the service worker when the browser opens, to resume downloads.
  browser.runtime.onStartup.addListener(() => {});

  /** Loads the chosen language and labels the menu with it. */
  async function applyLanguage() {
    await setLocale(pickLocale(settings.language));
    await browser.contextMenus.removeAll();
    browser.contextMenus.create({ id: 'ydm', title: t('menu.link'), contexts: ['link'] });
    browser.contextMenus.create({ id: 'ydm-page', title: t('menu.page'), contexts: ['page'] });
    browser.contextMenus.create({ id: 'ydm-image', title: t('menu.image'), contexts: ['image'] });
  }

  /** The downloads page, listing the links of `tab` to pick from. */
  function openGrab(tabId: number) {
    void browser.tabs.create({ url: browser.runtime.getURL(`/app.html#downloads/grab=${tabId}`) });
  }

  browser.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId === 'ydm-page') {
      if (tab?.id !== undefined && !tab.incognito) openGrab(tab.id);
      return;
    }
    if (info.menuItemId === 'ydm-image') {
      // The downloads page reads it, on this computer, and lists its links.
      if (!info.srcUrl || tab?.incognito) return;
      // One key per image: two opened in quick succession do not mix.
      const id = crypto.randomUUID();
      await browser.storage.local.set({ [`ocr:${id}`]: { src: info.srcUrl, page: info.pageUrl } });
      void browser.tabs.create({ url: browser.runtime.getURL(`/app.html#downloads/ocr=${id}`) });
      return;
    }
    const url = info.linkUrl;
    if (!url || !/^https?:/i.test(url)) return;
    await restored;
    if (tab?.incognito) return void handBack(url);
    enqueue(url, undefined, info.pageUrl);
  });

  // --- videos on pages -------------------------------------------------------

  /** At most this many videos are listed per tab. */
  const MEDIA_MAX = 20;
  /** Smaller files are page decoration (loops, previews), not videos. */
  const MEDIA_MIN_BYTES = 1024 * 1024;
  /** Variant playlists already listed through their master, per tab. */
  const covered = new Map<number, Set<string>>();
  /** Addresses already looked at, per tab: a playing video requests the
   * same file again and again (ranges, seeks), a player its playlist. */
  const noted = new Map<number, Set<string>>();
  /** Changes to a tab's list, one after the other: none is lost. */
  const listChain = new Map<number, Promise<void>>();

  // Watching only: what the page loads is not changed or delayed.
  browser.webRequest.onHeadersReceived.addListener(
    (d) => {
      if (d.tabId < 0 || d.statusCode >= 400) return undefined;
      const header = (name: string) => d.responseHeaders?.find((h) => h.name.toLowerCase() === name)?.value ?? '';
      const kind = mediaKind(d.url, header('content-type'));
      if (kind) {
        // A file is the same whatever range or start time the player asks.
        const id = kind === 'direct' ? d.url.replace(/[?#].*$/, '') : d.url;
        const seen = noted.get(d.tabId) ?? new Set<string>();
        if (seen.has(id) || seen.size > 200) return undefined;
        seen.add(id);
        noted.set(d.tabId, seen);
        const total = Number(/\/(\d+)$/.exec(header('content-range'))?.[1] ?? header('content-length')) || null;
        void noteMedia(d.tabId, d.url, kind, total);
      }
      return undefined;
    },
    { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other'] },
    ['responseHeaders'],
  );

  const mediaKey = (tabId: number) => `media:${tabId}`;

  async function listed(tabId: number): Promise<MediaFound[]> {
    const key = mediaKey(tabId);
    return (((await browser.storage.session.get(key)) as Record<string, MediaFound[]>)[key] ?? []).slice();
  }

  /** A video the page loaded, added to its tab's list. */
  async function noteMedia(tabId: number, url: string, kind: 'direct' | 'hls' | 'dash', total: number | null) {
    if (covered.get(tabId)?.has(url)) return;
    const tab = await browser.tabs.get(tabId).catch(() => null);
    if (!tab || tab.incognito) return;
    let found: MediaFound | null;
    if (kind === 'direct') {
      if (total === null || total < MEDIA_MIN_BYTES) return;
      found = { url, kind, title: tab.title ?? '', quality: '', size: total, drm: false, page: tab.url };
    } else if (kind === 'dash') {
      found = await describeDash(url, tab.title ?? '', tab.url);
    } else {
      found = await describeStream(tabId, url, tab.title ?? '', tab.url);
    }
    // Described meanwhile as a quality of a stream already listed.
    if (!found || covered.get(tabId)?.has(url)) return;
    const entry = found;
    const change = (listChain.get(tabId) ?? Promise.resolve()).then(async () => {
      const list = (await listed(tabId)).filter((m) => m.url !== url && !covered.get(tabId)?.has(m.url));
      list.unshift(entry);
      await browser.storage.session.set({ [mediaKey(tabId)]: list.slice(0, MEDIA_MAX) }).catch(() => {});
    });
    listChain.set(tabId, change.catch(() => {}));
    await change;
  }

  /** What an HLS playlist offers: best quality, estimated size, protection. */
  async function describeStream(tabId: number, url: string, title: string, page?: string): Promise<MediaFound | null> {
    const read = async (u: string) => {
      const res = await fetch(u, { credentials: 'include', cache: 'force-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return parsePlaylist(await res.text(), res.url || u);
    };
    try {
      const p = await read(url);
      const base: MediaFound = { url, kind: 'hls', title, quality: '', size: null, drm: p.drm, page };
      if (p.type === 'media') return { ...base, live: !p.ended };
      // The variants are listed through their master, not one by one.
      const seen = covered.get(tabId) ?? new Set<string>();
      for (const v of p.variants) seen.add(v.url);
      covered.set(tabId, seen);
      const best = p.variants[0];
      if (!best) return null;
      const media = await read(best.url).catch(() => null);
      const seconds = media?.type === 'media' ? media.duration : 0;
      return {
        ...base,
        drm: p.drm || (media?.drm ?? false),
        live: media?.type === 'media' ? !media.ended : false,
        quality: qualityOf(best.height, best.bandwidth),
        size: seconds && best.bandwidth ? Math.round((best.bandwidth / 8) * seconds) : null,
      };
    } catch {
      return null;
    }
  }

  /** What a DASH manifest offers: best video and audio, size, or why not. */
  async function describeDash(url: string, title: string, page?: string): Promise<MediaFound | null> {
    try {
      const res = await fetch(url, { credentials: 'include', cache: 'force-cache' });
      if (!res.ok) return null;
      const mpd = parseMpd(await res.text(), res.url || url);
      const base: MediaFound = { url, kind: 'dash', title, quality: '', size: null, drm: false, page };
      if (!mpd.ok) {
        if (mpd.reason === 'drm') return { ...base, drm: true };
        if (mpd.reason === 'live') return { ...base, live: true };
        return { ...base, unsupported: mpd.reason === 'webm' ? 'webm' : mpd.reason === 'unreadable' ? 'notVideo' : 'notSupported' };
      }
      const rate = mpd.video.bandwidth + (mpd.audio?.bandwidth ?? 0);
      return {
        ...base,
        quality: qualityOf(mpd.video.height, rate),
        size: rate && mpd.duration ? Math.round((rate / 8) * mpd.duration) : null,
      };
    } catch {
      return null;
    }
  }

  // A new page in the tab, or the tab closed: its list is gone.
  browser.tabs.onUpdated.addListener((tabId, change) => {
    if (!change.url) return;
    covered.delete(tabId);
    noted.delete(tabId);
    void browser.storage.session.remove(mediaKey(tabId)).catch(() => {});
  });
  browser.tabs.onRemoved.addListener((tabId) => {
    covered.delete(tabId);
    noted.delete(tabId);
    listChain.delete(tabId);
    void browser.storage.session.remove(mediaKey(tabId)).catch(() => {});
  });

  // --- queue ------------------------------------------------------------

  function enqueue(url: string, hint?: string, referrer?: string, kind?: 'hls' | 'dash') {
    const id = ++nextId;
    items.set(id, {
      id,
      url,
      kind,
      hint,
      referrer: referrer || undefined,
      name: sanitize(hint || fromUrl(url) || ''),
      state: 'queued',
      done: 0,
      total: null,
      speed: 0,
    });
    trimHistory();
    pump();
    update();
  }

  function pump() {
    let running = [...items.values()].filter((i) => i.state === 'running').length;
    const starting: Entry[] = [];
    for (const item of items.values()) {
      if (running >= settings.parallel) break;
      if (item.state !== 'queued') continue;
      item.state = 'running';
      item.startedAt = Date.now();
      item.host = hostOf(item.url);
      item.connectionsSent = undefined;
      running++;
      starting.push(item);
    }
    const shares = connectionShares();
    for (const item of starting) {
      item.connectionsSent = shares.get(item.id) ?? settings.connections;
      void (async () => {
        await setReferrer(item, [item.url]);
        item.limitSent = share();
        await link.send({
          type: 'add',
          id: item.id,
          url: item.url,
          name: item.hint,
          connections: item.connectionsSent!,
          // What worked best on this host before: no slow ramp-up again.
          hint: hostCaps[item.host ?? hostOf(item.url)]?.best,
          mirrors: settings.mirrors,
          resume: item.checkpoint,
          limit: item.limitSent,
          checksum: settings.checksum,
          // Checked before the browser saves it; a file allowed by the user
          // after a warning about it is not held again.
          inspect: scans() && !(item.allowed && item.heldAt === 'file'),
          // Online lookups ask by hash: only then is it needed before saving.
          hashFirst: scansOnline(settings),
          kind: item.kind,
        });
      })();
    }
    applyLimits();
    applyConnections(shares);
  }

  /** Each running download's part of its host's six connections. */
  function connectionShares(): Map<number, number> {
    const running = [...items.values()]
      .filter((i) => i.state === 'running')
      .map((i) => ({ id: i.id, host: i.host ?? hostOf(i.url) }));
    return budgets(running, settings.connections, (host) => hostCaps[host]?.connections);
  }

  /** When downloads from a host start or stop, the others get a new share. */
  function applyConnections(shares = connectionShares()) {
    for (const item of items.values()) {
      const max = shares.get(item.id);
      if (item.state !== 'running' || max === undefined || item.connectionsSent === undefined) continue;
      if (item.connectionsSent === max) continue;
      item.connectionsSent = max;
      void link.send({ type: 'connections', id: item.id, max });
    }
  }

  /** Each running download's part of the speed limit. */
  function share(): number {
    if (!settings.speedLimit) return 0;
    const running = [...items.values()].filter((i) => i.state === 'running').length;
    return Math.max(1, Math.floor(settings.speedLimit / Math.max(1, running)));
  }

  /** When downloads start or stop, the others get a new share of the limit. */
  function applyLimits() {
    const limit = share();
    for (const item of items.values()) {
      if (item.state !== 'running' || item.limitSent === undefined || item.limitSent === limit) continue;
      item.limitSent = limit;
      void link.send({ type: 'limit', id: item.id, bytesPerSecond: limit });
    }
  }

  /** Sites that block hotlinking check the Referer, which the browser sends
   * but YDM's own requests would not. A session rule adds it, only for this
   * download's hosts and only for requests made by YDM itself. Like the
   * browser, other sites get the page's origin, not the whole address. */
  async function setReferrer(item: Entry, urls: string[]) {
    if (!item.referrer) return;
    const hosts = [...new Set(urls.map((u) => new URL(u).hostname))];
    const from = new URL(item.referrer);
    const value = hosts.every((h) => h === from.hostname) ? item.referrer : `${from.origin}/`;
    const rule = {
      id: item.id,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [{ header: 'referer', operation: 'set', value }],
      },
      condition: {
        requestDomains: hosts,
        initiatorDomains: [EXTENSION_HOST],
        resourceTypes: ['xmlhttprequest', 'other'],
      },
    } as Browser.declarativeNetRequest.Rule;
    await browser.declarativeNetRequest
      .updateSessionRules({ removeRuleIds: [item.id], addRules: [rule] })
      .catch(() => {});
  }

  function clearReferrer(id: number) {
    void browser.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id] }).catch(() => {});
  }

  function onEngineEvent(event: EngineEvent) {
    void restored.then(() => apply(event));
  }

  function apply(event: EngineEvent) {
    const item = items.get(event.id);
    if (!item) return;
    switch (event.type) {
      case 'started':
        item.name = event.name;
        item.total = event.total;
        // The worker sends a fresh one if it resumes or restarts.
        item.checkpoint = undefined;
        // Only now is the real name known, e.g. for "Scarica con YDM".
        if (settings.programsToBrowser && isProgram(event.name)) {
          item.toBrowser = { key: 'reason.program' };
          void link.send({ type: 'cancel', id: item.id });
          break;
        }
        // Redirected to another host (a CDN): it gets the Referer too, and
        // the connection budget is that host's.
        if (new URL(event.url).hostname !== new URL(item.url).hostname) {
          void setReferrer(item, [item.url, event.url]);
        }
        item.host = hostOf(event.url);
        item.finalUrl = event.url;
        // The address is checked while the first bytes arrive.
        if (scans() && !item.allowed) void checkLink(item, event.url);
        break;
      case 'origins':
        // A stream's pieces on other hosts get the page's Referer too.
        void setReferrer(item, [item.url, ...event.urls]).finally(() => void link.send({ type: 'proceed', id: item.id }));
        return;
      case 'inspected':
        void checkFile(item, event.name, event.sha256, new Uint8Array(event.head));
        return;
      case 'mirrors':
        item.servers = event.servers;
        item.verified = event.verified;
        schedulePersist();
        return notify(item.id);
      case 'capped':
      case 'tuned': {
        // What the server tolerates and what worked best: remembered for
        // this host's next downloads.
        const host = item.host ?? hostOf(item.url);
        if (!host) return;
        const before = hostCaps[host]?.connections;
        hostCaps[host] = mergeCap(hostCaps[host], event);
        void browser.storage.local.set({ hostCaps });
        if (hostCaps[host]?.connections !== before) applyConnections();
        return;
      }
      case 'progress': {
        const now = Date.now();
        if (item.sampledAt !== undefined && now > item.sampledAt) {
          const instant = ((event.done - (item.sampledDone ?? 0)) * 1000) / (now - item.sampledAt);
          item.speed = item.speed ? 0.7 * item.speed + 0.3 * instant : instant;
        }
        item.sampledAt = now;
        item.sampledDone = event.done;
        item.done = event.done;
        item.total = event.total;
        item.parts = event.parts;
        return notify(item.id); // progress is not worth persisting
      }
      case 'checkpoint':
        item.checkpoint = event.checkpoint;
        item.checkpointAt = Date.now();
        return schedulePersist();
      case 'ready':
        clearReferrer(item.id);
        item.elapsed = item.startedAt ? (item.elapsedBefore ?? 0) + Date.now() - item.startedAt : undefined;
        item.state = 'saving';
        item.done = item.total ?? item.done;
        item.speed = 0;
        // A file checked before delivery already has its hash.
        if (settings.checksum && (!item.sha256 || item.sha256 === 'pending')) item.sha256 = 'pending';
        void save(item, event.blobUrl, event.name);
        break;
      case 'hashed':
        item.sha256 = event.sha256;
        break;
      case 'failed':
        clearReferrer(item.id);
        if (event.retryInBrowser) {
          item.reason = event.reason;
          handBack(item.url, item.name);
          item.state = 'browser';
        } else {
          item.state = 'failed';
          item.reason = event.reason;
        }
        item.speed = 0;
        break;
      case 'cancelled':
        clearReferrer(item.id);
        if (item.blocking) {
          item.blocking = false;
          block(item);
        } else if (item.holding) {
          item.holding = false;
          hold(item, 'link');
        } else if (item.toBrowser) {
          item.reason = item.toBrowser;
          handBack(item.url, item.name);
          item.state = 'browser';
        } else if (item.pausing) {
          item.pausing = false;
          item.state = 'paused';
          if (item.startedAt !== undefined) item.elapsedBefore = (item.elapsedBefore ?? 0) + Date.now() - item.startedAt;
          item.startedAt = undefined;
        } else {
          item.state = 'cancelled';
          item.checkpoint = undefined;
        }
        item.speed = 0;
        break;
    }
    if (!isActive(item)) item.parts = undefined;
    pump();
    update(item.id);
  }

  // --- security ---------------------------------------------------------------

  /** Whether any check runs: on the device, or online with a key. */
  function scans(): boolean {
    return settings.scanLocal || scansOnline(settings);
  }

  /** The download's address, as soon as the real one is known. A known
   * virus is stopped at once; a suspicious one stops and asks. */
  async function checkLink(item: Entry, url: string) {
    const verdict = await scanner.link(url, settings);
    if (item.state !== 'running' || item.finalUrl !== url) return; // moved on meanwhile
    item.security = verdict;
    if (verdict.level === 'malicious') {
      item.blocking = true;
      void link.send({ type: 'cancel', id: item.id });
    } else if (mustAsk(verdict)) {
      // Kept, like a pause: "Download anyway" goes on from here.
      item.holding = true;
      void link.send({ type: 'cancel', id: item.id, keep: true });
    }
    update(item.id);
  }

  /** The finished file, still in YDM's storage. Nothing reaches the
   * Downloads folder before this says so. */
  async function checkFile(item: Entry, name: string, sha256: string | null, head: Uint8Array) {
    const verdict = await scanner.file(name, sha256, head, settings);
    // The link may already have been flagged: the worse of the two counts.
    item.security = merge(item.security, verdict);
    if (sha256) item.sha256 = sha256;
    const level = item.security.level;
    if (level === 'malicious') {
      block(item);
    } else if (mustAsk(item.security) && !item.allowed) {
      hold(item, 'file');
    } else {
      deliver(item, name);
    }
    update(item.id);
  }

  /** Suspicious, or not checked because a service ran out of time: the
   * user decides, unless they chose not to be asked. */
  function mustAsk(verdict: Verdict): boolean {
    return settings.askOnSuspicious && (verdict.level === 'suspicious' || incomplete(verdict.findings));
  }

  /** The checked file goes to the browser; hashed meanwhile if not yet. */
  function deliver(item: Entry, name: string) {
    const hashed = !!item.sha256 && item.sha256 !== 'pending';
    void link.send({ type: 'deliver', id: item.id, name, checksum: settings.checksum && !hashed });
  }

  function merge(a: Verdict | undefined, b: Verdict): Verdict {
    if (!a) return b;
    const order = ['clean', 'unknown', 'suspicious', 'malicious'];
    const level = order.indexOf(a.level) >= order.indexOf(b.level) ? a.level : b.level;
    return {
      level,
      // The same address checked twice gives the same findings: once each.
      findings: [...a.findings, ...b.findings].filter(
        (f, i, all) => all.findIndex((g) => JSON.stringify(g) === JSON.stringify(f)) === i,
      ),
      checked: [...new Set([...a.checked, ...b.checked])],
      sha256: b.sha256 ?? a.sha256,
      at: b.at,
    };
  }

  /** A known virus: deleted, never saved, and the user is told why. */
  function block(item: Entry) {
    clearReferrer(item.id);
    void link.send({ type: 'release', id: item.id });
    item.state = 'blocked';
    item.speed = 0;
    item.checkpoint = undefined;
    item.reason = { key: 'reason.blocked' };
    warn(item);
  }

  /** Suspicious: set aside until the user answers. */
  function hold(item: Entry, at: 'link' | 'file') {
    item.state = 'held';
    item.heldAt = at;
    item.speed = 0;
    if (at === 'link' && item.startedAt !== undefined) {
      item.elapsedBefore = (item.elapsedBefore ?? 0) + Date.now() - item.startedAt;
      item.startedAt = undefined;
    }
    warn(item);
  }

  /** The user's answer to a warning. */
  function decideHeld(item: Entry, allow: boolean) {
    if (item.state !== 'held') return;
    if (!allow) {
      void link.send({ type: 'release', id: item.id });
      item.state = 'cancelled';
      item.checkpoint = undefined;
      item.reason = { key: 'reason.denied' };
      return;
    }
    item.allowed = true;
    if (item.heldAt === 'file') {
      item.state = 'saving';
      deliver(item, item.name);
    } else {
      // Stopped while downloading: goes on from where it stopped.
      item.state = 'queued';
      pump();
    }
  }

  /** Downloads that stay with the browser: checked by their address while
   * the browser fetches them, paused if a check takes long. */
  async function guardBrowserDownload(d: Browser.downloads.DownloadItem, url: string) {
    if (!scans()) return;
    // An online answer takes a moment: the browser waits for it.
    const paused = scansOnline(settings) && (await browser.downloads.pause(d.id).then(() => true, () => false));
    const verdict = await scanner.link(url, settings);
    if (verdict.level !== 'malicious' && !mustAsk(verdict)) {
      if (paused) await browser.downloads.resume(d.id).catch(() => {});
      return;
    }
    // Too late for a finished small file to be stopped by YDM: the browser
    // has it; remove it so it is not opened by mistake, and say why.
    await browser.downloads.cancel(d.id).catch(() => {});
    const [now] = await browser.downloads.search({ id: d.id }).catch(() => []);
    if (now?.state === 'complete' && verdict.level === 'malicious') {
      await browser.downloads.removeFile(d.id).catch(() => {});
    }
    if (now?.state === 'complete' && verdict.level !== 'malicious') {
      // Already saved: the decision is the user's; only warn.
      record(d, url, verdict, 'completed').downloadId = d.id;
      return;
    }
    await browser.downloads.erase({ id: d.id }).catch(() => {});
    record(d, url, verdict, verdict.level === 'malicious' ? 'blocked' : 'held');
  }

  /** A browser download, now in YDM's list because a check stopped it. */
  function record(d: Browser.downloads.DownloadItem, url: string, verdict: Verdict, state: 'blocked' | 'held' | 'completed'): Entry {
    const id = ++nextId;
    const item: Entry = {
      id,
      url,
      finalUrl: url,
      referrer: d.referrer || undefined,
      name: sanitize(baseName(d.filename) || fromUrl(url) || ''),
      state,
      done: 0,
      total: d.totalBytes > 0 ? d.totalBytes : null,
      speed: 0,
      security: verdict,
      heldAt: 'link',
      reason: state === 'blocked' ? { key: 'reason.blocked' } : undefined,
    };
    items.set(id, item);
    trimHistory();
    if (state !== 'completed') warn(item);
    update();
    return item;
  }

  // The warning window, opened for each download that needs a decision or
  // was blocked; one at a time per download.
  const alertWindows = new Map<number, number>();

  function warn(item: Entry) {
    const verdict = item.security;
    if (!verdict) return;
    const title = t(item.state === 'blocked' ? 'notify.blocked' : 'notify.suspicious');
    void browser.notifications
      .create(`${ALERT}${item.id}`, {
        type: 'basic',
        iconUrl: browser.runtime.getURL('/icon/128.png'),
        title,
        message: item.name,
        requireInteraction: item.state === 'held',
      } as Browser.notifications.NotificationCreateOptions)
      .catch(() => {});
    void openAlert(item.id);
  }

  async function openAlert(id: number) {
    const open = alertWindows.get(id);
    if (open !== undefined) {
      const ok = await browser.windows.update(open, { focused: true }).catch(() => null);
      if (ok) return;
    }
    const url = browser.runtime.getURL(`/alert.html#${id}`);
    const win = await browser.windows
      .create({ url, type: 'popup', width: 440, height: 560, focused: true })
      .catch(() => null);
    if (win?.id !== undefined) alertWindows.set(id, win.id);
    // No window (a browser without them): the notification and the badge remain.
  }

  browser.windows?.onRemoved.addListener((windowId) => {
    for (const [id, w] of alertWindows) {
      if (w !== windowId) continue;
      alertWindows.delete(id);
      // Closing the warning without answering means "do not download".
      const item = items.get(id);
      if (item?.state === 'held') {
        decideHeld(item, false);
        update(id);
      }
    }
  });

  /** The browser copies the finished file into Downloads, choosing the final
   * name and applying Mark-of-the-Web and Safe Browsing like any download. */
  async function save(item: Entry, blobUrl: string, name: string) {
    // In its folder if sorting is on; if the browser refuses that path, in
    // Downloads itself; if it refuses the name too, under its own name.
    const folder = folderFor(name, item.finalUrl ?? item.url, settings);
    const candidates = [...new Set([withFolder(folder, name), name])];
    for (const filename of [...candidates, undefined]) {
      try {
        const downloadId = await browser.downloads.download({
          url: blobUrl,
          filename,
          conflictAction: 'uniquify',
          saveAs: false,
        });
        item.downloadId = downloadId;
        saving.set(downloadId, item.id);
        update();
        return;
      } catch {
        // Name rejected by the browser: retry with the one it picks.
      }
    }
    item.reason = { key: 'reason.browserRejected' };
    handBack(item.url, item.name);
    item.state = 'browser';
    void link.send({ type: 'release', id: item.id });
    update();
  }

  browser.downloads.onChanged.addListener((delta) => {
    const id = saving.get(delta.id);
    const state = delta.state?.current;
    if (id === undefined || !state || state === 'in_progress') return;
    saving.delete(delta.id);
    const item = items.get(id);
    void link.send({ type: 'release', id });
    if (!item) return;
    const error = delta.error?.current;
    if (state === 'complete') {
      item.state = 'completed';
      if (settings.notify) notifyDone(item);
    } else if (error === 'USER_CANCELED') {
      item.state = 'cancelled';
    } else {
      // Often a security check: the browser downloads it again itself and
      // shows its own warning, so the user decides as without YDM.
      item.reason = describeSaveError(error);
      handBack(item.url, item.name);
      item.state = 'browser';
    }
    update();
  });

  // --- updates ------------------------------------------------------------

  /** Once a day, for a copy installed from GitHub that cannot update itself
   * (unpacked in Chrome): is there a newer release? */
  async function checkForUpdate() {
    const manifest = browser.runtime.getManifest();
    const repo = import.meta.env.YDM_REPO as string | undefined;
    if (!repo || updatesItself(manifest)) return;
    const { updateCheck } = (await browser.storage.local.get('updateCheck')) as {
      updateCheck?: { at: number; found: Available | null };
    };
    let found = updateCheck?.found ?? null;
    if (!updateCheck || Date.now() - updateCheck.at > CHECK_EVERY_MS) {
      found = await latestRelease(repo, manifest.version).catch(() => found);
      await browser.storage.local.set({ updateCheck: { at: Date.now(), found } });
    }
    newerRelease = found && found.version !== manifest.version ? found : null;
    if (newerRelease) notify();
  }

  // --- notifications ------------------------------------------------------

  const NOTIFICATION = 'ydm-';
  /** Security warnings; a click opens the warning window. */
  const ALERT = 'ydm-alert-';

  function notifyDone(item: Entry) {
    const size = item.total ? bytes(item.total) : '';
    const options: Browser.notifications.NotificationCreateOptions = {
      type: 'basic',
      iconUrl: browser.runtime.getURL('/icon/128.png'),
      title: t('notify.done'),
      message: size ? t('notify.doneBody', { name: item.name, size }) : item.name,
    };
    // Firefox has no notification buttons; a click there shows the file.
    if (!import.meta.env.FIREFOX) options.buttons = [{ title: t('notify.show') }];
    void browser.notifications.create(`${NOTIFICATION}${item.id}`, options).catch(() => {});
  }

  function showFromNotification(notificationId: string) {
    if (notificationId.startsWith(ALERT)) {
      void openAlert(Number(notificationId.slice(ALERT.length)));
      return;
    }
    if (!notificationId.startsWith(NOTIFICATION)) return;
    const item = items.get(Number(notificationId.slice(NOTIFICATION.length)));
    if (item?.downloadId !== undefined) browser.downloads.show(item.downloadId);
    void browser.notifications.clear(notificationId);
  }

  browser.notifications.onClicked.addListener(showFromNotification);
  browser.notifications.onButtonClicked?.addListener((id) => showFromNotification(id));

  /** The browser downloads it itself. With a known name, into the same
   * folder YDM would have used; the browser's own choice if it refuses. */
  function handBack(url: string, name?: string) {
    handedBack.add(url);
    // Only a real file name (one with an extension), never a placeholder.
    const folder = name && extOfName(name) ? folderFor(name, url, settings) : '';
    const plain = () => browser.downloads.download({ url });
    const sorted = folder && name ? browser.downloads.download({ url, filename: withFolder(folder, name) }).catch(plain) : plain();
    void sorted.catch(() => handedBack.delete(url));
  }

  // Chrome only (Firefox has no such event): downloads the browser keeps
  // for itself (small files, programs, excluded sites) go into their folder
  // too. Called for every download, so it always answers, and fast.
  const determining = (browser.downloads as unknown as {
    onDeterminingFilename?: {
      addListener(cb: (d: Browser.downloads.DownloadItem, suggest: (s?: { filename: string; conflictAction: 'uniquify' }) => void) => boolean | void): void;
    };
  }).onDeterminingFilename;
  determining?.addListener((d, suggest) => {
    // Downloads started by an extension keep the name it chose: YDM's own
    // saves and hand-backs already carry their folder, and other
    // extensions' choices are theirs.
    if (d.byExtensionId) return void suggest();
    // The answer comes after the settings are loaded; exactly once.
    let suggestion: { filename: string; conflictAction: 'uniquify' } | undefined;
    void restored
      .then(() => {
        const name = baseName(d.filename) ?? '';
        const folder = name ? folderFor(name, d.finalUrl || d.url, settings) : '';
        if (folder) suggestion = { filename: withFolder(folder, sanitize(name)), conflictAction: 'uniquify' };
      })
      .catch(() => {})
      .finally(() => suggest(suggestion));
    return true;
  });

  // --- popup --------------------------------------------------------------

  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== 'popup' || port.sender?.id !== browser.runtime.id) return;
    popups.add(port);
    port.onMessage.addListener((msg) => void onPopup(msg as PopupCommand));
    // Opening a page is a good moment to look for a new version on disk.
    void restored.then(checkInstalledVersion);
    port.onDisconnect.addListener(() => {
      popups.delete(port);
      scheduleIdleClose();
      reloadWhenIdle();
    });
    void restored.then(() => port.postMessage(snapshot(null)));
  });

  async function onPopup(cmd: PopupCommand) {
    await restored;
    switch (cmd.type) {
      case 'cancel': {
        const item = items.get(cmd.id);
        if (!item) return;
        if (item.state === 'queued' || item.state === 'paused') {
          // A paused or resumable one has a partial file to delete.
          if (item.checkpoint || item.state === 'paused') void link.send({ type: 'release', id: item.id });
          item.state = 'cancelled';
          item.checkpoint = undefined;
        } else if (item.state === 'running') {
          item.pausing = false;
          void link.send({ type: 'cancel', id: item.id });
        }
        else if (item.state === 'saving' && item.downloadId !== undefined) {
          await browser.downloads.cancel(item.downloadId).catch(() => {});
        }
        break;
      }
      case 'pause': {
        const item = items.get(cmd.id);
        if (item?.state === 'queued') item.state = 'paused';
        else if (item?.state === 'running') {
          item.pausing = true;
          void link.send({ type: 'cancel', id: item.id, keep: true });
        }
        break;
      }
      case 'resume': {
        const item = items.get(cmd.id);
        if (item?.state !== 'paused') return;
        item.state = 'queued';
        pump();
        break;
      }
      case 'retry': {
        const item = items.get(cmd.id);
        if (item?.state !== 'failed' && item?.state !== 'cancelled') return;
        Object.assign(item, {
          state: 'queued',
          done: 0,
          speed: 0,
          reason: undefined,
          elapsed: undefined,
          elapsedBefore: undefined,
          checkpoint: undefined,
          toBrowser: undefined,
          // Checked again from scratch, as a new download.
          sha256: undefined,
          servers: undefined,
          verified: undefined,
          security: undefined,
          heldAt: undefined,
          allowed: undefined,
          finalUrl: undefined,
        });
        pump();
        break;
      }
      case 'show': {
        const item = items.get(cmd.id);
        if (item?.downloadId !== undefined) browser.downloads.show(item.downloadId);
        return;
      }
      case 'enabled':
        await browser.storage.local.set({ enabled: cmd.value });
        return;
      case 'clear':
        for (const [id, item] of items) if (!isActive(item) && item.state !== 'paused') items.delete(id);
        break;
      case 'remove': {
        const item = items.get(cmd.id);
        if (!item || isActive(item) || item.state === 'held') return;
        if (item.state === 'paused' || item.checkpoint) void link.send({ type: 'release', id: item.id });
        items.delete(cmd.id);
        notify(cmd.id);
        schedulePersist();
        return;
      }
      case 'urls':
        // Chosen by hand: no minimum size, as for "Download with YDM".
        for (const url of cmd.urls.filter((u) => /^https?:/i.test(u)).slice(0, 500)) {
          // A pasted stream address is downloaded as a video.
          const stream = mediaKind(url);
          enqueue(url, undefined, cmd.referrer, stream === 'hls' || stream === 'dash' ? stream : undefined);
        }
        return;
      case 'video':
        if (!/^https?:/i.test(cmd.url)) return;
        enqueue(cmd.url, cmd.name, /^https?:/i.test(cmd.referrer ?? '') ? cmd.referrer : undefined, cmd.kind === 'direct' ? undefined : cmd.kind);
        return;
      case 'allow':
      case 'deny': {
        const item = items.get(cmd.id);
        if (!item) return;
        decideHeld(item, cmd.type === 'allow');
        void browser.notifications.clear(`${ALERT}${cmd.id}`).catch(() => {});
        break;
      }
    }
    update();
  }

  /** The whole list (`changed` null), or only the items in `changed`. */
  function snapshot(changed: Set<number> | null): PopupState {
    const view = ({ id, name, state, done, total, speed, reason, elapsed, parts, checkpoint, url, finalUrl, sha256, servers, verified, downloadId, security, heldAt }: Entry): Item => ({
      id,
      name,
      state,
      done,
      total,
      speed,
      reason,
      elapsed,
      parts,
      url: finalUrl ?? url,
      sha256,
      servers,
      verified,
      downloadId,
      security,
      heldAt,
      resumable: checkpoint !== undefined,
    });
    // Pages learn whether a key is set, never the key itself.
    const base = {
      enabled: settings.enabled,
      minSize: settings.minSize,
      settings: publicSettings(settings),
      update: newerRelease ?? undefined,
    };
    if (changed) {
      const list = [...changed].map((id) => items.get(id)).filter((i): i is Entry => !!i);
      const removed = [...changed].filter((id) => !items.has(id));
      return { type: 'patch', ...base, items: list.map(view), removed };
    }
    // Newest first.
    return { type: 'state', ...base, items: [...items.values()].reverse().map(view) };
  }

  /** Tells open pages what changed, at most every NOTIFY_MS. Nothing to
   * do while no page is open. `id` undefined means the whole list. */
  function notify(id?: number) {
    if (!popups.size) return;
    if (id === undefined) dirty = null;
    else if (dirty) dirty.add(id);
    if (notifyTimer !== undefined) return;
    notifyTimer = setTimeout(() => {
      notifyTimer = undefined;
      const state = snapshot(dirty);
      dirty = new Set();
      for (const port of popups) port.postMessage(state);
    }, NOTIFY_MS);
  }

  // --- housekeeping ---------------------------------------------------------

  /** After a state change: persist, refresh popup and badge. `id`: the
   * one item that changed, if only one did. */
  function update(id?: number) {
    schedulePersist();
    notify(id);
    const active = [...items.values()].filter(isActive).length;
    // A download waiting for a decision outranks the count: "!" in red.
    const waiting = [...items.values()].some((i) => i.state === 'held');
    const action = browser.action ?? browser.browserAction;
    void action.setBadgeText({ text: waiting ? '!' : active ? String(active) : '' });
    void action.setBadgeBackgroundColor({ color: waiting ? '#b9342a' : '#0e7a55' });
    scheduleIdleClose();
    reloadWhenIdle();
  }

  /** Coalesces writes: a burst of state changes costs one write. */
  function schedulePersist() {
    if (persistTimer !== undefined) return;
    persistTimer = setTimeout(() => {
      persistTimer = undefined;
      persist();
    }, PERSIST_MS);
  }

  function persist(): Promise<void> {
    return browser.storage.local
      .set({
        items: [...items.values()].map(({ sampledAt: _a, sampledDone: _d, parts: _p, ...rest }) =>
          // Finished downloads have nothing to resume; held ones may go on.
          isActive(rest) || rest.state === 'paused' || rest.state === 'held' ? rest : { ...rest, checkpoint: undefined },
        ),
        nextId,
      })
      .catch(() => {});
  }

  // --- self-update of a copy loaded unpacked ---------------------------------

  // Chrome cannot update a copy loaded unpacked. The Windows installer's
  // scheduled task (installer/update-chrome.ps1) replaces its files with the
  // latest release, manifest.json last; the running YDM notices the newer
  // version on disk and reloads itself, once nothing is running or waiting
  // for an answer and no YDM page is open. The list survives the reload.
  let reloadPending = false;
  const RECHECK_ALARM = 'ydm-installed-version';

  async function checkInstalledVersion() {
    const running = browser.runtime.getManifest();
    if (updatesItself(running)) return;
    // (WXT types only its pages; the manifest is there too.)
    const res = await fetch(browser.runtime.getURL('/manifest.json' as '/popup.html'), { cache: 'no-store' }).catch(() => null);
    const onDisk = (await res?.json().catch(() => null)) as { version?: string } | null;
    if (onDisk?.version && isNewer(onDisk.version, running.version)) {
      reloadPending = true;
      reloadWhenIdle();
    }
  }

  function reloadWhenIdle() {
    if (!reloadPending || popups.size > 0) return;
    if ([...items.values()].some((i) => isActive(i) || i.state === 'held')) return;
    reloadPending = false;
    clearTimeout(persistTimer);
    persistTimer = undefined;
    void persist().then(() => browser.runtime.reload());
  }

  browser.alarms?.create(RECHECK_ALARM, { periodInMinutes: 30 });
  browser.alarms?.onAlarm.addListener((alarm) => {
    if (alarm.name === RECHECK_ALARM) void restored.then(checkInstalledVersion);
  });

  function scheduleIdleClose() {
    clearTimeout(idleTimer);
    if (popups.size > 0 || [...items.values()].some(isActive)) return;
    idleTimer = setTimeout(() => void link.close(), IDLE_CLOSE_MS);
  }

  function trimHistory() {
    const finished = [...items.values()].filter((i) => !isActive(i));
    for (const old of finished.slice(0, Math.max(0, finished.length - HISTORY))) items.delete(old.id);
  }
});

function isActive(item: Item): boolean {
  return item.state === 'queued' || item.state === 'running' || item.state === 'saving';
}

/** Firefox announces a download before it has read the response headers,
 * so the size is still unknown; give it a moment to find out. */
async function withKnownSize(d: Browser.downloads.DownloadItem): Promise<Browser.downloads.DownloadItem> {
  for (let i = 0; i < 10 && d.totalBytes <= 0 && d.state === 'in_progress'; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const [now] = await browser.downloads.search({ id: d.id });
    if (!now) break;
    d = now;
  }
  return d;
}

function baseName(path: string): string | undefined {
  return path.split(/[/\\]/).at(-1) || undefined;
}

function pruneOld(map: Map<string, number>, maxAge: number) {
  const cutoff = Date.now() - maxAge;
  for (const [key, at] of map) if (at < cutoff) map.delete(key);
}
