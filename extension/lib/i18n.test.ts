import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import en from '../locales/en.json';
import { flatten, machineCode, type Messages, render, resolveLocale, setLocale, t } from './i18n';

const LOCALES = path.resolve(import.meta.dirname, '../locales');

describe('resolveLocale', () => {
  const available = ['de', 'en', 'it', 'pt_BR', 'zh_CN'];
  it.each([
    ['it', 'it'],
    ['it-CH', 'it'],
    ['pt-BR', 'pt_BR'],
    ['pt-PT', 'pt_BR'],
    ['zh-TW', 'zh_CN'],
    ['de-AT', 'de'],
    ['fi', 'en'],
    ['', 'en'],
  ])('%s → %s', (wanted, expected) => {
    expect(resolveLocale(wanted, available)).toBe(expected);
  });
});

describe('machineCode', () => {
  it.each([
    ['de-DE', 'de'],
    ['zh-CN', 'zh'],
    ['zh-TW', 'zh-Hant'],
    ['he', 'iw'],
    ['nb-NO', 'no'],
    ['pt_BR', 'pt'],
  ])('%s → %s', (ui, expected) => expect(machineCode(ui)).toBe(expected));
});

describe('t', () => {
  beforeEach(() => setLocale('en'));

  it('fills placeholders and picks plural forms', () => {
    expect(t('popup.running', { count: 2 })).toBe('2 running');
    expect(t('popup.addDone', { count: 1 })).toBe('1 download added');
    expect(t('popup.addDone', { count: 3 })).toBe('3 downloads added');
  });

  it('shows the key rather than nothing for an unknown message', () => {
    expect(t('nope.missing')).toBe('nope.missing');
  });

  it('uses the corrected Italian, and English for anything it lacks', async () => {
    await setLocale('it');
    expect(t('action.pause')).toBe('Pausa');
    expect(t('unit.MB')).toBe('MB');
  });

  it('renders saved reasons, old plain strings included', async () => {
    await setLocale('it');
    expect(render({ key: 'reason.forbidden', params: { status: 403 } })).toBe(
      'il sito non accetta download esterni (403)',
    );
    expect(render('vecchio motivo')).toBe('vecchio motivo');
  });
});

/** Every translation must keep the source's placeholders, or a number or
 * name would silently disappear from the sentence. */
describe('translations', () => {
  const source = flatten(en as Messages);
  const files = ['overrides'].flatMap((dir) => {
    try {
      return readdirSync(path.join(LOCALES, dir))
        .filter((f) => f.endsWith('.json'))
        .map((f) => path.join(dir, f));
    } catch {
      return [];
    }
  });
  const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

  it.each(files)('%s has only known keys, with the same placeholders', (file) => {
    const messages = flatten(JSON.parse(readFileSync(path.join(LOCALES, file), 'utf8')));
    for (const [key, value] of messages) {
      // Plural forms other than one/other exist only in some languages.
      const plural = /\.(zero|two|few|many)$/.exec(key);
      const sourceKey = plural ? key.replace(/\.\w+$/, '.other') : key;
      expect(source.has(sourceKey), `${file}: unknown key ${key}`).toBe(true);
      expect(placeholders(value), `${file}: ${key}`).toEqual(placeholders(source.get(sourceKey)!));
    }
  });
});
