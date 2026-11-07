/**
 * The download list as a page sees it: connects to the background, applies
 * the full snapshot and the patches that follow, and keeps the language in
 * step with the settings. Shared by the popup and the downloads page.
 */

import { pickLocale, setLocale, translatePage } from '../i18n';
import type { Item, PopupCommand, PopupState } from '../protocol';
import type { Settings } from '../policy';

export interface View {
  /** Newest first. */
  items: Item[];
  enabled: boolean;
  minSize: number;
  settings: Settings;
  /** Ids changed since the last render; null after a full snapshot. */
  changed: Set<number> | null;
}

export function connect(render: (view: View) => void): (cmd: PopupCommand) => void {
  const port = browser.runtime.connect({ name: 'popup' });
  let items: Item[] = [];
  let language: string | undefined;
  port.onMessage.addListener(async (raw) => {
    const msg = raw as PopupState;
    let changed: Set<number> | null = null;
    if (msg.type === 'state') {
      items = msg.items;
    } else {
      changed = new Set([...msg.items.map((i) => i.id), ...msg.removed]);
      const byId = new Map(msg.items.map((i) => [i.id, i]));
      const gone = new Set(msg.removed);
      items = items.filter((i) => !gone.has(i.id)).map((i) => byId.get(i.id) ?? i);
      const known = new Set(items.map((i) => i.id));
      const fresh = msg.items.filter((i) => !known.has(i.id)).sort((a, b) => b.id - a.id);
      items = [...fresh, ...items];
    }
    if (msg.settings.language !== language) {
      language = msg.settings.language;
      await setLocale(pickLocale(language));
      translatePage();
      changed = null;
    }
    render({ items, enabled: msg.enabled, minSize: msg.minSize, settings: msg.settings, changed });
  });
  return (cmd) => port.postMessage(cmd);
}

export function isActive(item: Item): boolean {
  return item.state === 'queued' || item.state === 'running' || item.state === 'saving';
}
