import { t } from '@/lib/i18n';
import { collectInPage, fileLinks, type PageLink, parseUrls } from '@/lib/links';
import type { Item, PopupCommand } from '@/lib/protocol';
import { bytes, duration, speed } from '@/lib/ui/format';
import { actionsFor, createRow, describe, iconButton, type Row, syncList } from '@/lib/ui/row';
import { paint, working } from '@/lib/ui/segbar';
import { connect, isActive, type View } from '@/lib/ui/store';

type Filter = 'all' | 'active' | 'completed' | 'problems';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const list = $<HTMLUListElement>('list');
const search = $<HTMLInputElement>('search');
const filters = $('filters');

let view: View | null = null;
let filter: Filter = 'all';
let query = '';
let selected: number | null = null;
const rows = new Map<number, Row>();

const send = connect((v) => {
  view = v;
  render();
});

function act(kind: string, id: number) {
  send({ type: kind === 'open' ? 'show' : kind, id } as PopupCommand);
}

// --- list -------------------------------------------------------------------

function matches(item: Item): boolean {
  if (filter === 'active' && !(isActive(item) || item.state === 'paused')) return false;
  if (filter === 'completed' && item.state !== 'completed') return false;
  if (filter === 'problems' && !['failed', 'browser', 'cancelled'].includes(item.state)) return false;
  if (!query) return true;
  return item.name.toLowerCase().includes(query) || (item.url ?? '').toLowerCase().includes(query);
}

function render() {
  if (!view) return;
  const shown = view.items.filter(matches);
  // A filter or search change rebuilds every row's place, not their content.
  syncList(
    list,
    rows,
    shown,
    (id) => {
      const row = createRow(id, act, true);
      row.el.tabIndex = 0;
      row.el.addEventListener('click', () => select(id));
      row.el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          select(id);
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          const next = (e.key === 'ArrowDown' ? row.el.nextElementSibling : row.el.previousElementSibling) as HTMLElement | null;
          next?.focus();
          if (next?.dataset.id) select(Number(next.dataset.id));
        }
      });
      return row;
    },
    view.changed,
  );
  for (const [id, row] of rows) row.el.setAttribute('aria-selected', String(id === selected));
  $('empty').hidden = shown.length > 0;
  $('count').textContent = t('downloads.total', { count: view.items.length });
  $('clear').hidden = !view.items.some((i) => !isActive(i) && i.state !== 'paused');
  const running = view.items.filter((i) => i.state === 'running');
  const total = running.reduce((n, i) => n + i.speed, 0);
  $('summary').textContent = [
    running.length ? t('popup.running', { count: running.length }) : '',
    total > 0 ? speed(total) : '',
  ]
    .filter(Boolean)
    .join(' · ');
  for (const b of filters.querySelectorAll<HTMLButtonElement>('button')) {
    const on = b.dataset.filter === filter;
    b.setAttribute('aria-checked', String(on));
    b.tabIndex = on ? 0 : -1;
  }
  if (selected !== null && !view.items.some((i) => i.id === selected)) selected = null;
  if (selected === null || !view.changed || view.changed.has(selected)) renderDetails();
}

function select(id: number) {
  selected = id;
  for (const [rid, row] of rows) row.el.setAttribute('aria-selected', String(rid === id));
  $<HTMLInputElement>('dCheck').value = '';
  renderDetails();
}

search.addEventListener('input', () => {
  query = search.value.trim().toLowerCase();
  if (view) view.changed = new Set();
  render();
});

filters.addEventListener('click', (e) => {
  const value = (e.target as HTMLElement).closest<HTMLButtonElement>('button')?.dataset.filter as Filter | undefined;
  if (!value) return;
  filter = value;
  if (view) view.changed = new Set();
  render();
});

$('clear').addEventListener('click', () => send({ type: 'clear' }));
$('settings').addEventListener('click', () => void browser.runtime.openOptionsPage());

// --- details ----------------------------------------------------------------

