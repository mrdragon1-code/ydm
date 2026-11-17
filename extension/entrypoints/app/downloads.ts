/** The Downloads screen: search, filters, the list, and the details pane. */

import { render as text, t } from '@/lib/i18n';
import { collectInPage, extensionOf, fileLinks, type PageLink } from '@/lib/links';
import { linksInText } from '@/lib/ocr-links';
import type { Item, PopupCommand } from '@/lib/protocol';
import { wireAdder, wireRadioKeys } from '@/lib/ui/adder';
import { bytes, duration, sentence, speed } from '@/lib/ui/format';
import { actionsFor, createRow, describe, iconButton, type Row, syncList, updateShield } from '@/lib/ui/row';
import { paint, working } from '@/lib/ui/segbar';
import { isActive, type View } from '@/lib/ui/store';

type Filter = 'all' | 'active' | 'completed' | 'problems' | 'blocked';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export function downloadsScreen(send: (cmd: PopupCommand) => void, openAlert: (id: number) => void) {
  const list = $<HTMLUListElement>('list');
  const search = $<HTMLInputElement>('search');
  const filters = $('filters');
  let view: View | null = null;
  let filter: Filter = 'all';
  let query = '';
  let selected: number | null = null;
  const rows = new Map<number, Row>();
  // The same shield glyph as in the rows, borrowed from a row that is never
  // shown. The level is written out beside it, so it is hidden from readers.
  const dShield = createRow(-1, () => {}).shield;
  dShield.setAttribute('aria-hidden', 'true');
  $('dShield').replaceWith(dShield);

  function act(kind: string, id: number) {
    if (kind === 'decide') return openAlert(id);
    send({ type: kind === 'open' ? 'show' : kind, id } as PopupCommand);
  }

  function matches(item: Item): boolean {
    if (filter === 'active' && !(isActive(item) || item.state === 'paused' || item.state === 'held')) return false;
    if (filter === 'completed' && item.state !== 'completed') return false;
    if (filter === 'problems' && !['failed', 'browser', 'cancelled'].includes(item.state)) return false;
    if (filter === 'blocked' && item.state !== 'blocked' && item.security?.level !== 'malicious') return false;
    if (!query) return true;
    return item.name.toLowerCase().includes(query) || (item.url ?? '').toLowerCase().includes(query);
  }

  function render() {
    if (!view) return;
    const shown = view.items.filter(matches);
    syncList(
      list,
      rows,
      shown,
      (id) => {
        const row = createRow(id, act, true);
        row.el.setAttribute('role', 'option');
        row.el.tabIndex = -1;
        row.el.addEventListener('click', () => select(id, false));
        return row;
      },
      view.changed,
    );
    // One tab stop for the whole list: the selected row, or the first.
    const focusable = (selected !== null && rows.get(selected)) || rows.get(shown[0]?.id ?? -1);
    for (const [id, row] of rows) {
      row.el.setAttribute('aria-selected', String(id === selected));
      row.el.tabIndex = row === focusable ? 0 : -1;
    }
    $('empty').hidden = shown.length > 0;
    if (!shown.length) {
      // Nothing at all, or nothing that matches: two different answers.
      const none = view.items.length === 0;
      $('emptyTitle').textContent = t(none ? 'downloads.emptyNone' : 'downloads.emptyFiltered');
      $('emptyText').textContent = none ? t('popup.hint', { size: bytes(view.minSize) }) : t('downloads.emptyFilteredHelp');
      $('emptyReset').hidden = none;
    }
    $('count').textContent = t('downloads.total', { count: view.items.length });
    // With nothing downloaded yet, the list's empty state is the whole page:
    // no details pane to select from, no count of zero.
    const nothing = view.items.length === 0;
    $('details').hidden = nothing;
    $('listFoot').hidden = nothing;
    $('clear').hidden = !view.items.some((i) => !isActive(i) && i.state !== 'paused' && i.state !== 'held');
    const running = view.items.filter((i) => i.state === 'running');
    const queued = view.items.filter((i) => i.state === 'queued').length;
    const total = running.reduce((n, i) => n + i.speed, 0);
    // The same order as in the popup: the total speed, then the counts.
    $('summary').textContent = [
      total > 0 ? speed(total) : '',
      running.length ? t('popup.running', { count: running.length }) : '',
      queued ? t('popup.queued', { count: queued }) : '',
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

  function select(id: number, focus: boolean) {
    selected = id;
    for (const [rid, row] of rows) {
      row.el.setAttribute('aria-selected', String(rid === id));
      row.el.tabIndex = rid === id ? 0 : -1;
    }
    if (focus) rows.get(id)?.el.focus();
    $<HTMLInputElement>('dCheck').value = '';
    renderDetails();
  }

  // The list is a listbox: arrows move, Home/End jump, Enter selects.
  list.addEventListener('keydown', (e) => {
    const current = (e.target as HTMLElement).closest<HTMLElement>('li[data-id]');
    if (!current || e.target !== current) return;
    const all = [...list.querySelectorAll<HTMLElement>('li[data-id]')];
    const at = all.indexOf(current);
    const go = (i: number) => {
      const next = all[Math.max(0, Math.min(all.length - 1, i))];
      if (next) select(Number(next.dataset.id), true);
    };
    if (e.key === 'ArrowDown') go(at + 1);
    else if (e.key === 'ArrowUp') go(at - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(all.length - 1);
    else if (e.key === 'Enter' || e.key === ' ') select(Number(current.dataset.id), false);
    else return;
    e.preventDefault();
  });

  search.addEventListener('input', () => {
    query = search.value.trim().toLowerCase();
    if (view) view.changed = new Set();
    render();
  });

  const setFilter = (b: HTMLButtonElement) => {
    filter = (b.dataset.filter as Filter) ?? 'all';
    if (view) view.changed = new Set();
    render();
  };
  filters.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (b) setFilter(b);
  });
  wireRadioKeys(filters, setFilter);

  $('clear').addEventListener('click', () => send({ type: 'clear' }));

  $('emptyReset').addEventListener('click', () => {
    filter = 'all';
    query = '';
    search.value = '';
    if (view) view.changed = new Set();
    render();
    search.focus();
  });

  // --- details ------------------------------------------------------------

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
    // A bar only while there is progress to show.
    bar.hidden = !['queued', 'running', 'paused', 'saving'].includes(item.state);
    bar.style.backgroundImage =
      item.total && item.state !== 'completed' ? paint(item.total, item.done, item.state === 'running' ? item.parts : undefined) : '';

    const security = item.security;
    $('dSecurity').hidden = !security;
    if (security) {
      updateShield(dShield, item);
      $('dSecurity').dataset.level = security.level;
      $('dLevel').textContent = t(`security.level.${security.level}`);
      // A clean verdict needs no list: its title says it all. A finding the
      // state line already reads out is not repeated.
      const said = JSON.stringify(item.reason ?? null);
      const findings = security.findings.filter((f) => JSON.stringify(f.reason) !== said);
      $('dFindings').replaceChildren(
        ...(findings.length
          ? findings.map((f) => {
              const li = document.createElement('li');
              li.dataset.level = f.level;
              const source = document.createElement('span');
              source.className = 'source';
              source.textContent = ` · ${t(`security.source.${f.source}`)}`;
              li.append(sentence(text(f.reason)), source);
              return li;
            })
          : security.level === 'clean' || security.findings.length
            ? []
            : [Object.assign(document.createElement('li'), { textContent: t(`security.summary.${security.level}`) })]),
      );
    }

    const url = $<HTMLAnchorElement>('dUrl');
    url.textContent = item.url ?? '—';
    // Only web addresses become links, and never for a blocked one.
    if (item.url && /^https?:/i.test(item.url) && item.state !== 'blocked') url.href = item.url;
    else url.removeAttribute('href');
    $('dSize').textContent = item.total ? bytes(item.total) : item.done ? bytes(item.done) : '—';
    const seconds = (item.elapsed ?? 0) / 1000;
    $('dTime').textContent = seconds >= 0.5 ? duration(seconds) : '—';
    const average = seconds >= 0.5 && !!item.total;
    $('dSpeed').textContent = average ? speed(item.total! / seconds) : item.speed ? speed(item.speed) : '—';
    // While it runs, the speed is the one of this moment, not an average.
    $('dSpeedLabel').textContent = t(average ? 'downloads.avgSpeed' : 'downloads.speedNow');
    const n = working(item.parts);
    $('dConns').textContent = item.state === 'running' && n ? String(n) : '—';
    // A fact with no value yet is left out, not shown as a dash.
    for (const dd of $('detailsBody').querySelectorAll<HTMLElement>('.facts dd')) {
      dd.parentElement!.hidden = dd.textContent === '—';
    }

    const hash = item.sha256;
    const known = !!hash && hash !== 'pending';
    $('dHash').textContent =
      hash === 'pending'
        ? t('downloads.sha256Pending')
        : hash ?? (item.state === 'completed' && !view?.settings.checksum ? t('downloads.sha256Off') : '—');
    $('dCopy').hidden = !known;
    // No fingerprint to show or compare: the section has nothing to say.
    $('dHash').closest('section')!.hidden = $('dHash').textContent === '—';
    $('dCompare').hidden = !known;
    compare();

    const actions = $('dActions');
    const kinds = actionsFor(item.state, true);
    const key = `${item.id}|${kinds.join()}|${t('action.pause')}`;
    if (actions.dataset.key !== key) {
      actions.dataset.key = key;
      actions.replaceChildren(
        ...kinds.map((kind) => {
          const b = iconButton(kind);
          // Removing is set apart, as an icon at the end: it is not the
          // next thing you want to do with a file. Alone, it says its name.
          const apart = kind === 'remove' && kinds.length > 1;
          b.className = kind === 'decide' ? 'button' : apart ? 'button quiet only-icon' : 'button quiet';
          if (!apart) b.append(document.createTextNode(t(`action.${kind}`)));
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

  wireAdder($<HTMLButtonElement>('add'), $<HTMLFormElement>('adder'), $<HTMLTextAreaElement>('urls'), $('addStatus'), send, (image) =>
    void openOcr(image),
  );

  // --- links of a page ("download all links") -----------------------------

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
      picks = fileLinks(await readLinks(tabId));
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

  /** The links written in an image, read on this computer (OCR). `image`:
   * pasted or dropped here; none: the one chosen with the context menu. */
  /** The latest read: an older one finishing later shows nothing. */
  let ocrRun = 0;

  async function openOcr(source: Blob | string) {
    const run = ++ocrRun;
    const panel = $('grab');
    panel.hidden = false;
    panel.focus();
    const message = $('grabMessage');
    $('grabTitle').textContent = t('downloads.ocrTitle');
    picks = [];
    pageUrl = undefined;
    chosen.clear();
    types.clear();
    renderGrab();
    message.textContent = t('downloads.ocrReading', { percent: 0 });
    let found: PageLink[] = [];
    try {
      const image = typeof source === 'string' ? await requestedImage(source) : source;
      // The engine (a few MB) loads only when an image is read.
      const { readText } = await import('@/lib/ocr');
      const read = await readText(image, (share) => {
        if (run === ocrRun) message.textContent = t('downloads.ocrReading', { percent: Math.round(share * 100) });
      });
      if (run !== ocrRun) return;
      found = linksInText(read).map((url) => ({ url, label: nameOf(url), ext: extensionOf(url) }));
      message.textContent = found.length ? '' : t('downloads.ocrNone');
    } catch {
      if (run !== ocrRun) return;
      message.textContent = t('downloads.ocrFailed');
    }
    picks = found;
    for (const p of picks) {
      types.add(p.ext);
      chosen.add(p.url);
    }
    renderGrab();
  }

  /** The image a context menu or the popup left for this page, by id. Used
   * once. Only web and inline images: never local files or browser pages. */
  async function requestedImage(id: string): Promise<Blob> {
    const key = `ocr:${id}`;
    const stored = (await browser.storage.local.get(key))[key] as { src?: string; page?: string } | undefined;
    await browser.storage.local.remove(key);
    const src = stored?.src ?? '';
    if (!/^(https?:|data:image\/)/i.test(src)) throw new Error('not a web image');
    pageUrl = stored?.page;
    // With the site's cookies, as when the page showed it: the same request
    // the browser already made for that page.
    const res = await fetch(src, { credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.blob();
  }

  function nameOf(url: string): string {
    try {
      const u = new URL(url);
      return decodeURIComponent(u.pathname.split('/').at(-1) || u.host);
    } catch {
      return url;
    }
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
    // File types in order, then "other links" (no file extension) last.
    const exts = [...new Set(picks.map((p) => p.ext))].sort((a, b) => (!a ? 1 : !b ? -1 : a.localeCompare(b)));
    $('grabTypes').replaceChildren(
      ...exts.map((ext) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'chip';
        b.textContent = `${ext ? `.${ext}` : t('downloads.grabOther')} · ${picks.filter((p) => p.ext === ext).length}`;
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
    history.replaceState(null, '', `${location.pathname}#downloads`);
  }
  $('grabClose').addEventListener('click', closeGrab);

  return {
    update(v: View) {
      view = v;
      render();
    },
    /** `#downloads/grab=<tab>`: show the links of that tab. */
    route(arg: string | undefined) {
      const tab = /^grab=(\d+)$/.exec(arg ?? '')?.[1];
      if (tab) void openGrab(Number(tab));
      // `#downloads/ocr=<id>`: an image chosen with "Find links in this
      // image", or pasted in the popup.
      const ocr = /^ocr=([\w-]{8,64})$/.exec(arg ?? '')?.[1];
      if (ocr) void openOcr(ocr);
    },
    refresh() {
      if (view) {
        view.changed = null;
        render();
      }
    },
  };
}
