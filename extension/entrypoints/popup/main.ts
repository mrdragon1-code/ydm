import { t } from '@/lib/i18n';
import { wireAdder } from '@/lib/ui/adder';
import { bytes, speed } from '@/lib/ui/format';
import { createRow, type Row, syncList } from '@/lib/ui/row';
import { type MediaFound, videoName } from '@/lib/media';
import { connect, isActive, type View } from '@/lib/ui/store';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const list = $<HTMLUListElement>('list');
const empty = $('empty');
const hint = $('hint');
const off = $('off');
const notice = $('notice');
const summary = $('summary');
const toggle = $<HTMLInputElement>('enabled');
const clear = $<HTMLButtonElement>('clear');
const adder = $<HTMLFormElement>('adder');
const addButton = $<HTMLButtonElement>('add');
const urls = $<HTMLTextAreaElement>('urls');
const addStatus = $('addStatus');

/** Rows show at most this many; the downloads page has the rest. */
const POPUP_ITEMS = 30;

const send = connect(render);
const rows = new Map<number, Row>();

/** A screen of the app, in a tab; the popup closes. */
function openApp(screen: string) {
  void browser.tabs.create({ url: browser.runtime.getURL(`/app.html#${screen}`) });
  window.close();
}

/** The warning window of a held download: it asks the question. */
function openAlert(id: number) {
  void browser.windows
    .create({ url: browser.runtime.getURL(`/alert.html#${id}`), type: 'popup', width: 440, height: 560 })
    .catch(() => void browser.tabs.create({ url: browser.runtime.getURL(`/alert.html#${id}`) }));
  window.close();
}

// --- videos on the current page --------------------------------------------

/** The videos the page in the current tab has loaded, as the background
 * saw them; the list follows while the popup is open. */
async function showVideos() {
  // `#tab=<id>`: the tests open the popup as a page, which is then the
  // active tab itself; they name the tab whose videos it should show.
  const named = Number(new URLSearchParams(location.hash.slice(1)).get('tab'));
  const [tab] = named
    ? [await browser.tabs.get(named).catch(() => undefined)]
    : await browser.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  if (tab?.id === undefined || tab.incognito) return;
  const key = `media:${tab.id}`;
  const draw = (found: MediaFound[] | undefined) => renderVideos(found ?? []);
  draw(((await browser.storage.session.get(key).catch(() => ({}))) as Record<string, MediaFound[]>)[key]);
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && changes[key]) draw(changes[key].newValue as MediaFound[] | undefined);
  });
}

/** Addresses already sent this time the popup is open. */
const added = new Set<string>();

function renderVideos(found: MediaFound[]) {
  $('videos').hidden = !found.length;
  $('videoList').replaceChildren(
    ...found.map((m) => {
      const li = document.createElement('li');
      const text = document.createElement('div');
      text.className = 'video-text';
      const title = document.createElement('span');
      title.className = 'video-title';
      title.textContent = m.title || videoName('', 'mp4');
      title.title = m.title;
      const meta = document.createElement('span');
      meta.className = 'video-meta';
      const blocked = m.drm ? t('popup.videoProtected') : m.live ? t('popup.videoLive') : '';
      meta.textContent = [
        m.quality || (m.kind === 'hls' ? t('popup.videoStream') : ''),
        m.size ? `${m.kind === 'hls' ? '~' : ''}${bytes(m.size)}` : '',
        blocked || (m.separateAudio ? t('popup.videoNoAudio') : ''),
      ]
        .filter(Boolean)
        .join(' · ');
      if (blocked) li.dataset.blocked = '';
      text.append(title, meta);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'button small';
      const done = added.has(m.url);
      button.textContent = done ? t('popup.videoAdded') : t('popup.videoDownload');
      button.disabled = done || !!blocked;
      button.addEventListener('click', () => {
        const ext = m.kind === 'hls' ? 'mp4' : (/\.(mp4|webm|mkv|mov)(?:$|\?)/i.exec(m.url)?.[1]?.toLowerCase() ?? 'mp4');
        send({ type: 'video', url: m.url, kind: m.kind, name: videoName(m.title, ext), referrer: m.page });
        added.add(m.url);
        button.textContent = t('popup.videoAdded');
        button.disabled = true;
      });
      li.append(text, button);
      return li;
    }),
  );
}

void showVideos();

toggle.addEventListener('change', () => send({ type: 'enabled', value: toggle.checked }));
clear.addEventListener('click', () => send({ type: 'clear' }));
$('settings').addEventListener('click', () => openApp('settings'));
$('all').addEventListener('click', () => openApp('downloads'));
$('attentionOpen').addEventListener('click', () => {
  const id = Number($('attention').dataset.id);
  if (id) openAlert(id);
});
// A pasted screenshot is read in the downloads page: the popup closes as
// soon as it loses focus, too soon for the OCR engine.
wireAdder(addButton, adder, urls, addStatus, send, (image) => {
  const reader = new FileReader();
  const failed = () => (addStatus.textContent = t('downloads.ocrFailed'));
  reader.onerror = failed;
  reader.onload = async () => {
    try {
      const id = crypto.randomUUID();
      await browser.storage.local.set({ [`ocr:${id}`]: { src: reader.result as string } });
      await browser.tabs.create({ url: browser.runtime.getURL(`/app.html#downloads/ocr=${id}`) });
      window.close();
    } catch {
      failed();
    }
  };
  reader.readAsDataURL(image);
});

$('grab').addEventListener('click', async () => {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined || tab.incognito || !/^https?:/.test(tab.url ?? '')) {
    notice.textContent = t('popup.grabBlocked');
    notice.hidden = false;
    return;
  }
  openApp(`downloads/grab=${tab.id}`);
});

function render(view: View) {
  const update = $('update');
  update.hidden = !view.update;
  if (view.update) {
    $('updateText').textContent = t('update.available', { version: view.update.version });
    $<HTMLAnchorElement>('updateLink').href = view.update.url;
  }
  toggle.checked = view.enabled;
  off.hidden = view.enabled;
  // Something waiting for a decision comes first, above everything else.
  const held = view.items.filter((i) => i.state === 'held');
  const attention = $('attention');
  attention.hidden = !held.length;
  if (held.length) {
    $('attentionText').textContent = t('app.waiting', { count: held.length });
    attention.dataset.id = String(held[0]!.id);
  }
  syncList(
    list,
    rows,
    view.items.slice(0, POPUP_ITEMS),
    (id) =>
      createRow(id, (kind, item) => {
        if (kind === 'decide') openAlert(item);
        else send({ type: kind === 'open' ? 'show' : kind, id: item });
      }),
    view.changed,
  );
  empty.hidden = view.items.length > 0;
  hint.textContent = t('popup.hint', { size: bytes(view.minSize) });
  clear.hidden = !view.items.some((i) => !isActive(i) && i.state !== 'paused');

  const running = view.items.filter((i) => i.state === 'running');
  const total = running.reduce((n, i) => n + i.speed, 0);
  const queued = view.items.filter((i) => i.state === 'queued').length;
  // Two short lines beside the name: the total speed, then the counts.
  const counts: string[] = [];
  if (running.length) counts.push(t('popup.running', { count: running.length }));
  if (queued) counts.push(t('popup.queued', { count: queued }));
  const rate = total > 0 ? speed(total) : '';
  summary.querySelector('.rate')!.textContent = rate;
  summary.querySelector('.counts')!.textContent = counts.join(' · ');
  summary.title = [rate, ...counts].filter(Boolean).join(' · ');
}
