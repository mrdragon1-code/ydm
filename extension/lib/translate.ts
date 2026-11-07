/**
 * Languages YDM does not ship, translated by the browser itself: Chrome's
 * built-in Translator API runs on the device, with no server and no key.
 * The whole English catalogue is translated once and kept in storage, so
 * every page (and the background, which cannot use the API) reads it from
 * there afterwards. Browsers without the API stay in English.
 *
 * Placeholders such as {size} are swapped for numbered tokens the
 * translator leaves alone, and put back after; a translation that loses
 * one is dropped, and that message stays in English.
 */

import en from '../locales/en.json';
import { flatten, type Messages, SOURCE } from './i18n';

/** Changes whenever en.json changes, so a stale cache is redone. */
const CATALOG_VERSION = hash(JSON.stringify(en));
const KEY = 'translated';

export interface Cached {
  lang: string;
  version: string;
  messages: Messages;
}

interface TranslatorLike {
  translate(text: string): Promise<string>;
  destroy?(): void;
}

interface TranslatorStatic {
  availability(o: { sourceLanguage: string; targetLanguage: string }): Promise<string>;
  create(o: {
    sourceLanguage: string;
    targetLanguage: string;
    monitor?: (m: EventTarget) => void;
  }): Promise<TranslatorLike>;
}

function api(): TranslatorStatic | null {
  return (globalThis as { Translator?: TranslatorStatic }).Translator ?? null;
}

/** 'available', 'downloadable' (needs a click), or 'unavailable'. */
export async function translatorStatus(lang: string): Promise<'available' | 'downloadable' | 'unavailable'> {
  const t = api();
  if (!t || lang === SOURCE) return 'unavailable';
  try {
    const a = await t.availability({ sourceLanguage: SOURCE, targetLanguage: lang });
    if (a === 'available') return 'available';
    if (a === 'downloadable' || a === 'downloading') return 'downloadable';
  } catch {
    // Unknown language code.
  }
  return 'unavailable';
}

export async function cachedTranslation(lang: string): Promise<Messages | null> {
  try {
    const stored = (await browser.storage.local.get(KEY))[KEY] as Cached | undefined;
    return stored?.lang === lang && stored.version === CATALOG_VERSION ? stored.messages : null;
  } catch {
    return null;
  }
}

/** Translates the catalogue into `lang` and stores it. Must run in a page
 * (the API is not in workers); the first time for a language, right after
 * a click, since the browser then downloads its language pack. */
export async function translateCatalog(lang: string, onProgress?: (done: number, total: number) => void): Promise<Messages> {
  const t = api();
  if (!t) throw new Error('no Translator API');
  const translator = await t.create({ sourceLanguage: SOURCE, targetLanguage: lang });
  try {
    // Units and number formats ("MB", "{m}:{ss}") are not words to translate.
    const entries = [...flatten(en as Messages)].filter(([key]) => !key.startsWith('unit.'));
    const out: Messages = {};
    let done = 0;
    // A few at a time: fast, without flooding the translator.
    for (let i = 0; i < entries.length; i += 8) {
      await Promise.all(
        entries.slice(i, i + 8).map(async ([key, source]) => {
          const result = await translateOne(translator, source).catch(() => null);
          if (result) set(out, key, result);
          onProgress?.(++done, entries.length);
        }),
      );
    }
    // The brand stays as it is.
    set(out, 'ext.name', (en as Messages & { ext: { name: string } }).ext.name);
    const cached: Cached = { lang, version: CATALOG_VERSION, messages: out };
    await browser.storage.local.set({ [KEY]: cached });
    return out;
  } finally {
    translator.destroy?.();
  }
}

/** Protects placeholders and the product name, translates, puts them back. */
export async function translateOne(translator: TranslatorLike, source: string): Promise<string | null> {
  const names: string[] = [];
  const masked = source.replace(/\{(\w+)\}|YDM/g, (all) => {
    names.push(all);
    return `⟦${names.length - 1}⟧`;
  });
  const result = await translator.translate(masked);
  let ok = true;
  const restored = result.replace(/⟦\s*(\d+)\s*⟧/g, (_, n: string) => names[Number(n)] ?? '');
  for (const name of names) if (!restored.includes(name)) ok = false;
  return ok && restored.trim() ? restored : null;
}

function set(target: Messages, key: string, value: string) {
  const parts = key.split('.');
  let node = target;
  for (const part of parts.slice(0, -1)) {
    if (typeof node[part] !== 'object') node[part] = {};
    node = node[part] as Messages;
  }
  node[parts.at(-1)!] = value;
}

function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}
