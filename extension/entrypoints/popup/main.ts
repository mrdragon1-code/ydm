import { t } from '@/lib/i18n';
import { wireAdder } from '@/lib/ui/adder';
import { bytes, speed } from '@/lib/ui/format';
import { createRow, type Row, syncList } from '@/lib/ui/row';
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

toggle.addEventListener('change', () => send({ type: 'enabled', value: toggle.checked }));
clear.addEventListener('click', () => send({ type: 'clear' }));
$('settings').addEventListener('click', () => openApp('settings'));
$('all').addEventListener('click', () => openApp('downloads'));
$('attentionOpen').addEventListener('click', () => {
  const id = Number($('attention').dataset.id);
  if (id) openAlert(id);
});
wireAdder(addButton, adder, urls, addStatus, send);

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
  // The total speed first: when the line is cut short, the counts go.
  const parts: string[] = [];
  if (total > 0) parts.push(speed(total));
  if (running.length) parts.push(t('popup.running', { count: running.length }));
  if (queued) parts.push(t('popup.queued', { count: queued }));
  summary.textContent = parts.join(' · ');
}
