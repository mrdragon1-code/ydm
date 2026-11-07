/**
 * Translations. English (`locales/en.json`) is the source. Languages
 * translated by people ship with YDM (`locales/overrides/<lang>.json`).
 * Any other language is translated on the device by the browser's own
 * translator (lib/translate.ts) and kept in storage. A key missing
 * anywhere falls back to English, so a language never shows a blank.
 *
 * The language follows the browser's, unless the user picked one.
 */

import en from '../locales/en.json';

export type Messages = { [key: string]: string | Messages };
export type Params = Record<string, string | number>;
/** A message to show later, in whatever language is active then. */
export interface Text {
  key: string;
  params?: Params;
}

export const SOURCE = 'en';

// Lazy: a page only loads its own language.
const OVERRIDES = import.meta.glob<Messages>('../locales/overrides/*.json', { import: 'default' });

const codeOf = (path: string) => path.slice(path.lastIndexOf('/') + 1, -'.json'.length);

/** Languages translated by people, in Chrome's `_locales` spelling (`pt_BR`). */
export const LOCALES: string[] = [...new Set([SOURCE, ...Object.keys(OVERRIDES).map(codeOf)])].sort();

/** Languages the browser's translator can provide, offered in the settings
 * when the API exists. BCP 47 base codes, as the Translator API wants. */
export const MACHINE_LOCALES = [
  'ar', 'bg', 'bn', 'cs', 'da', 'de', 'el', 'es', 'fi', 'fr', 'hi', 'hr', 'hu', 'id', 'it', 'iw', 'ja',
  'kn', 'ko', 'lt', 'mr', 'nl', 'no', 'pl', 'pt', 'ro', 'ru', 'sk', 'sl', 'sv', 'ta', 'te', 'th', 'tr',
  'uk', 'vi', 'zh', 'zh-Hant',
];

/** Where machine translations come from; set by pages that can store them. */
let machine: (code: string) => Promise<Messages | null> = async () => null;

export function useMachineTranslations(load: (code: string) => Promise<Messages | null>) {
  machine = load;
}

let locale = SOURCE;
let layers: Messages[] = [en];
let plurals = new Intl.PluralRules(SOURCE);

/** The best of `available` for a browser language like `pt-BR` or `de`:
 * the same language and region, else the same language, else English. */
export function resolveLocale(wanted: string, available: string[] = LOCALES): string {
  const norm = wanted.replace('-', '_').toLowerCase();
  const exact = available.find((l) => l.toLowerCase() === norm);
  if (exact) return exact;
  const base = norm.split('_')[0]!;
  return (
    available.find((l) => l.toLowerCase() === base) ??
    available.find((l) => l.toLowerCase().split('_')[0] === base) ??
    SOURCE
  );
}

/** `setting` is 'auto' or a locale code. Shipped languages are matched
 * loosely (`it-CH` → `it`); any other is returned as the browser's base
 * language, for the machine translation. */
export function pickLocale(setting: string | undefined): string {
  if (setting && setting !== 'auto') return setting;
  const ui = uiLanguage();
  const shipped = resolveLocale(ui);
  if (shipped !== SOURCE || ui.toLowerCase().startsWith(SOURCE)) return shipped;
  return machineCode(ui);
}

/** A browser language as the Translator API names it. */
export function machineCode(ui: string): string {
  const [base, region] = ui.replace('_', '-').split('-');
  const lang = (base ?? SOURCE).toLowerCase();
  if (lang === 'zh' && /^(tw|hk|mo|hant)$/i.test(region ?? '')) return 'zh-Hant';
  if (lang === 'he') return 'iw';
  if (lang === 'nb' || lang === 'nn') return 'no';
  return lang;
}

export function uiLanguage(): string {
  try {
    return browser.i18n.getUILanguage();
  } catch {
    return navigator.language || SOURCE;
  }
}

/** Loads a language; `t` uses it from then on. */
export async function setLocale(code: string): Promise<void> {
  const next: Messages[] = [en];
  if (code !== SOURCE) {
    const override = await OVERRIDES[`../locales/overrides/${code}.json`]?.();
    const translated = override ? null : await machine(code).catch(() => null);
    if (translated) next.unshift(translated);
    if (override) next.unshift(override);
  }
  locale = next.length > 1 ? code : SOURCE;
  layers = next;
  plurals = new Intl.PluralRules(bcp47(locale));
  if (typeof document !== 'undefined') document.documentElement.lang = bcp47(locale);
}

/** For `Intl` and `<html lang>`: `pt_BR` → `pt-BR`. */
export function bcp47(code: string = locale): string {
  return code.replace('_', '-');
}

export function currentLocale(): string {
  return locale;
}

/** The message for `key` (`popup.empty`), with `{name}` placeholders
 * filled in. A `count` param picks the plural form when there is one. */
export function t(key: string, params?: Params): string {
  for (const layer of layers) {
    const found = lookup(layer, key, params);
    if (found !== undefined) return fill(found, params);
  }
  return key;
}

export function render(text: Text | string | undefined): string {
  if (text === undefined) return '';
  return typeof text === 'string' ? text : t(text.key, text.params);
}

function lookup(layer: Messages, key: string, params?: Params): string | undefined {
  let node: string | Messages | undefined = layer;
  for (const part of key.split('.')) {
    if (typeof node !== 'object') return undefined;
    node = node[part];
  }
  if (typeof node === 'string') return node || undefined;
  if (node && typeof params?.count === 'number') {
    const form = node[plurals.select(params.count)] ?? node.other;
    return typeof form === 'string' && form ? form : undefined;
  }
  return undefined;
}

function fill(message: string, params?: Params): string {
  if (!params) return message;
  return message.replace(/\{(\w+)\}/g, (all, name: string) => (name in params ? String(params[name]) : all));
}

/** Fills `[data-i18n]` text, and `[data-i18n-title]`, `[data-i18n-label]`
 * (aria-label) and `[data-i18n-placeholder]` attributes, under `root`. */
export function translatePage(root: ParentNode = document): void {
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n]')) el.textContent = t(el.dataset.i18n!);
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle!);
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n-label]')) {
    el.setAttribute('aria-label', t(el.dataset.i18nLabel!));
  }
  for (const el of root.querySelectorAll<HTMLInputElement>('[data-i18n-placeholder]')) {
    el.placeholder = t(el.dataset.i18nPlaceholder!);
  }
}

/** All `dot.separated` keys with their strings, plural forms as `key.one`. */
export function flatten(messages: Messages, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(messages)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') out.set(key, v);
    else for (const [kk, vv] of flatten(v, key)) out.set(kk, vv);
  }
  return out;
}
