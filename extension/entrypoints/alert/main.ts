/**
 * The security warning, in its own small window so it appears at once,
 * even with no YDM page open. It names the file, the site and the cause,
 * and never defaults to downloading: the safe choice has the focus, and
 * closing the window counts as "Don't download".
 */

import { render as text, t } from '@/lib/i18n';
import type { Item } from '@/lib/protocol';
import { reportUrl, type Source } from '@/lib/security';
import { bytes } from '@/lib/ui/format';
import { connect } from '@/lib/ui/store';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const id = Number(location.hash.slice(1));
const deny = $<HTMLButtonElement>('deny');
const allow = $<HTMLButtonElement>('allow');

type Level = 'unknown' | 'suspicious' | 'malicious';

const GLYPHS: Record<Level, string> = {
  // Not checked: a question, not an accusation.
  unknown: 'M9.7 9.4a2.4 2.4 0 1 1 3.3 2.2c-.6.3-1 .8-1 1.5v.3M12 16.2v.01',
  suspicious: 'M12 7.5v5M12 15.8v.01',
  malicious: 'M9 9l6 6M15 9l-6 6',
};

const TITLES: Record<Level, [title: string, lead: string]> = {
  unknown: ['alert.uncheckedTitle', 'alert.uncheckedLead'],
  suspicious: ['alert.suspiciousTitle', 'alert.suspiciousLead'],
  malicious: ['alert.blockedTitle', 'alert.blockedLead'],
};

let level: Level = 'suspicious';
/** Still waiting for an answer: only then does closing mean "don't download". */
let waiting = false;

let answered = false;
let focused = false;

const send = connect((view) => {
  const item = view.items.find((i) => i.id === id);
  if (item) show(item);
});

function show(item: Item) {
  const blocked = item.state === 'blocked';
  waiting = item.state === 'held';
  const findings = item.security?.findings ?? [];
  // Held because a service did not answer in time: the file is unchecked,
  // not accused. Anything actually found still makes it suspicious.
  const unchecked =
    item.security?.level === 'unknown' || (findings.length > 0 && findings.every((f) => f.level === 'unknown'));
  level = blocked ? 'malicious' : unchecked ? 'unknown' : 'suspicious';
  document.body.dataset.level = level;
  $('glyph').setAttribute('d', GLYPHS[level]);
  const [title, lead] = TITLES[level];
  $('title').textContent = t(title);
  document.title = $('title').textContent;
  $('lead').textContent = t(lead);

  // Names and addresses come from servers: text only.
  $('name').textContent = item.name;
  const url = item.url ?? '';
  let host = '';
  try {
    host = new URL(url).host;
  } catch {
    host = url;
  }
  $('site').textContent = host || '—';
  $('size').textContent = item.total ? bytes(item.total) : '—';
  $('address').textContent = url || '—';

  $('reasons').replaceChildren(
    ...findings.map((f) => {
      const li = document.createElement('li');
      li.dataset.level = f.level;
      const what = document.createElement('span');
      what.textContent = text(f.reason);
      const from = document.createElement('span');
      from.className = 'source';
      from.textContent = t(`security.source.${f.source}`);
      li.append(what, from);
      return li;
    }),
  );
  if (!findings.length && item.security) {
    const li = document.createElement('li');
    li.dataset.level = level;
    li.textContent = t(`security.summary.${item.security.level}`);
    $('reasons').append(li);
  }

  const hash = item.sha256 && item.sha256 !== 'pending' ? item.sha256 : item.security?.sha256;
  $('hash').textContent = hash ?? t('alert.noHash');
  $('copy').hidden = !hash;
  const report = $<HTMLAnchorElement>('report');
  report.hidden = !hash || !item.security?.checked.includes('virustotal');
  if (hash) report.href = reportUrl(hash);
  $('checked').textContent = (item.security?.checked ?? []).map((s: Source) => t(`security.source.${s}`)).join(', ') || '—';

  // A known virus has no "download anyway": only the way out.
  allow.hidden = !waiting;
  deny.textContent = t(blocked ? 'alert.ok' : 'alert.deny');
  deny.hidden = false;

  if (!waiting && !blocked) {
    // Decided meanwhile (from the popup, or another window).
    $('choices').hidden = true;
    $('after').textContent = item.state === 'cancelled' ? t('alert.notDownloaded') : t('alert.downloading');
    if (!answered) setTimeout(() => window.close(), 1500);
  }
  if (!focused) {
    // The safe choice first, for the keyboard and for Enter.
    deny.focus();
    focused = true;
  }
}

deny.addEventListener('click', () => {
  answered = true;
  // For a blocked one there is nothing to decide: only close.
  if (waiting) send({ type: 'deny', id });
  window.close();
});

allow.addEventListener('click', () => {
  answered = true;
  send({ type: 'allow', id });
  window.close();
});

$('copy').addEventListener('click', async () => {
  const hash = $('hash').textContent ?? '';
  await navigator.clipboard.writeText(hash);
  $('copy').textContent = t('downloads.copied');
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') deny.click();
});