function renderDetails() {
  const item = view?.items.find((i) => i.id === selected);
  $('detailsEmpty').hidden = !!item;
  $('detailsBody').hidden = !item;
  if (!item) return;
  $('dName').textContent = item.name;
  $('dState').textContent = describe(item);
  $('dState').dataset.state = item.state;
  const bar = $('dBar');
  bar.dataset.state = item.state;
  bar.style.backgroundImage =
    item.total && item.state !== 'completed' ? paint(item.total, item.done, item.state === 'running' ? item.parts : undefined) : '';
  const url = $<HTMLAnchorElement>('dUrl');
  url.textContent = item.url ?? '—';
  // Only web addresses become links.
  if (item.url && /^https?:/i.test(item.url)) url.href = item.url;
  else url.removeAttribute('href');
  $('dSize').textContent = item.total ? bytes(item.total) : item.done ? bytes(item.done) : '—';
  const seconds = (item.elapsed ?? 0) / 1000;
  $('dTime').textContent = seconds >= 0.5 ? duration(seconds) : '—';
  $('dSpeed').textContent = seconds >= 0.5 && item.total ? speed(item.total / seconds) : item.speed ? speed(item.speed) : '—';
  const n = working(item.parts);
  $('dConns').textContent = item.state === 'running' && n ? String(n) : '—';

  const hash = item.sha256;
  const known = !!hash && hash !== 'pending';
  $('dHash').textContent =
    hash === 'pending'
      ? t('downloads.sha256Pending')
      : hash ?? (item.state === 'completed' && !view?.settings.checksum ? t('downloads.sha256Off') : '—');
  $('dCopy').hidden = !known;
  $('dCompare').hidden = !known;
  compare();

  const actions = $('dActions');
  const kinds = actionsFor(item.state, true);
  const key = `${item.id}|${kinds.join()}`;
  if (actions.dataset.key !== key) {
    actions.dataset.key = key;
    actions.replaceChildren(
      ...kinds.map((kind) => {
        const b = iconButton(kind);
        b.className = 'button ghost';
        b.append(document.createTextNode(t(`action.${kind}`)));
        b.addEventListener('click', () => act(kind, item.id));
        return b;
      }),
    );
  }
}

function compare() {
  const item = view?.items.find((i) => i.id === selected);
  const verdict = $('dVerdict');
  const typed = $<HTMLInputElement>('dCheck').value.trim().toLowerCase().replace(/^sha256[:=]\s*/, '');
  if (!item?.sha256 || item.sha256 === 'pending' || !typed) {
    verdict.textContent = '';
    delete verdict.dataset.ok;
    return;
  }
  const ok = typed === item.sha256;
  verdict.textContent = ok ? t('downloads.match') : t('downloads.mismatch');
  verdict.dataset.ok = String(ok);
}

$('dCheck').addEventListener('input', compare);
$('dCopy').addEventListener('click', async () => {
  const hash = view?.items.find((i) => i.id === selected)?.sha256;
  if (!hash) return;
  await navigator.clipboard.writeText(hash);
  const button = $('dCopy');
  button.textContent = t('downloads.copied');
  setTimeout(() => (button.textContent = t('downloads.copy')), 1500);
});

// --- add URLs ---------------------------------------------------------------

const adder = $<HTMLFormElement>('adder');
const urls = $<HTMLTextAreaElement>('urls');
$('add').addEventListener('click', () => {
  adder.hidden = !adder.hidden;
  $('add').setAttribute('aria-expanded', String(!adder.hidden));
  if (!adder.hidden) urls.focus();
});
adder.addEventListener('submit', (e) => {
  e.preventDefault();
  const found = parseUrls(urls.value);
  $('addStatus').textContent = found.length ? t('popup.addDone', { count: found.length }) : t('popup.addInvalid');
  if (!found.length) return;
  send({ type: 'urls', urls: found });
  urls.value = '';
});
urls.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) adder.requestSubmit();
});

// --- links of a page ("download all links") ---------------------------------

let picks: PageLink[] = [];
let pageUrl: string | undefined;
const chosen = new Set<string>();
const types = new Set<string>();

