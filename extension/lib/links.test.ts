import { describe, expect, it } from 'vitest';
import { extensionOf, fileLinks, parseUrls } from './links';

describe('parseUrls', () => {
  it('keeps http(s) URLs, one per line or space-separated, without duplicates', () => {
    expect(
      parseUrls('https://a.com/x.zip\n  http://b.org/y.iso https://a.com/x.zip\nftp://c/z javascript:alert(1) nope'),
    ).toEqual(['https://a.com/x.zip', 'http://b.org/y.iso']);
  });
});

describe('fileLinks', () => {
  it('keeps links to files, drops pages, duplicates and other schemes', () => {
    const links = fileLinks([
      { url: 'https://site.com/files/game.iso', label: 'Game' },
      { url: 'https://site.com/files/game.iso#top', label: 'Game again' },
      { url: 'https://site.com/about', label: 'About' },
      { url: 'https://site.com/page.html', label: 'Page' },
      { url: 'mailto:x@y.z', label: 'Mail' },
      { url: 'https://cdn.site.com/My%20Song.mp3?token=1', label: '' },
    ]);
    expect(links).toEqual([
      { url: 'https://site.com/files/game.iso', label: 'Game', ext: 'iso' },
      { url: 'https://cdn.site.com/My%20Song.mp3?token=1', label: 'My Song.mp3', ext: 'mp3' },
    ]);
  });

  it('reads the extension from the path, not the query', () => {
    expect(extensionOf('https://x.com/a.tar.gz?v=2')).toBe('gz');
    expect(extensionOf('https://x.com/dl?file=a.zip')).toBe('');
    expect(extensionOf('not a url')).toBe('');
  });
});
