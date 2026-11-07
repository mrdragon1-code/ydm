import type { Item, Part, PopupCommand, PopupState, State } from '@/lib/protocol';

type Action = 'pause' | 'resume' | 'cancel' | 'retry' | 'show';

const ACTIONS: Record<Action, { label: string; icon: string }> = {
  pause: { label: 'Pausa', icon: '<path d="M5.5 4v8M10.5 4v8" />' },
  resume: { label: 'Riprendi', icon: '<path d="M5 3.5l7 4.5-7 4.5z" />' },
  cancel: { label: 'Annulla', icon: '<path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />' },
  retry: { label: 'Riprova', icon: '<path d="M12.5 8a4.5 4.5 0 1 1-1.3-3.2M12.5 3v2.5H10" />' },
  show: { label: 'Mostra nella cartella', icon: '<path d="M2.5 4.5h3.5l1.5 1.5h6v6h-11z" />' },
};

const list = document.getElementById('list')!;
const empty = document.getElementById('empty')!;
const hint = document.getElementById('hint')!;
const off = document.getElementById('off')!;
const summary = document.getElementById('summary')!;
const toggle = document.getElementById('enabled') as HTMLInputElement;
const clear = document.getElementById('clear') as HTMLButtonElement;

const port = browser.runtime.connect({ name: 'popup' });
const send = (cmd: PopupCommand) => port.postMessage(cmd);

toggle.addEventListener('change', () => send({ type: 'enabled', value: toggle.checked }));
clear.addEventListener('click', () => send({ type: 'clear' }));
document.getElementById('settings')!.addEventListener('click', () => {
  void browser.runtime.openOptionsPage();
  window.close();
});
port.onMessage.addListener((msg) => render(msg as PopupState));

interface Row {
  el: HTMLLIElement;
  name: HTMLElement;
  bar: HTMLElement;
  text: HTMLElement;
  conns: HTMLElement;
  actions: HTMLElement;
}

/** Rows are kept and updated in place, so a button never disappears
 * under the cursor between two progress updates. */
const rows = new Map<number, Row>();

