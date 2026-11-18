import { describe, expect, it } from 'vitest';
import { allowed, isLocalHost, MAX_MIRRORS, parseDigest, parseLinks, parseMeta4 } from './mirrors';

const ORIGIN = 'https://download.example.org/iso/distro.iso';
// SHA-256 of "hello", in hex and base64.
const HEX = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
const B64 = 'LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=';

describe('Link header (RFC 6249)', () => {
  it('reads mirrors by priority, and the Metalink file', () => {
    const header =
      '<http://mirror-b.example.net/distro.iso>; rel=duplicate; pri=2; geo=it, ' +
      '<https://mirror-a.example.com/pub/distro.iso>; rel=duplicate; pri=1; geo=DE, ' +
      '<distro.iso.meta4>; rel=describedby; type="application/metalink4+xml"';
    const { mirrors, metalink } = parseLinks(header, ORIGIN);
    expect(mirrors).toEqual([
      { url: 'https://mirror-a.example.com/pub/distro.iso', pri: 1, geo: 'de' },
      { url: 'http://mirror-b.example.net/distro.iso', pri: 2, geo: 'it' },
    ]);
    expect(metalink).toBe('https://download.example.org/iso/distro.iso.meta4');
  });

  it('ignores other links, other schemes, the origin itself and repeats; keeps a few', () => {
    const many = Array.from({ length: 6 }, (_, i) => `<https://m${i}.example/f>; rel=duplicate; pri=${i + 1}`);
    const header = [
      '<https://example.org/next>; rel=next',
      '<ftp://old.example/f>; rel=duplicate',
      `<${ORIGIN}>; rel=duplicate; pri=1`,
      '<https://m0.example/f>; rel=duplicate; pri=9',
      '<javascript:alert(1)>; rel=duplicate',
      ...many,
    ].join(', ');
    const { mirrors } = parseLinks(header, ORIGIN);
    expect(mirrors.map((m) => m.url)).toEqual(['https://m0.example/f', 'https://m1.example/f', 'https://m2.example/f']);
    expect(mirrors).toHaveLength(MAX_MIRRORS);
    expect(parseLinks(null, ORIGIN)).toEqual({ mirrors: [], metalink: null });
  });
});

describe('which mirrors may be used', () => {
  it('a public site cannot send YDM into the local network', () => {
    for (const h of ['localhost', 'router', '127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.1.1', 'nas.local', '[::1]', '[fd00::1]', '[fe80::1]']) {
      expect(isLocalHost(h), h).toBe(true);
    }
    for (const h of ['mirror.example.com', '8.8.8.8', '172.32.0.1', '[2001:db8::1]']) expect(isLocalHost(h), h).toBe(false);
    const list = [
      { url: 'https://192.168.1.1/admin', pri: 1 },
      { url: 'http://mirror.example.net/f', pri: 2 },
      { url: 'https://mirror.example.com/f', pri: 3 },
    ];
    expect(allowed(list, ORIGIN.replace('https:', 'http:')).map((m) => m.pri)).toEqual([2, 3]);
    // An https download: no plain http mirror either.
    expect(allowed(list, ORIGIN).map((m) => m.pri)).toEqual([3]);
    // A site on the local network may name its neighbours.
    expect(allowed([{ url: 'http://10.0.0.2/f', pri: 1 }], 'http://10.0.0.1/f')).toHaveLength(1);
  });
});

describe('Digest headers', () => {
  it('reads SHA-256 from Repr-Digest or Digest, as hex', () => {
    expect(parseDigest(null, `sha-512=:abc:, sha-256=:${B64}:`)).toBe(HEX);
    expect(parseDigest(`MD5=XUFAKrxLKna5cZ2REBfFkg==, SHA-256=${B64}`, null)).toBe(HEX);
  });

  it('nothing usable: null', () => {
    expect(parseDigest('MD5=XUFAKrxLKna5cZ2REBfFkg==', null)).toBeNull();
    expect(parseDigest('SHA-256=bm90IGEgaGFzaA==', null)).toBeNull(); // not 32 bytes
    expect(parseDigest(null, 'sha-256=:!!!:')).toBeNull();
    expect(parseDigest(null, null)).toBeNull();
  });
});

describe('Metalink 4', () => {
  const meta4 = `<?xml version="1.0" encoding="UTF-8"?>
<metalink xmlns="urn:ietf:params:xml:ns:metalink">
  <file name="distro.iso">
    <size>11</size>
    <hash type="md5">5eb63bbbe01eeed093cb22bb8f5acdc3</hash>
    <hash type="sha-256">${HEX.toUpperCase()}</hash>
    <pieces length="8" type="sha-256"><hash>${HEX}</hash><hash>${HEX}</hash></pieces>
    <url location="se" priority="2">http://ftp.example.se/distro.iso</url>
    <url priority="1">https://mirror.example.com/distro.iso</url>
    <url>file:///etc/passwd</url>
  </file>
</metalink>`;

  it('reads size, hash, piece hashes and mirrors', () => {
    expect(parseMeta4(meta4, ORIGIN)).toEqual({
      size: 11,
      sha256: HEX,
      pieces: { length: 8, hashes: [HEX, HEX] },
      mirrors: [
        { url: 'http://ftp.example.se/distro.iso', pri: 2, geo: 'se' },
        { url: 'https://mirror.example.com/distro.iso', pri: 1 },
      ],
    });
  });

  it('anything else: null', () => {
    expect(parseMeta4('<html></html>', ORIGIN)).toBeNull();
    expect(parseMeta4('not xml <', ORIGIN)).toBeNull();
    expect(parseMeta4('<metalink><file/><file/></metalink>', ORIGIN)).toBeNull();
  });
});
