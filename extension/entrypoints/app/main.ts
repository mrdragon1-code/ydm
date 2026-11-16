/**
 * YDM's one page: Downloads, Security, Settings and About, behind a side
 * navigation (a top bar on narrow screens). Each screen has its own
 * address (`app.html#settings`), so links, the back button and a reload
 * all land where they should.
 */

import { t } from '@/lib/i18n';
import { connect, type View } from '@/lib/ui/store';
import { downloadsScreen } from './downloads';
import { settingsScreens } from './settings';

type Route = 'downloads' | 'security' | 'settings' | 'about';
const ROUTES: Route[] = ['downloads', 'security', 'settings', 'about'];

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let view: View | null = null;
let route: Route = 'downloads';

/** The warning window of a held or blocked download. */
function openAlert(id: number) {
  void browser.windows
    .create({ url: browser.runtime.getURL(`/alert.html#${id}`), type: 'popup', width: 440, height: 560 })
    .catch(() => void browser.tabs.create({ url: browser.runtime.getURL(`/alert.html#${id}`) }));
}

const send = connect((v) => {
  view = v;
  downloads.update(v);
  settings.renderHistory(v.items, v.changed);
  renderShell();
});
const downloads = downloadsScreen(send, openAlert);
const settings = settingsScreens(openAlert);

function renderShell() {
  if (!view) return;
  $<HTMLInputElement>('power').checked = view.enabled;
  const active = view.items.filter((i) => ['queued', 'running', 'saving'].includes(i.state)).length;
  $('navCount').textContent = active ? String(active) : '';
  const held = view.items.filter((i) => i.state === 'held');
  const navAlert = $('navAlert');
  navAlert.hidden = !held.length;
  navAlert.textContent = held.length ? String(held.length) : '';
  navAlert.title = held.length ? t('app.waiting', { count: held.length }) : '';
  const attention = $('attention');
  attention.hidden = !held.length;
  if (held.length) {
    $('attentionText').textContent = t('app.waiting', { count: held.length });
    attention.dataset.id = String(held[0]!.id);
  }
  const update = $('update');
  update.hidden = !view.update;
  if (view.update) {
    $('updateText').textContent = t('update.available', { version: view.update.version });
    $<HTMLAnchorElement>('updateLink').href = view.update.url;
  }
  document.title = `${t(`app.${route}`)} · YDM`;
}

$('attentionOpen').addEventListener('click', () => {
  const id = Number($('attention').dataset.id);
  if (id) openAlert(id);
});
$('power').addEventListener('change', (e) => send({ type: 'enabled', value: (e.target as HTMLInputElement).checked }));

/** `#settings`, `#downloads/grab=12`: the screen, and what follows the slash. */
function go() {
  const [name, arg] = location.hash.slice(1).split('/');
  // Old addresses: downloads.html#grab=12 forwarded here as #grab=12.
  const legacy = /^grab=\d+$/.test(name ?? '');
  route = legacy ? 'downloads' : ROUTES.includes(name as Route) ? (name as Route) : 'downloads';
  for (const section of document.querySelectorAll<HTMLElement>('[data-view]')) {
    section.hidden = section.dataset.view !== route;
  }
  for (const a of document.querySelectorAll<HTMLAnchorElement>('[data-route]')) {
    if (a.dataset.route === route) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  // Notices above the screen take its width.
  $('content').dataset.route = route;
  if (route === 'downloads') downloads.route(legacy ? name : arg);
  document.title = `${t(`app.${route}`)} · YDM`;
}

window.addEventListener('hashchange', () => {
  go();
  // A screen change moves focus to its content, as a new page would.
  $('content').focus({ preventScroll: true });
  window.scrollTo(0, 0);
});

// About.
$('version').textContent = browser.runtime.getManifest().version;
const repo = import.meta.env.YDM_REPO as string | undefined;
const repoLink = $<HTMLAnchorElement>('repo');
if (repo) repoLink.href = `https://github.com/${repo}`;
else repoLink.hidden = true;

go();
void settings.load();
