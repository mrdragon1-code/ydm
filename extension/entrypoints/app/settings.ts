/** The Settings and Security screens. Every change is saved at once. */

import { bcp47, LOCALES, MACHINE_LOCALES, t } from '@/lib/i18n';
import { type Category, cleanFolder, cleanRule, defaultFolders, MAX_RULES } from '@/lib/folders';
import { DEFAULT_SETTINGS, LIMITS, normalizeHost, readSettings, SETTING_KEYS, type Settings } from '@/lib/policy';
import type { Item } from '@/lib/protocol';
import { endpoints } from '@/lib/scanner';
import { testKey } from '@/lib/security';
import { wireRadioKeys } from '@/lib/ui/adder';
import { bytes, speed } from '@/lib/ui/format';
import { createRow, type Row, syncList } from '@/lib/ui/row';

const MB = 1024 * 1024;
const CATEGORIES: Category[] = ['video', 'audio', 'images', 'documents', 'archives', 'programs'];
const MIN_SIZES = [1, 5, 10, 25, 50, 100];
const SPEED_LIMITS = [0, 1, 2, 5, 10, 25, 50, 100];

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export function settingsScreens(openAlert: (id: number) => void) {
  const status = $('status');
  let current: Settings = { ...DEFAULT_SETTINGS };
  let statusTimer: ReturnType<typeof setTimeout> | undefined;

  async function save(change: Partial<Settings>) {
    await browser.storage.local.set(change);
    status.textContent = t('settings.saved');
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => (status.textContent = ''), 1600);
  }

  // --- switches and choices -----------------------------------------------

  const switches = ['enabled', 'programsToBrowser', 'checksum', 'notify', 'scanLocal', 'askOnSuspicious'] as const;
  for (const key of switches) {
    const box = $<HTMLInputElement>(key);
    box.addEventListener('change', () => void save({ [key]: box.checked }));
  }

  const minSize = $<HTMLSelectElement>('minSize');
  const speedLimit = $<HTMLSelectElement>('speedLimit');
  const language = $<HTMLSelectElement>('language');
  const connections = $<HTMLInputElement>('connections');
  const parallel = $('parallel');
  minSize.addEventListener('change', () => void save({ minSize: Number(minSize.value) * MB }));
  speedLimit.addEventListener('change', () => void save({ speedLimit: Number(speedLimit.value) * MB }));
  language.addEventListener('change', () => void save({ language: language.value }));
  connections.addEventListener('input', () => showConnections(Number(connections.value)));
  connections.addEventListener('change', () => void save({ connections: Number(connections.value) }));

  for (let n = LIMITS.parallel[0]; n <= LIMITS.parallel[1]; n++) {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.dataset.value = String(n);
    b.textContent = String(n);
    b.addEventListener('click', () => void save({ parallel: n }));
    parallel.append(b);
  }
  wireRadioKeys(parallel, (b) => void save({ parallel: Number(b.dataset.value) }));

  /** The value, and the file cut into that many bands. */
  function showConnections(n: number) {
    $('connectionsValue').textContent = String(n);
    const band = 100 / n;
    const stops = Array.from({ length: n }, (_, i) => {
      const from = i * band;
      const to = (i + 1) * band;
      return `var(--malachite) ${from.toFixed(2)}% calc(${to.toFixed(2)}% - 3px), transparent calc(${to.toFixed(2)}% - 3px) ${to.toFixed(2)}%`;
    });
    $('preview').style.backgroundImage = `linear-gradient(90deg, ${stops.join(', ')})`;
    // The slider's track is filled up to the middle of its thumb (16px).
    const [min, max] = [Number(connections.min) || 1, Number(connections.max) || 6];
    const at = (n - min) / Math.max(1, max - min);
    connections.style.setProperty('--fill', `calc(8px + (100% - 16px) * ${at.toFixed(4)})`);
  }

  /** Options whose labels depend on the language. */
  function fillChoices(s: Settings) {
    const minMb = Math.round(s.minSize / MB);
    const sizes = [...new Set([...MIN_SIZES, minMb])].sort((a, b) => a - b);
    minSize.replaceChildren(...sizes.map((mb) => new Option(bytes(mb * MB), String(mb))));
    const limitMb = Math.round(s.speedLimit / MB);
    const limits = [...new Set([...SPEED_LIMITS, limitMb])].sort((a, b) => a - b);
    speedLimit.replaceChildren(...limits.map((mb) => new Option(mb ? speed(mb * MB) : t('settings.speedLimitNone'), String(mb))));
    // Each language named in itself, so anyone can find their own.
    const names = (code: string) => {
      try {
        return new Intl.DisplayNames([bcp47(code)], { type: 'language' }).of(bcp47(code)) ?? code;
      } catch {
        return code;
      }
    };
    const machine = 'Translator' in globalThis ? MACHINE_LOCALES.filter((c) => !LOCALES.some((l) => l.startsWith(c))) : [];
    const suffix = ` · ${t('translate.machine')}`;
    language.replaceChildren(
      new Option(t('settings.languageAuto'), 'auto'),
      ...[...LOCALES.map((code) => new Option(names(code), code)), ...machine.map((code) => new Option(names(code) + suffix, code))].sort((a, b) =>
        a.text.localeCompare(b.text),
      ),
    );
    if (![...language.options].some((o) => o.value === s.language)) language.add(new Option(names(s.language), s.language));
  }

  // --- excluded sites -----------------------------------------------------

  const site = $<HTMLInputElement>('site');
  const siteError = $('siteError');
  $<HTMLFormElement>('addSite').addEventListener('submit', (e) => {
    e.preventDefault();
    const host = normalizeHost(site.value);
    if (!host) {
      siteError.textContent = t('settings.siteInvalid');
      site.setAttribute('aria-invalid', 'true');
      site.focus();
      return;
    }
    siteError.textContent = '';
    site.removeAttribute('aria-invalid');
    site.value = '';
    if (!current.excluded.includes(host)) void save({ excluded: [...current.excluded, host] });
  });
  site.addEventListener('input', () => {
    siteError.textContent = '';
    site.removeAttribute('aria-invalid');
  });

  // --- folders -------------------------------------------------------------

  const organize = $<HTMLInputElement>('organize');
  const folderError = $('folderError');
  organize.addEventListener('change', () => {
    // Turned on for the first time: the folders are named in the
    // interface's language, then kept as they are.
    const untouched = JSON.stringify(current.folders) === JSON.stringify(DEFAULT_SETTINGS.folders);
    void save(organize.checked && untouched ? { organize: true, folders: defaultFolders(t) } : { organize: organize.checked });
  });
  // Firefox cannot sort the files it downloads by itself: said where it matters.
  $('organizeFirefox').hidden = 'onDeterminingFilename' in browser.downloads;

  const folderInputs = new Map<Category, HTMLInputElement>();
  const folderNames = $('folderNames');
  for (const kind of CATEGORIES) {
    const row = document.createElement('div');
    row.className = 'row';
    const label = document.createElement('label');
    label.htmlFor = `folder-${kind}`;
    label.dataset.kind = kind;
    const input = document.createElement('input');
    input.type = 'text';
    input.id = `folder-${kind}`;
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('aria-describedby', 'folderError');
    input.addEventListener('change', () => {
      const clean = cleanFolder(input.value);
      if (clean === null) {
        folderError.textContent = t('settings.folderInvalid');
        input.setAttribute('aria-invalid', 'true');
        input.focus();
        return;
      }
      folderError.textContent = '';
      input.removeAttribute('aria-invalid');
      input.value = clean;
      void save({ folders: { ...current.folders, [kind]: clean } });
    });
    row.append(label, input);
    folderNames.append(row);
    folderInputs.set(kind, input);
  }

  const ruleKind = $<HTMLSelectElement>('ruleKind');
  const ruleMatch = $<HTMLInputElement>('ruleMatch');
  const ruleFolder = $<HTMLInputElement>('ruleFolder');
  const ruleError = $('ruleError');
  $<HTMLFormElement>('addRule').addEventListener('submit', (e) => {
    e.preventDefault();
    // A pasted address becomes its site, as for excluded sites.
    const match = ruleKind.value === 'site' ? (normalizeHost(ruleMatch.value) ?? ruleMatch.value) : ruleMatch.value;
    const rule = cleanRule({ kind: ruleKind.value, match, folder: ruleFolder.value });
    if (!rule || !rule.folder) {
      ruleError.textContent = t('settings.ruleInvalid');
      ruleMatch.setAttribute('aria-invalid', 'true');
      ruleMatch.focus();
      return;
    }
    ruleError.textContent = '';
    ruleMatch.removeAttribute('aria-invalid');
    ruleMatch.value = '';
    ruleFolder.value = '';
    const others = current.rules.filter((r) => !(r.kind === rule.kind && r.match === rule.match));
    void save({ rules: [...others, rule].slice(0, MAX_RULES) });
  });
  ruleMatch.addEventListener('input', () => {
    ruleError.textContent = '';
    ruleMatch.removeAttribute('aria-invalid');
  });

  // Restoring takes two clicks: the button asks first, in place.
  const reset = $<HTMLButtonElement>('reset');
  let resetArmed: ReturnType<typeof setTimeout> | undefined;
  reset.addEventListener('click', () => {
    if (resetArmed === undefined) {
      reset.textContent = t('settings.resetConfirm');
      resetArmed = setTimeout(() => {
        resetArmed = undefined;
        reset.textContent = t('settings.reset');
      }, 4000);
      return;
    }
    clearTimeout(resetArmed);
    resetArmed = undefined;
    reset.textContent = t('settings.reset');
    // Keys are the user's own: restoring the defaults keeps them.
    const { virusTotalKey: _v, abuseChKey: _a, ...rest } = DEFAULT_SETTINGS;
    void save(rest);
  });

  // --- API keys -----------------------------------------------------------

  type Service = 'virusTotal' | 'abuseCh';
  const KEY_FIELD: Record<Service, 'virusTotalKey' | 'abuseChKey'> = { virusTotal: 'virusTotalKey', abuseCh: 'abuseChKey' };
  const FORM: Record<Service, string> = { virusTotal: 'vt', abuseCh: 'ac' };

  for (const service of ['virusTotal', 'abuseCh'] as Service[]) {
    const prefix = FORM[service];
    const form = $<HTMLFormElement>(`${prefix}Form`);
    const input = $<HTMLInputElement>(`${prefix}Key`);
    const error = $(`${prefix}Error`);
    const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const key = input.value.trim();
      error.textContent = '';
      if (!/^[!-~]{16,128}$/.test(key)) {
        error.textContent = t('security.keyInvalid');
        input.setAttribute('aria-invalid', 'true');
        input.focus();
        return;
      }
      // Firefox asks for consent before an add-on sends addresses anywhere.
      if (!(await askDataConsent())) {
        error.textContent = t('security.consentNeeded');
        return;
      }
      submit.disabled = true;
      submit.textContent = t('security.keyTesting');
      const works = await testKey(service, key, fetch, endpoints()).catch(() => false);
      submit.disabled = false;
      submit.textContent = t('security.keySave');
      if (!works) {
        error.textContent = t('security.keyRejected');
        input.setAttribute('aria-invalid', 'true');
        return;
      }
      input.value = '';
      input.removeAttribute('aria-invalid');
      await save({ [KEY_FIELD[service]]: key });
    });
    input.addEventListener('input', () => {
      error.textContent = '';
      input.removeAttribute('aria-invalid');
    });
    form.querySelector<HTMLButtonElement>('[data-remove]')!.addEventListener('click', () => void save({ [KEY_FIELD[service]]: '' }));
  }

  /** Firefox 140+: the optional data consent declared in the manifest. Other
   * browsers have none; the key itself is the user's consent there. */
  async function askDataConsent(): Promise<boolean> {
    if (!import.meta.env.FIREFOX) return true;
    const permissions = browser.permissions as unknown as {
      request(p: { data_collection: string[] }): Promise<boolean>;
    };
    try {
      return await permissions.request({ data_collection: ['browsingActivity', 'websiteActivity'] });
    } catch {
      // A Firefox without the consent API: nothing to ask.
      return true;
    }
  }

  // --- render -------------------------------------------------------------

  function render(s: Settings) {
    current = s;
    fillChoices(s);
    for (const key of switches) $<HTMLInputElement>(key).checked = s[key];
    minSize.value = String(Math.round(s.minSize / MB));
    connections.max = String(LIMITS.connections[1]);
    connections.value = String(s.connections);
    showConnections(s.connections);
    for (const b of parallel.querySelectorAll<HTMLButtonElement>('button')) {
      const on = Number(b.dataset.value) === s.parallel;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    }
    language.value = s.language;
    speedLimit.value = String(Math.round(s.speedLimit / MB));
    $('excluded').replaceChildren(
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
    $('noSites').hidden = s.excluded.length > 0;

    organize.checked = s.organize;
    for (const [kind, input] of folderInputs) {
      const label = input.labels?.[0];
      if (label) label.textContent = t('settings.folderLabel', { kind: t(`kinds.${kind}`) });
      if (document.activeElement !== input) input.value = s.folders[kind];
      input.disabled = !s.organize;
    }
    $('rules').replaceChildren(
      ...s.rules.map((rule) => {
        const li = document.createElement('li');
        const text = document.createElement('span');
        const match = rule.kind === 'ext' ? `.${rule.match}` : rule.match;
        text.textContent = t('settings.ruleText', { match, folder: rule.folder });
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'link';
        remove.textContent = t('settings.ruleRemove');
        remove.setAttribute('aria-label', t('settings.ruleRemoveLabel', { match }));
        remove.addEventListener('click', () => void save({ rules: current.rules.filter((r) => r !== rule && !(r.kind === rule.kind && r.match === rule.match)) }));
        li.append(text, remove);
        return li;
      }),
    );
    $('noRules').hidden = s.rules.length > 0;

    // Keys: only whether one is set; the key never comes back to the page.
    for (const service of ['virusTotal', 'abuseCh'] as Service[]) {
      const prefix = FORM[service];
      const set = !!s[KEY_FIELD[service]];
      const pill = $(`${prefix}State`);
      pill.textContent = t(set ? 'security.keyOn' : 'security.keyOff');
      pill.dataset.on = String(set);
      if (set) pill.dataset.tone = 'ok';
      else delete pill.dataset.tone;
      $<HTMLInputElement>(`${prefix}Key`).placeholder = t(set ? 'security.keyReplace' : 'security.keyPlaceholder');
      $(`${prefix}Form`).querySelector<HTMLElement>('[data-remove]')!.hidden = !set;
    }
    const online = !!(s.virusTotalKey || s.abuseChKey);
    const level = !s.scanLocal && !online ? 'off' : online ? 'online' : 'local';
    $('secStatus').dataset.level = level;
    $('secTitle').textContent = t(`security.status.${level}`);
    $('secText').textContent = t(`security.status.${level}Help`);
  }

  // --- history of checks ---------------------------------------------------

  const history = $<HTMLUListElement>('history');
  const historyRows = new Map<number, Row>();
  function renderHistory(items: Item[], changed: Set<number> | null) {
    const flagged = items.filter((i) => i.security && i.security.level !== 'clean').slice(0, 50);
    syncList(
      history,
      historyRows,
      flagged,
      (id) => createRow(id, (kind, item) => kind === 'decide' && openAlert(item)),
      changed,
    );
    $('historyEmpty').hidden = flagged.length > 0;
  }

  async function load() {
    // The keys stay in storage; pages see only whether one is set.
    const stored = readSettings(await browser.storage.local.get(SETTING_KEYS));
    render({ ...stored, virusTotalKey: stored.virusTotalKey ? '•' : '', abuseChKey: stored.abuseChKey ? '•' : '' });
  }

  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && SETTING_KEYS.some((k) => changes[k])) void load();
  });

  return { load, renderHistory, refresh: () => render(current) };
}
