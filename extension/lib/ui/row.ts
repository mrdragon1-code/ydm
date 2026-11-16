/** One download as a list row, updated in place so a button never
 * disappears under the cursor between two progress updates. */

import { render as text, t } from '../i18n';
import type { Item, State } from '../protocol';
import { bytes, duration, percent, speed } from './format';
import { paint, working } from './segbar';

export type Action = 'pause' | 'resume' | 'cancel' | 'retry' | 'show' | 'open' | 'remove' | 'decide';

/** Each icon's SVG path. */
export const ICONS: Record<Action, string> = {
  pause: 'M5.5 4v8M10.5 4v8',
  resume: 'M5 3.5l7 4.5-7 4.5z',
  cancel: 'M4.5 4.5l7 7M11.5 4.5l-7 7',
  retry: 'M12.5 8a4.5 4.5 0 1 1-1.3-3.2M12.5 3v2.5H10',
  show: 'M2.5 4.5h3.5l1.5 1.5h6v6h-11z',
  open: 'M9 3.5h3.5V7M12.5 3.5L7 9M11 9.5v3H3.5V5h3',
  remove: 'M3.5 5h9M6.5 5V3.5h3V5M5 5l.5 7.5h5L11 5',
  decide: 'M8 2.5l5 2v3.5c0 3-2.2 5-5 5.5-2.8-.5-5-2.5-5-5.5V4.5zM8 5.5v3M8 10.5v.01',
};

const SVG = 'http://www.w3.org/2000/svg';

function icon(d: string): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('d', d);
  svg.append(path);
  return svg;
}

export function actionsFor(state: State, extended = false): Action[] {
  switch (state) {
    case 'queued':
    case 'running':
      return ['pause', 'cancel'];
    case 'paused':
      return ['resume', 'cancel'];
    case 'saving':
      return ['cancel'];
    case 'completed':
      return extended ? ['open', 'show', 'remove'] : ['show'];
    case 'failed':
    case 'cancelled':
      return extended ? ['retry', 'remove'] : ['retry'];
    case 'browser':
      return extended ? ['remove'] : [];
    case 'held':
      return ['decide'];
    case 'blocked':
      return extended ? ['remove'] : [];
  }
}

export function iconButton(kind: Action): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'icon';
  b.dataset.kind = kind;
  const label = t(`action.${kind}`);
  b.title = label;
  b.setAttribute('aria-label', label);
  b.append(icon(ICONS[kind]));
  return b;
}

export interface Row {
  el: HTMLLIElement;
  /** The file-type tile: the extension, as a file manager shows it. */
  kind: HTMLElement;
  name: HTMLElement;
  shield: HTMLElement;
  bar: HTMLElement;
  text: HTMLElement;
  conns: HTMLElement;
  actions: HTMLElement;
}

/** `onAction` gets clicks on the row's buttons. */
export function createRow(id: number, onAction: (kind: Action, id: number) => void, extended = false): Row {
  const el = document.createElement('li');
  el.dataset.id = String(id);
  const kind = div('kind');
  kind.setAttribute('aria-hidden', 'true');
  const name = div('name');
  const label = document.createElement('span');
  label.className = 'label';
  const shield = createShield();
  name.append(shield, label);
  const bar = div('segbar');
  bar.setAttribute('role', 'progressbar');
  bar.setAttribute('aria-valuemin', '0');
  bar.setAttribute('aria-valuemax', '100');
  const meta = div('meta');
  const text = document.createElement('span');
  text.className = 'text';
  const conns = document.createElement('span');
  conns.className = 'conns';
  meta.append(text, conns);
  const actions = div('actions');
  actions.addEventListener('click', (e) => {
    const kind = (e.target as Element).closest<HTMLButtonElement>('button')?.dataset.kind as Action | undefined;
    if (kind) {
      e.stopPropagation();
      onAction(kind, id);
    }
  });
  if (extended) actions.dataset.extended = '';
  el.append(kind, name, actions, bar, meta);
  return { el, kind, name: label, shield, bar, text, conns, actions };
}

export function updateRow(row: Row, item: Item) {
  row.el.dataset.state = item.state;
  // Names come from servers: text only, never markup.
  row.name.textContent = item.name;
  row.name.title = item.name;
  const ext = extension(item.name);
  if (row.kind.dataset.ext !== ext) {
    row.kind.dataset.ext = ext;
    if (ext) row.kind.textContent = ext;
    else row.kind.replaceChildren(icon(FILE));
  }
  updateShield(row.shield, item);
  if (item.total) {
    const pct = Math.min(100, Math.round((item.done / item.total) * 100));
    row.bar.setAttribute('aria-valuenow', String(item.state === 'completed' ? 100 : pct));
  } else {
    row.bar.removeAttribute('aria-valuenow');
  }
  row.bar.setAttribute('aria-label', item.name);
  row.text.textContent = describe(item);
  // The line may be cut short; the whole text is one hover away.
  row.text.title = row.text.textContent;
  const n = working(item.parts);
  row.conns.textContent = item.state === 'running' && n > 1 ? t('popup.connections', { count: n }) : '';
  row.conns.title = row.conns.textContent ? t('popup.connectionsTitle', { count: n }) : '';
  row.el.classList.toggle('indeterminate', item.state === 'running' && !item.total);
  const showsBar = (item.state === 'running' || item.state === 'paused' || item.state === 'queued') && item.total;
  row.bar.style.backgroundImage = showsBar
    ? paint(item.total!, item.done, item.state === 'running' ? item.parts : undefined)
    : '';

  const kinds = actionsFor(item.state, row.actions.dataset.extended !== undefined);
  // Rebuilt also when the language changes, for the labels.
  const key = `${kinds.join()}|${t('action.pause')}`;
  if (row.actions.dataset.kinds !== key) {
    row.actions.dataset.kinds = key;
    row.actions.replaceChildren(...kinds.map(iconButton));
  }
}

