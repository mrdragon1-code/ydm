import { describe, expect, it } from 'vitest';
import { categoryOf } from './filetypes';
import { cleanFolder, cleanRule, defaultFolders, folderFor, type Organize, withFolder } from './folders';

const FOLDERS = { video: 'Video', audio: 'Music', images: 'Images', documents: 'Documents', archives: 'Archives', programs: 'Programs' };
const on = (rules: Organize['rules'] = []): Organize => ({ organize: true, folders: FOLDERS, rules });

describe('kinds of files', () => {
  it('by the final name, case-insensitive', () => {
    expect(categoryOf('Trip.MP4')).toBe('video');
    expect(categoryOf('song.m4a')).toBe('audio');
    expect(categoryOf('scan.PDF')).toBe('documents');
    expect(categoryOf('backup.tar.gz')).toBe('archives');
    expect(categoryOf('setup.exe')).toBe('programs');
    expect(categoryOf('notes')).toBeNull();
    expect(categoryOf('data.bin')).toBeNull();
  });
});

describe('folders typed by the user', () => {
  it('kept when safe, one or two levels', () => {
    expect(cleanFolder(' Video ')).toBe('Video');
    expect(cleanFolder('Work\\PDF')).toBe('Work/PDF');
    expect(cleanFolder('Work//PDF/')).toBe('Work/PDF');
    expect(cleanFolder('')).toBe('');
  });

  it('refused when they would leave Downloads or Windows rejects them', () => {
    for (const bad of ['..', '../x', 'a/../b', '/abs', '\\abs', 'C:\\x', 'c:x', 'a/b/c', 'CON', 'a/NUL', 'x?', 'name.', 'a'.repeat(65)]) {
      expect(cleanFolder(bad), bad).toBeNull();
    }
  });

  it('rules: valid site or extension, safe folder', () => {
    expect(cleanRule({ kind: 'site', match: 'WWW.Example.com', folder: 'Example' })).toEqual({ kind: 'site', match: 'example.com', folder: 'Example' });
    expect(cleanRule({ kind: 'ext', match: '.PDF', folder: 'Docs/PDF' })).toEqual({ kind: 'ext', match: 'pdf', folder: 'Docs/PDF' });
    expect(cleanRule({ kind: 'site', match: 'not a site', folder: 'x' })).toBeNull();
    expect(cleanRule({ kind: 'ext', match: 'pdf', folder: '../x' })).toBeNull();
    expect(cleanRule({ kind: 'other', match: 'pdf', folder: 'x' })).toBeNull();
    expect(cleanRule(null)).toBeNull();
  });
});

describe('where a file goes', () => {
  it('nowhere special while sorting is off', () => {
    expect(folderFor('a.mp4', 'https://x.example/a.mp4', { ...on(), organize: false })).toBe('');
  });

  it('by kind; other files stay in Downloads itself', () => {
    expect(folderFor('a.mp4', 'https://x.example/a.mp4', on())).toBe('Video');
    expect(folderFor('report.pdf', undefined, on())).toBe('Documents');
    expect(folderFor('data.bin', 'https://x.example/d', on())).toBe('');
  });

  it('rules first, in order; sites include their subdomains, not lookalikes', () => {
    const s = on([
      { kind: 'site', match: 'example.com', folder: 'Example' },
      { kind: 'ext', match: 'mp4', folder: 'Clips' },
    ]);
    expect(folderFor('a.mp4', 'https://cdn.example.com/a.mp4', s)).toBe('Example');
    expect(folderFor('a.mp4', 'https://notexample.com/a.mp4', s)).toBe('Clips');
    expect(folderFor('a.pdf', 'https://other.org/a.pdf', s)).toBe('Documents');
  });

  it('paths for the downloads API', () => {
    expect(withFolder('Video', 'a.mp4')).toBe('Video/a.mp4');
    expect(withFolder('', 'a.mp4')).toBe('a.mp4');
  });

  it('default names come from the language given', () => {
    expect(defaultFolders((k) => k.split('.')[1]!.toUpperCase()).video).toBe('VIDEO');
  });
});