async function openGrab(tabId: number) {
  const panel = $('grab');
  panel.hidden = false;
  const message = $('grabMessage');
  try {
    const tab = await browser.tabs.get(tabId);
    pageUrl = tab.url;
    $('grabTitle').textContent = t('downloads.grabTitle', { site: tab.url ? new URL(tab.url).host : '' });
    if (tab.incognito || !/^https?:/.test(tab.url ?? '')) throw new Error('blocked');
    const raw = await readLinks(tabId);
    picks = fileLinks(raw);
  } catch {
    message.textContent = t('popup.grabBlocked');
    picks = [];
  }
  if (!picks.length && !message.textContent) message.textContent = t('popup.grabNone');
  // Every type found starts selected, as do all its links.
  for (const p of picks) {
    types.add(p.ext);
    chosen.add(p.url);
  }
  renderGrab();
}

/** The links of a tab, read by a script injected for this one request. */
async function readLinks(tabId: number): Promise<{ url: string; label: string }[]> {
  if (browser.scripting) {
    const [result] = await browser.scripting.executeScript({ target: { tabId }, func: collectInPage });
    return (result?.result as { url: string; label: string }[]) ?? [];
  }
  // Firefox MV2.
  const tabs = browser.tabs as unknown as { executeScript(id: number, d: { code: string }): Promise<unknown[]> };
  const [result] = await tabs.executeScript(tabId, { code: `(${collectInPage.toString()})()` });
  return (result as { url: string; label: string }[]) ?? [];
}

function renderGrab() {
  const exts = [...new Set(picks.map((p) => p.ext))].sort();
  $('grabTypes').replaceChildren(
    ...exts.map((ext) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.textContent = `.${ext} · ${picks.filter((p) => p.ext === ext).length}`;
      b.setAttribute('aria-pressed', String(types.has(ext)));
      b.addEventListener('click', () => {
        if (types.has(ext)) types.delete(ext);
        else types.add(ext);
        renderGrab();
      });
      return b;
    }),
  );
  const visible = picks.filter((p) => types.has(p.ext));
  $('grabList').replaceChildren(
    ...visible.map((p) => {
      const li = document.createElement('li');
      const label = document.createElement('label');
      label.className = 'check';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = chosen.has(p.url);
      box.addEventListener('change', () => {
        if (box.checked) chosen.add(p.url);
        else chosen.delete(p.url);
        renderGrabFoot(visible);
      });
      const name = document.createElement('span');
      name.className = 'pick-name';
      name.textContent = p.label;
      const url = document.createElement('span');
      url.className = 'pick-url';
      url.textContent = p.url;
      label.append(box, name, url);
      li.append(label);
      return li;
    }),
  );
  if (picks.length && !visible.length) $('grabMessage').textContent = t('downloads.grabEmpty');
  else if (picks.length) $('grabMessage').textContent = '';
  renderGrabFoot(visible);
}

function renderGrabFoot(visible: PageLink[]) {
  const count = visible.filter((p) => chosen.has(p.url)).length;
  const submit = $<HTMLButtonElement>('grabSubmit');
  submit.textContent = t('downloads.grabSubmit', { count });
  submit.disabled = count === 0;
  const all = $<HTMLInputElement>('grabAll');
  all.checked = count > 0 && count === visible.length;
  all.indeterminate = count > 0 && count < visible.length;
}

$<HTMLInputElement>('grabAll').addEventListener('change', (e) => {
  const on = (e.target as HTMLInputElement).checked;
  for (const p of picks.filter((x) => types.has(x.ext))) {
    if (on) chosen.add(p.url);
    else chosen.delete(p.url);
  }
  renderGrab();
});

$('grabSubmit').addEventListener('click', () => {
  const urls = picks.filter((p) => types.has(p.ext) && chosen.has(p.url)).map((p) => p.url);
  if (!urls.length) return;
  send({ type: 'urls', urls, referrer: pageUrl });
  closeGrab();
});

function closeGrab() {
  $('grab').hidden = true;
  history.replaceState(null, '', location.pathname);
}
$('grabClose').addEventListener('click', closeGrab);

const grabTab = /#grab=(\d+)/.exec(location.hash)?.[1];
if (grabTab) void openGrab(Number(grabTab));
