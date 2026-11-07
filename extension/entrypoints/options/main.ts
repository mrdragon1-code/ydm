import { DEFAULT_SETTINGS, LIMITS, normalizeHost, readSettings, SETTING_KEYS, type Settings } from '@/lib/policy';

const MB = 1024 * 1024;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const enabled = $<HTMLInputElement>('enabled');
const minSize = $<HTMLSelectElement>('minSize');
const connections = $<HTMLInputElement>('connections');
const connectionsValue = $<HTMLOutputElement>('connectionsValue');
const preview = $<HTMLElement>('preview');
const parallel = $<HTMLElement>('parallel');
const programs = $<HTMLInputElement>('programsToBrowser');
const speedLimit = $<HTMLSelectElement>('speedLimit');
const site = $<HTMLInputElement>('site');
const siteError = $<HTMLElement>('siteError');
const excluded = $<HTMLUListElement>('excluded');
const noSites = $<HTMLElement>('noSites');
const status = $<HTMLElement>('status');

let current: Settings = { ...DEFAULT_SETTINGS };
let statusTimer: ReturnType<typeof setTimeout> | undefined;

async function save(change: Partial<Settings>) {
  await browser.storage.local.set(change);
  status.textContent = 'Salvato';
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => (status.textContent = ''), 1600);
}

function render(s: Settings) {
  current = s;
  enabled.checked = s.enabled;
  const mb = Math.round(s.minSize / MB);
  // A value set elsewhere that is not one of the choices still shows.
  if (![...minSize.options].some((o) => Number(o.value) === mb)) minSize.add(new Option(`${mb} MB`, String(mb)));
  minSize.value = String(mb);
  connections.value = String(s.connections);
  showConnections(s.connections);
  for (const b of parallel.querySelectorAll('button')) {
    const on = Number(b.dataset.value) === s.parallel;
    b.setAttribute('aria-checked', String(on));
    b.tabIndex = on ? 0 : -1;
  }
  programs.checked = s.programsToBrowser;
  const limitMb = Math.round(s.speedLimit / MB);
  if (![...speedLimit.options].some((o) => Number(o.value) === limitMb)) {
    speedLimit.add(new Option(`${limitMb} MB/s`, String(limitMb)));
  }
  speedLimit.value = String(limitMb);
  excluded.replaceChildren(
    ...s.excluded.map((host) => {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = host;
      const remove = document.createElement('button');
      remove.className = 'link';
      remove.textContent = 'Togli';
      remove.setAttribute('aria-label', `Togli ${host}`);
      remove.addEventListener('click', () => void save({ excluded: current.excluded.filter((h) => h !== host) }));
      li.append(name, remove);
      return li;
    }),
  );
  noSites.hidden = s.excluded.length > 0;
}

/** The value, and the file cut into that many bands. */
function showConnections(n: number) {
  connectionsValue.textContent = String(n);
  const band = 100 / n;
  const stops = Array.from({ length: n }, (_, i) => {
    const from = i * band;
    const to = (i + 1) * band;
    return `var(--malachite) ${from.toFixed(2)}% calc(${to.toFixed(2)}% - 3px), transparent calc(${to.toFixed(2)}% - 3px) ${to.toFixed(2)}%`;
  });
  preview.style.backgroundImage = `linear-gradient(90deg, ${stops.join(', ')})`;
}

// Download contemporanei: one button per choice, arrow keys move between them.
for (let n = LIMITS.parallel[0]; n <= LIMITS.parallel[1]; n++) {
  const b = document.createElement('button');
  b.type = 'button';
  b.role = 'radio';
  b.dataset.value = String(n);
  b.textContent = String(n);
  b.addEventListener('click', () => void save({ parallel: n }));
  b.addEventListener('keydown', (e) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = Math.min(LIMITS.parallel[1], Math.max(LIMITS.parallel[0], current.parallel + step));
    void save({ parallel: next }).then(() => parallel.querySelector<HTMLButtonElement>(`[data-value="${next}"]`)?.focus());
  });
  parallel.append(b);
}

enabled.addEventListener('change', () => void save({ enabled: enabled.checked }));
minSize.addEventListener('change', () => void save({ minSize: Number(minSize.value) * MB }));
connections.addEventListener('input', () => showConnections(Number(connections.value)));
connections.addEventListener('change', () => void save({ connections: Number(connections.value) }));
programs.addEventListener('change', () => void save({ programsToBrowser: programs.checked }));
speedLimit.addEventListener('change', () => void save({ speedLimit: Number(speedLimit.value) * MB }));

$<HTMLFormElement>('addSite').addEventListener('submit', (e) => {
  e.preventDefault();
  const host = normalizeHost(site.value);
  if (!host) {
    siteError.textContent = 'Non è un indirizzo di un sito. Scrivi per esempio mega.nz o www.esempio.it.';
    return;
  }
  siteError.textContent = '';
  site.value = '';
  if (!current.excluded.includes(host)) void save({ excluded: [...current.excluded, host] });
});
site.addEventListener('input', () => (siteError.textContent = ''));

$<HTMLButtonElement>('reset').addEventListener('click', () => void save({ ...DEFAULT_SETTINGS }));

// Also reflects changes made from the popup while this page is open.
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !SETTING_KEYS.some((k) => changes[k])) return;
  void load();
});

async function load() {
  render(readSettings(await browser.storage.local.get(SETTING_KEYS)));
}

void load();
