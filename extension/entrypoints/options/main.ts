import { bcp47, LOCALES, pickLocale, setLocale, t, translatePage } from '@/lib/i18n';
import { DEFAULT_SETTINGS, LIMITS, normalizeHost, readSettings, SETTING_KEYS, type Settings } from '@/lib/policy';
import { bytes, speed } from '@/lib/ui/format';

const MB = 1024 * 1024;
const MIN_SIZES = [1, 5, 10, 25, 50, 100];
const SPEED_LIMITS = [0, 1, 2, 5, 10, 25, 50, 100];

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const enabled = $<HTMLInputElement>('enabled');
const minSize = $<HTMLSelectElement>('minSize');
const connections = $<HTMLInputElement>('connections');
const connectionsValue = $<HTMLOutputElement>('connectionsValue');
const preview = $<HTMLElement>('preview');
const parallel = $<HTMLElement>('parallel');
const programs = $<HTMLInputElement>('programsToBrowser');
const checksum = $<HTMLInputElement>('checksum');
const notify = $<HTMLInputElement>('notify');
const language = $<HTMLSelectElement>('language');
const speedLimit = $<HTMLSelectElement>('speedLimit');
const site = $<HTMLInputElement>('site');
const siteError = $<HTMLElement>('siteError');
const excluded = $<HTMLUListElement>('excluded');
const noSites = $<HTMLElement>('noSites');
const status = $<HTMLElement>('status');

let current: Settings = { ...DEFAULT_SETTINGS };
let shownLanguage: string | null = null;
let statusTimer: ReturnType<typeof setTimeout> | undefined;

async function save(change: Partial<Settings>) {
  await browser.storage.local.set(change);
  status.textContent = t('settings.saved');
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => (status.textContent = ''), 1600);
}

/** Options whose labels depend on the language. */
function fillChoices(s: Settings) {
  const minMb = Math.round(s.minSize / MB);
  const sizes = [...new Set([...MIN_SIZES, minMb])].sort((a, b) => a - b);
  minSize.replaceChildren(...sizes.map((mb) => new Option(bytes(mb * MB), String(mb))));
  const limitMb = Math.round(s.speedLimit / MB);
  const limits = [...new Set([...SPEED_LIMITS, limitMb])].sort((a, b) => a - b);
  speedLimit.replaceChildren(
    ...limits.map((mb) => new Option(mb ? speed(mb * MB) : t('settings.speedLimitNone'), String(mb))),
  );
  // Each language named in itself, so anyone can find their own.
  const names = (code: string) => {
    try {
      return new Intl.DisplayNames([bcp47(code)], { type: 'language' }).of(bcp47(code)) ?? code;
    } catch {
      return code;
    }
  };
  language.replaceChildren(
    new Option(t('settings.languageAuto'), 'auto'),
    ...LOCALES.map((code) => new Option(names(code), code)).sort((a, b) => a.text.localeCompare(b.text)),
  );
}

async function render(s: Settings) {
  current = s;
  if (s.language !== shownLanguage) {
    shownLanguage = s.language;
    await setLocale(pickLocale(s.language));
    translatePage();
    document.title = t('settings.title');
  }
  fillChoices(s);
  enabled.checked = s.enabled;
  minSize.value = String(Math.round(s.minSize / MB));
  connections.max = String(LIMITS.connections[1]);
  connections.value = String(s.connections);
  showConnections(s.connections);
  for (const b of parallel.querySelectorAll('button')) {
    const on = Number(b.dataset.value) === s.parallel;
    b.setAttribute('aria-checked', String(on));
    b.tabIndex = on ? 0 : -1;
  }
  programs.checked = s.programsToBrowser;
  checksum.checked = s.checksum;
  notify.checked = s.notify;
  language.value = s.language;
  speedLimit.value = String(Math.round(s.speedLimit / MB));
  excluded.replaceChildren(
    ...s.excluded.map((host) => {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = host;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'link';
      remove.textContent = t('settings.siteRemove');
      remove.setAttribute('aria-label', t('settings.siteRemoveLabel', { host }));
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

// Simultaneous downloads: one button per choice, arrow keys move between them.
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
checksum.addEventListener('change', () => void save({ checksum: checksum.checked }));
notify.addEventListener('change', () => void save({ notify: notify.checked }));
language.addEventListener('change', () => void save({ language: language.value }));
speedLimit.addEventListener('change', () => void save({ speedLimit: Number(speedLimit.value) * MB }));

$<HTMLFormElement>('addSite').addEventListener('submit', (e) => {
  e.preventDefault();
  const host = normalizeHost(site.value);
  if (!host) {
    siteError.textContent = t('settings.siteInvalid');
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
  await render(readSettings(await browser.storage.local.get(SETTING_KEYS)));
}

void load();
