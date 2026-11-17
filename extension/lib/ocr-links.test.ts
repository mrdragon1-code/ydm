import { describe, expect, it } from 'vitest';
import { linksInText } from './ocr-links';

describe('links in text read from an image', () => {
  it('finds plain addresses', () => {
    expect(linksInText('Get it at https://example.com/files/setup-2.1.zip today')).toEqual([
      'https://example.com/files/setup-2.1.zip',
    ]);
  });

  it('repairs spaces and a misread colon in the scheme', () => {
    expect(linksInText('https : //example.com/a.pdf and http;//example.org/b.iso')).toEqual([
      'https://example.com/a.pdf',
      'http://example.org/b.iso',
    ]);
  });

  it('drops the punctuation of the sentence, keeps balanced brackets', () => {
    expect(linksInText('Download: https://example.com/a.zip. Or (https://example.com/b.zip), or https://en.wikipedia.org/wiki/Foo_(bar).')).toEqual([
      'https://example.com/a.zip',
      'https://example.com/b.zip',
      'https://en.wikipedia.org/wiki/Foo_(bar)',
    ]);
  });

  it('brackets around and inside an address, with punctuation in any order', () => {
    expect(linksInText('(see http://a.example.com/x_(y)).')).toEqual(['http://a.example.com/x_(y)']);
    expect(linksInText('[mirror: https://b.example.com/f.zip].')).toEqual(['https://b.example.com/f.zip']);
    expect(linksInText('"https://c.example.com/q?a=1",')).toEqual(['https://c.example.com/q?a=1']);
  });

  it('does not glue the next sentence to an address', () => {
    expect(linksInText('Get it from http://x.example.com/.\nThen restart the computer.')).toEqual(['http://x.example.com/']);
    expect(linksInText('Get it from https://x.example.com/files/\nThanks for waiting')).toEqual(['https://x.example.com/files/']);
  });

  it('joins an address broken across two lines', () => {
    expect(linksInText('https://downloads.example.com/releases/\nv2/app-installer.exe')).toEqual([
      'https://downloads.example.com/releases/v2/app-installer.exe',
    ]);
  });

  it('takes www. and bare domains with a path, not file names in a sentence', () => {
    expect(linksInText('www.example.com/file.zip and example.org/data.csv but not notes.txt or v1.2.3')).toEqual([
      'https://www.example.com/file.zip',
      'https://example.org/data.csv',
    ]);
  });

  it('typographic dashes become hyphens', () => {
    expect(linksInText('https://example.com/my–file—v2.zip')).toEqual(['https://example.com/my-file-v2.zip']);
  });

  it('no duplicates, nothing from text without addresses', () => {
    expect(linksInText('https://a.example.com/x.zip https://a.example.com/x.zip')).toHaveLength(1);
    expect(linksInText('Meeting at 10:30, room 4.2 — bring the slides.')).toEqual([]);
  });

  it('keeps IP addresses and ports', () => {
    expect(linksInText('http://192.168.1.10:8080/backup.tar.gz')).toEqual(['http://192.168.1.10:8080/backup.tar.gz']);
  });
});
