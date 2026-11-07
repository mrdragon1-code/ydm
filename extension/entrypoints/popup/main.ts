import { t } from '@/lib/i18n';
import { parseUrls } from '@/lib/links';
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

toggle.addEventListener('change', () => send({ type: 'enabled', value: toggle.checked }));
clear.addEventListener('click', () => send({ type: 'clear' }));
$('settings').addEventListener('click', () => {
  void browser.runtime.openOptionsPage();
  window.close();
});
$('all').addEventListener('click', () => {
  void browser.tabs.create({ url: browser.runtime.getURL('/downloads.html') });
  window.close();
});

addButton.addEventListener('click', () => {
  adder.hidden = !adder.hidden;
  addButton.setAttribute('aria-expanded', String(!adder.hidden));
  if (!adder.hidden) urls.focus();
});
adder.addEventListener('submit', (e) => {
  e.preventDefault();
  const found = parseUrls(urls.value);
  if (!found.length) {
    addStatus.textContent = t('popup.addInvalid');
    return;
  }
  send({ type: 'urls', urls: found });
  urls.value = '';
  addStatus.textContent = t('popup.addDone', { count: found.length });
});
// Ctrl/Cmd+Enter sends, Enter alone makes a new line.
urls.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) adder.requestSubmit();
});

$('grab').addEventListener('click', async () => {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined || tab.incognito || !/^https?:/.test(tab.url ?? '')) {
    notice.textContent = t('popup.grabBlocked');
    notice.hidden = false;
    return;
  }
  void browser.tabs.create({ url: browser.runtime.getURL(`/downloads.html#grab=${tab.id}`) });
  window.close();
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
  syncList(
    list,
    rows,
    view.items.slice(0, POPUP_ITEMS),
    (id) => createRow(id, (kind, item) => send({ type: kind === 'open' ? 'show' : kind, id: item })),
    view.changed,
  );
  empty.hidden = view.items.length > 0;
  hint.textContent = t('popup.hint', { size: bytes(view.minSize) });
  clear.hidden = !view.items.some((i) => !isActive(i) && i.state !== 'paused');

  const running = view.items.filter((i) => i.state === 'running');
  const total = running.reduce((n, i) => n + i.speed, 0);
  const queued = view.items.filter((i) => i.state === 'queued').length;
  const parts: string[] = [];
  if (running.length) parts.push(t('popup.running', { count: running.length }));
  if (queued) parts.push(t('popup.queued', { count: queued }));
  if (total > 0) parts.push(speed(total));
  summary.textContent = parts.join(' · ');
}
