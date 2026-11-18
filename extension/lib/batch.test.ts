import { describe, expect, it } from 'vitest';
import { expandPatterns, MAX_EXPANDED } from './batch';

const lines = (text: string) => expandPatterns(text).text.split('\n');

describe('links in series', () => {
  it('numbers keep the zero padding of the start', () => {
    expect(lines('https://x.example/p[008-011].jpg')).toEqual([
      'https://x.example/p008.jpg',
      'https://x.example/p009.jpg',
      'https://x.example/p010.jpg',
      'https://x.example/p011.jpg',
    ]);
    expect(lines('https://x.example/[9-11]')).toEqual(['https://x.example/9', 'https://x.example/10', 'https://x.example/11']);
  });

  it('a step, and counting down', () => {
    expect(lines('https://x.example/f[0-10:5].bin')).toEqual(['https://x.example/f0.bin', 'https://x.example/f5.bin', 'https://x.example/f10.bin']);
    expect(lines('https://x.example/f[3-1].bin')).toEqual(['https://x.example/f3.bin', 'https://x.example/f2.bin', 'https://x.example/f1.bin']);
  });

  it('letters, and two ranges combined', () => {
    expect(lines('https://x.example/[a-b]/[1-2].txt')).toEqual([
      'https://x.example/a/1.txt',
      'https://x.example/a/2.txt',
      'https://x.example/b/1.txt',
      'https://x.example/b/2.txt',
    ]);
  });

  it('links without a range, IPv6 hosts and other brackets are left as they are', () => {
    expect(lines('https://a.example/x.zip http://[::1]:8080/y.zip https://b.example/[draft].pdf')).toEqual([
      'https://a.example/x.zip',
      'http://[::1]:8080/y.zip',
      'https://b.example/[draft].pdf',
    ]);
  });

  it(`at most ${MAX_EXPANDED} links, and says so`, () => {
    const r = expandPatterns('https://x.example/[1-1000].jpg https://x.example/after.jpg');
    expect(r.count).toBe(MAX_EXPANDED);
    expect(r.truncated).toBe(true);
    expect(r.text.split('\n').at(-1)).toBe(`https://x.example/${MAX_EXPANDED}.jpg`);
    expect(expandPatterns('https://x.example/[1-3]').truncated).toBe(false);
  });

  it('a huge range does not build a huge list first', () => {
    const r = expandPatterns('https://x.example/[1-999999999]/[1-999999999]');
    expect(r.count).toBe(MAX_EXPANDED);
  });
});