const FILE = 'M4.5 2.5h4.5l3 3v8h-7.5zM9 2.5v3h3';

/** The name's extension, short enough for the tile; '' when it has none. */
export function extension(name: string): string {
  const ext = /\.([a-z0-9]{1,4})$/i.exec(name)?.[1] ?? '';
  return /^\d+$/.test(ext) ? '' : ext.toUpperCase();
}

export function describe(item: Item): string {
  switch (item.state) {
    case 'queued':
      return item.done > 0 && item.total && item.resumable
        ? t('state.queuedResume', { pct: percent(item.done, item.total) })
        : t('state.queued');
    case 'paused':
      if (!item.total || !item.done) return t('state.paused');
      return item.resumable ? t('state.pausedAt', { pct: percent(item.done, item.total) }) : t('state.pausedRestart');
    case 'running': {
      const parts = [item.total ? percent(item.done, item.total) : bytes(item.done)];
      if (item.speed > 0) {
        parts.push(speed(item.speed));
        if (item.total) parts.push(t('state.remaining', { time: duration((item.total - item.done) / item.speed) }));
      }
      return parts.join(' · ');
    }
    case 'saving':
      return t('state.saving');
    case 'completed': {
      if (!item.total) return t('state.completed');
      // Time and average speed, to compare with the browser's own download.
      const seconds = (item.elapsed ?? 0) / 1000;
      if (seconds < 0.5) return bytes(item.total);
      return t('state.completedStats', {
        size: bytes(item.total),
        time: duration(seconds),
        speed: bytes(item.total / seconds),
      });
    }
    case 'failed':
      return item.reason ? t('state.failedReason', { reason: text(item.reason) }) : t('state.failed');
    case 'cancelled':
      return t('state.cancelled');
    case 'browser':
      return item.reason ? t('state.browserReason', { reason: text(item.reason) }) : t('state.browser');
    case 'held':
      return t('state.held', { reason: firstReason(item) });
    case 'blocked':
      return t('state.blocked', { reason: firstReason(item) });
  }
}

/** The most serious reason a check gave, for a one-line summary. */
export function firstReason(item: Item): string {
  const findings = item.security?.findings ?? [];
  const top = findings.find((f) => f.level === 'malicious') ?? findings[0];
  return top ? text(top.reason) : item.reason ? text(item.reason) : '';
}

// --- the security shield ------------------------------------------------------

const SHIELD = 'M8 2l5.5 2v4c0 3.2-2.4 5.4-5.5 6-3.1-.6-5.5-2.8-5.5-6V4z';
const MARKS: Record<string, string> = {
  clean: 'M5.5 8.2l1.8 1.8 3.4-3.6',
  suspicious: 'M8 5.5v3M8 10.6v.01',
  malicious: 'M6 6l4 4M10 6l-4 4',
  unknown: 'M6.6 6.4a1.5 1.5 0 1 1 2 1.4c-.4.2-.6.5-.6.9v.3M8 10.6v.01',
};

function createShield(): HTMLElement {
  const span = document.createElement('span');
  span.className = 'shield';
  span.hidden = true;
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  const body = document.createElementNS(SVG, 'path');
  body.setAttribute('d', SHIELD);
  const mark = document.createElementNS(SVG, 'path');
  mark.setAttribute('class', 'mark-path');
  svg.append(body, mark);
  // The level as words too, so it is never told by colour alone.
  const said = document.createElement('span');
  said.className = 'visually-hidden';
  span.append(svg, said);
  return span;
}

/** Green, amber, red or grey, with the level as text for screen readers. */
export function updateShield(el: HTMLElement, item: Item) {
  const level = item.security?.level;
  el.hidden = !level;
  if (!level) return;
  el.dataset.level = level;
  el.querySelector('.mark-path')?.setAttribute('d', MARKS[level] ?? '');
  const label = t(`security.level.${level}`);
  el.title = label;
  const said = el.querySelector('.visually-hidden');
  if (said) said.textContent = label;
}

export function div(className: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = className;
  return el;
}

/** Keeps `list` in the order of `items`, creating and dropping rows. */
export function syncList(
  list: HTMLElement,
  rows: Map<number, Row>,
  items: Item[],
  create: (id: number) => Row,
  changed: Set<number> | null,
) {
  const seen = new Set<number>();
  let previous: Element | null = null;
  for (const item of items) {
    seen.add(item.id);
    let row = rows.get(item.id);
    if (!row) {
      row = create(item.id);
      rows.set(item.id, row);
      updateRow(row, item);
    } else if (!changed || changed.has(item.id)) {
      updateRow(row, item);
    }
    const expected: ChildNode | null = previous ? previous.nextSibling : list.firstChild;
    if (row.el !== expected) list.insertBefore(row.el, expected);
    previous = row.el;
  }
  for (const [id, row] of rows) {
    if (!seen.has(id)) {
      row.el.remove();
      rows.delete(id);
    }
  }
}
