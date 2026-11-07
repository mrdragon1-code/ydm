import { describe, expect, it } from 'vitest';
import { fromContentDisposition, fromUrl, sanitize } from './naming';

describe('fromContentDisposition', () => {
  it('reads plain, quoted and RFC 5987 names', () => {
    expect(fromContentDisposition('attachment; filename=a.zip')).toBe('a.zip');
    expect(fromContentDisposition('attachment; filename="my \\"file\\"; v2.zip"')).toBe('my "file"; v2.zip');
    expect(
      fromContentDisposition(`attachment; filename="fallback.zip"; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf`),
    ).toBe('résumé.pdf');
    expect(fromContentDisposition("attachment; filename*=iso-8859-1'en'caf%E9.txt")).toBe('café.txt');
    expect(fromContentDisposition('inline')).toBeNull();
    expect(fromContentDisposition(null)).toBeNull();
  });
});

describe('fromUrl', () => {
  it('uses the last path segment', () => {
    expect(fromUrl('https://example.com/files/My%20Setup.exe?x=1')).toBe('My Setup.exe');
    expect(fromUrl('https://example.com/dir/')).toBe('dir');
    expect(fromUrl('https://example.com/')).toBeNull();
    expect(fromUrl('https://example.com/%E0%A4%A')).toBe('%E0%A4%A');
  });
});

describe('sanitize', () => {
  it('rejects dangerous names', () => {
    expect(sanitize('../../etc/passwd')).toBe('passwd');
    expect(sanitize('..\\..\\Windows\\evil.dll')).toBe('evil.dll');
    expect(sanitize('a<b>c:d|e?.txt')).toBe('a_b_c_d_e_.txt');
    expect(sanitize('CON')).toBe('_CON');
    expect(sanitize('nul.txt')).toBe('_nul.txt');
    expect(sanitize('console.txt')).toBe('console.txt');
    expect(sanitize('report. . ')).toBe('report');
    expect(sanitize('..')).toBe('download');
    expect(sanitize('')).toBe('download');
    expect(sanitize('invoice‮fdp.exe')).toBe('invoicefdp.exe');
    expect(sanitize('tab\there')).toBe('tab_here');
  });

  it('truncates but keeps the extension', () => {
    const out = sanitize(`${'é'.repeat(300)}.tar.gz`);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out.endsWith('.gz')).toBe(true);
  });
});
