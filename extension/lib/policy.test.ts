import { describe, expect, it } from 'vitest';
import {
  type Candidate,
  DEFAULT_SETTINGS,
  describeSaveError,
  isProgram,
  normalizeHost,
  readSettings,
  shouldIntercept,
} from './policy';

const big: Candidate = {
  url: 'https://example.com/big.iso',
  incognito: false,
  state: 'in_progress',
  totalBytes: 100 * 1024 * 1024,
  byUs: false,
  fromPost: false,
};

describe('shouldIntercept', () => {
  it('takes over large http(s) downloads', () => {
    expect(shouldIntercept(big, DEFAULT_SETTINGS)).toBe(true);
    expect(shouldIntercept({ ...big, url: 'http://example.com/a' }, DEFAULT_SETTINGS)).toBe(true);
  });

  it.each<[string, Partial<Candidate>]>([
    ['small files', { totalBytes: 1024 }],
    ['unknown size', { totalBytes: -1 }],
    ['incognito', { incognito: true }],
    ['blob urls', { url: 'blob:https://example.com/123' }],
    ['data urls', { url: 'data:text/plain,hi' }],
    ['form posts', { fromPost: true }],
    ['our own saves', { byUs: true }],
    ['finished downloads', { state: 'complete' }],
  ])('leaves %s to the browser', (_, change) => {
    expect(shouldIntercept({ ...big, ...change }, DEFAULT_SETTINGS)).toBe(false);
  });

  it('does nothing when switched off', () => {
    expect(shouldIntercept(big, { ...DEFAULT_SETTINGS, enabled: false })).toBe(false);
  });
});

describe('programs and excluded sites', () => {
  it('leaves programs to the browser while that setting is on', () => {
    const exe = { ...big, url: 'https://example.com/dl?id=3', name: 'Setup Game.EXE' };
    expect(shouldIntercept(exe, DEFAULT_SETTINGS)).toBe(false);
    expect(shouldIntercept(exe, { ...DEFAULT_SETTINGS, programsToBrowser: false })).toBe(true);
  });

  it('recognises programs by name, address or type', () => {
    expect(isProgram('https://cdn.example.com/files/installer%20v2.msi?sig=1')).toBe(true);
    expect(isProgram('download', 'application/x-msdownload; charset=binary')).toBe(true);
    expect(isProgram('C:\\Users\\a\\Downloads\\run.bat')).toBe(true);
    for (const name of ['game.zip', 'ubuntu.iso', 'film.mkv', 'exe', 'notes.exe.txt']) {
      expect(isProgram(name)).toBe(false);
    }
  });

  it('skips excluded sites and their subdomains only', () => {
    const s = { ...DEFAULT_SETTINGS, excluded: ['example.com'] };
    expect(shouldIntercept(big, s)).toBe(false);
    expect(shouldIntercept({ ...big, url: 'https://cdn.example.com/a.iso' }, s)).toBe(false);
    expect(shouldIntercept({ ...big, url: 'https://notexample.com/a.iso' }, s)).toBe(true);
  });

  it('turns what people type into host names', () => {
    expect(normalizeHost(' https://WWW.Example.com:8080/path ')).toBe('example.com');
    expect(normalizeHost('dl.example.com')).toBe('dl.example.com');
    expect(normalizeHost('*.example.org')).toBe('example.org');
    expect(normalizeHost('mega.nz')).toBe('mega.nz');
    for (const bad of ['', 'not a host', 'localhost', 'javascript:alert(1)']) expect(normalizeHost(bad)).toBeNull();
  });
});

describe('readSettings', () => {
  it('fills in defaults and rejects values out of range', () => {
    expect(readSettings({})).toEqual(DEFAULT_SETTINGS);
    const s = readSettings({ connections: 99, parallel: 2, minSize: -1, programsToBrowser: 'no', excluded: ['a.com', 3] });
    expect(s).toMatchObject({ connections: 4, parallel: 2, minSize: DEFAULT_SETTINGS.minSize, programsToBrowser: true });
    expect(s.excluded).toEqual(['a.com']);
  });
});

describe('describeSaveError', () => {
  it('explains blocked files in words', () => {
    expect(describeSaveError('CRASH')).toEqual({ key: 'reason.saveCrash' });
    expect(describeSaveError('FILE_VIRUS_INFECTED')).toEqual({ key: 'reason.saveVirus' });
  });

  it('keeps unknown codes visible', () => {
    expect(describeSaveError('FILE_NAME_TOO_LONG')).toEqual({ key: 'reason.saveFailed', params: { error: 'FILE_NAME_TOO_LONG' } });
    expect(describeSaveError(undefined)).toEqual({ key: 'reason.saveFailedPlain' });
  });
});