function render(state: PopupState) {
  toggle.checked = state.enabled;
  off.hidden = state.enabled;
  const seen = new Set<number>();
  let previous: Element | null = null;
  for (const item of state.items) {
    seen.add(item.id);
    const row = rows.get(item.id) ?? createRow(item.id);
    update(row, item);
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
  empty.hidden = state.items.length > 0;
  hint.textContent = `I file da ${bytes(state.minSize)} in su li scarica YDM da solo. Per gli altri: tasto destro su un link → Scarica con YDM.`;
  clear.hidden = !state.items.some((i) => !isActive(i.state));

  const running = state.items.filter((i) => i.state === 'running');
  const speed = running.reduce((n, i) => n + i.speed, 0);
  const queued = state.items.filter((i) => i.state === 'queued').length;
  const parts = [];
  if (running.length) parts.push(`${running.length} in corso`);
  if (queued) parts.push(`${queued} in coda`);
  if (speed > 0) parts.push(`${bytes(speed)}/s`);
  summary.textContent = parts.join(' · ');
}

function createRow(id: number): Row {
  const el = document.createElement('li');
  const name = div('name');
  const bar = div('segbar');
  const meta = div('meta');
  const text = document.createElement('span');
  text.className = 'text';
  const conns = document.createElement('span');
  conns.className = 'conns';
  meta.append(text, conns);
  const actions = div('actions');
  actions.addEventListener('click', (e) => {
    const kind = (e.target as Element).closest<HTMLButtonElement>('button')?.dataset.kind as Action | undefined;
    if (kind) send({ type: kind, id });
  });
  el.append(name, actions, bar, meta);
  const row = { el, name, bar, text, conns, actions };
  rows.set(id, row);
  return row;
}

function update(row: Row, item: Item) {
  row.el.dataset.state = item.state;
  // Names come from servers: text only, never markup.
  row.name.textContent = item.name;
  row.name.title = item.name;
  row.text.textContent = describe(item);
  // The line may be cut short; the whole text is one hover away.
  row.text.title = row.text.textContent;
  const working = item.parts?.filter(([, pos, end]) => pos < end).length ?? 0;
  row.conns.textContent = item.state === 'running' && working > 1 ? `${working} conn.` : '';
  row.conns.title = row.conns.textContent ? `${working} connessioni in parallelo` : '';
  row.el.classList.toggle('indeterminate', item.state === 'running' && !item.total);
  const showsBar = (item.state === 'running' || item.state === 'paused' || item.state === 'queued') && item.total;
  row.bar.style.backgroundImage = showsBar ? paint(item.total!, item.done, item.state === 'running' ? item.parts : undefined) : '';

  const kinds = actionsFor(item.state);
  if (row.actions.dataset.kinds !== kinds.join()) {
    row.actions.dataset.kinds = kinds.join();
    row.actions.replaceChildren(
      ...kinds.map((kind) => {
        const b = document.createElement('button');
        b.className = 'icon';
        b.dataset.kind = kind;
        b.title = ACTIONS[kind].label;
        b.setAttribute('aria-label', ACTIONS[kind].label);
        b.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true">${ACTIONS[kind].icon}</svg>`;
        return b;
      }),
    );
  }
}

function actionsFor(state: State): Action[] {
  switch (state) {
    case 'queued':
    case 'running':
      return ['pause', 'cancel'];
    case 'paused':
      return ['resume', 'cancel'];
    case 'saving':
      return ['cancel'];
    case 'completed':
      return ['show'];
    case 'failed':
    case 'cancelled':
      return ['retry'];
    case 'browser':
      return [];
  }
}

/** The bar as a gradient: filled where bytes are on disk, empty where a
 * connection has still to get there, and a thin cut where one connection's
 * range ends and the next begins. */
function paint(total: number, done: number, parts: Part[] | undefined): string {
  const fill = 'var(--malachite)';
  const pct = (n: number) => `${((n / total) * 100).toFixed(3)}%`;
  if (!parts?.length) return `linear-gradient(90deg, ${fill} 0 ${pct(done)}, transparent ${pct(done)})`;
  // What is missing; everything else is on disk (also from before a restart).
  const gaps = parts
    .filter(([, pos, end]) => pos < end)
    .map(([, pos, end]) => [pos, end] as const)
    .sort((a, b) => a[0] - b[0]);
  const stops: string[] = [];
  let at = 0;
  for (const [from, to] of gaps) {
    if (from > at) stops.push(`${fill} ${pct(at)} ${pct(from)}`);
    stops.push(`transparent ${pct(from)} ${pct(to)}`);
    at = to;
  }
  if (at < total) stops.push(`${fill} ${pct(at)} 100%`);
  const cuts = parts
    .map(([start]) => start)
    .filter((start) => start > 0)
    .map((start) => `linear-gradient(90deg, transparent calc(${pct(start)} - 1px), var(--paper) calc(${pct(start)} - 1px) calc(${pct(start)} + 1px), transparent calc(${pct(start)} + 1px))`);
  return [...cuts, `linear-gradient(90deg, ${stops.join(', ') || 'transparent 0 100%'})`].join(', ');
}

function describe(item: Item): string {
  switch (item.state) {
    case 'queued':
      return item.done > 0 && item.total && item.resumable ? `In coda · ripartirà da ${pct(item)}` : 'In coda';
    case 'paused':
      if (!item.total || !item.done) return 'In pausa';
      return item.resumable ? `In pausa · ${pct(item)}` : `In pausa · ripartirà da capo`;
    case 'running': {
      const parts = [item.total ? pct(item) : bytes(item.done)];
      if (item.speed > 0) {
        parts.push(`${bytes(item.speed)}/s`);
        if (item.total) parts.push(`${duration((item.total - item.done) / item.speed)} rimasti`);
      }
      return parts.join(' · ');
    }
    case 'saving':
      return 'Lo sto mettendo in Download…';
    case 'completed': {
      if (!item.total) return 'Completato';
      // Time and average speed, to compare with the browser's own download.
      const seconds = (item.elapsed ?? 0) / 1000;
      if (seconds < 0.5) return bytes(item.total);
      return `${bytes(item.total)} · ${duration(seconds)} · media ${bytes(item.total / seconds)}/s`;
    }
    case 'failed':
      return item.reason ? `Non riuscito: ${item.reason}` : 'Non riuscito';
    case 'cancelled':
      return 'Annullato';
    case 'browser':
      return item.reason ? `Scaricato dal browser: ${item.reason}` : 'Scaricato dal browser';
  }
}

function pct(item: Item): string {
  return `${Math.floor((item.done / (item.total ?? 1)) * 100)}%`;
}

function isActive(state: State): boolean {
  return state === 'queued' || state === 'running' || state === 'saving';
}

function div(className: string): HTMLDivElement {
  const el = document.createElement('div');
  el.className = className;
  return el;
}

function bytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let unit = 0;
  while (v >= 1024 && unit < units.length - 1) {
    v /= 1024;
    unit++;
  }
  return unit === 0 ? `${Math.round(v)} B` : `${v.toFixed(v < 10 ? 1 : 0)} ${units[unit]}`;
}

function duration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
}
