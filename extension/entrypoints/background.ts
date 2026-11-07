import type { Browser } from 'wxt/browser';
import { budgets, freshCaps, type HostCap, hostOf } from '@/lib/budget';
import { pickLocale, setLocale, t, useMachineTranslations } from '@/lib/i18n';
import { createLink } from '@/lib/link';
import { cachedTranslation } from '@/lib/translate';
import { type Available, CHECK_EVERY_MS, latestRelease, updatesItself } from '@/lib/updates';
import { bytes } from '@/lib/ui/format';

// Translations made by a page with the browser's translator; the
// background itself cannot use that API.
useMachineTranslations(cachedTranslation);
import { fromUrl, sanitize } from '@/lib/naming';
import {
  DEFAULT_SETTINGS,
  describeSaveError,
  isProgram,
  readSettings,
  SETTING_KEYS,
  type Settings,
  shouldIntercept,
} from '@/lib/policy';
import type { Checkpoint, EngineEvent, Item, PopupCommand, PopupState, Reason } from '@/lib/protocol';

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

  // The list survives a service worker restart and the browser being closed.
  const restored = (async () => {
    const stored = await browser.storage.local.get([...SETTING_KEYS, 'items', 'nextId', 'hostCaps']);
    hostCaps = freshCaps((stored.hostCaps as Record<string, HostCap>) ?? {});
    settings = readSettings(stored);
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
      const paused = [...items.values()].filter((i) => i.state === 'paused').map((i) => i.id);
      await link.send({ type: 'prune', keep: [...resumed, ...paused] });
    }
    pump();
    void checkForUpdate();
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
    for (const key of SETTING_KEYS) if (changes[key]) next[key] = changes[key].newValue;
    const languageChanged = next.language !== settings.language;
    settings = readSettings(next);
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
    if (!shouldIntercept(candidate, settings)) return;
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
  }

  /** The downloads page, listing the links of `tab` to pick from. */
  function openGrab(tabId: number) {
    void browser.tabs.create({ url: browser.runtime.getURL(`/downloads.html#grab=${tabId}`) });
  }

  browser.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId === 'ydm-page') {
      if (tab?.id !== undefined && !tab.incognito) openGrab(tab.id);
      return;
    }
    const url = info.linkUrl;
    if (!url || !/^https?:/i.test(url)) return;
    await restored;
    if (tab?.incognito) return void handBack(url);
    enqueue(url, undefined, info.pageUrl);
  });

  // --- queue ------------------------------------------------------------

  function enqueue(url: string, hint?: string, referrer?: string) {
    const id = ++nextId;
    items.set(id, {
      id,
      url,
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
          resume: item.checkpoint,
          limit: item.limitSent,
          checksum: settings.checksum,
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
        break;
      case 'capped': {
        // The server refused more connections: remembered for this host.
        const host = item.host ?? hostOf(item.url);
        const known = hostCaps[host]?.connections ?? Infinity;
        hostCaps[host] = { connections: Math.min(known, event.connections), at: Date.now() };
        void browser.storage.local.set({ hostCaps });
        applyConnections();
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
        if (settings.checksum) item.sha256 = 'pending';
        void save(item, event.blobUrl, event.name);
        break;
      case 'hashed':
        item.sha256 = event.sha256;
        break;
      case 'failed':
        clearReferrer(item.id);
        if (event.retryInBrowser) {
          item.reason = event.reason;
          handBack(item.url);
          item.state = 'browser';
        } else {
          item.state = 'failed';
          item.reason = event.reason;
        }
        item.speed = 0;
        break;
      case 'cancelled':
        clearReferrer(item.id);
        if (item.toBrowser) {
          item.reason = item.toBrowser;
          handBack(item.url);
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

  /** The browser copies the finished file into Downloads, choosing the final
   * name and applying Mark-of-the-Web and Safe Browsing like any download. */
  async function save(item: Entry, blobUrl: string, name: string) {
    for (const filename of [name, undefined]) {
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
    handBack(item.url);
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
      handBack(item.url);
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
    if (!notificationId.startsWith(NOTIFICATION)) return;
    const item = items.get(Number(notificationId.slice(NOTIFICATION.length)));
    if (item?.downloadId !== undefined) browser.downloads.show(item.downloadId);
    void browser.notifications.clear(notificationId);
  }

  browser.notifications.onClicked.addListener(showFromNotification);
  browser.notifications.onButtonClicked?.addListener((id) => showFromNotification(id));

  function handBack(url: string) {
    handedBack.add(url);
    void browser.downloads.download({ url }).catch(() => handedBack.delete(url));
  }

  // --- popup --------------------------------------------------------------

  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== 'popup' || port.sender?.id !== browser.runtime.id) return;
    popups.add(port);
    port.onMessage.addListener((msg) => void onPopup(msg as PopupCommand));
    port.onDisconnect.addListener(() => {
      popups.delete(port);
      scheduleIdleClose();
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
        if (!item || isActive(item)) return;
        if (item.state === 'paused' || item.checkpoint) void link.send({ type: 'release', id: item.id });
        items.delete(cmd.id);
        notify(cmd.id);
        schedulePersist();
        return;
      }
      case 'urls':
        // Chosen by hand: no minimum size, as for "Download with YDM".
        for (const url of cmd.urls.filter((u) => /^https?:/i.test(u)).slice(0, 500)) {
          enqueue(url, undefined, cmd.referrer);
        }
        return;
    }
    update();
  }

  /** The whole list (`changed` null), or only the items in `changed`. */
  function snapshot(changed: Set<number> | null): PopupState {
    const view = ({ id, name, state, done, total, speed, reason, elapsed, parts, checkpoint, url, sha256, downloadId }: Entry): Item => ({
      id,
      name,
      state,
      done,
      total,
      speed,
      reason,
      elapsed,
      parts,
      url,
      sha256,
      downloadId,
      resumable: checkpoint !== undefined,
    });
    const base = { enabled: settings.enabled, minSize: settings.minSize, settings, update: newerRelease ?? undefined };
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
    const action = browser.action ?? browser.browserAction;
    void action.setBadgeText({ text: active ? String(active) : '' });
    void action.setBadgeBackgroundColor({ color: '#3b6ef5' });
    scheduleIdleClose();
  }

  /** Coalesces writes: a burst of state changes costs one write. */
  function schedulePersist() {
    if (persistTimer !== undefined) return;
    persistTimer = setTimeout(() => {
      persistTimer = undefined;
      persist();
    }, PERSIST_MS);
  }

  function persist() {
    void browser.storage.local.set({
      items: [...items.values()].map(({ sampledAt: _a, sampledDone: _d, parts: _p, ...rest }) =>
        // Finished downloads have nothing to resume.
        isActive(rest) || rest.state === 'paused' ? rest : { ...rest, checkpoint: undefined },
      ),
      nextId,
    });
  }

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
