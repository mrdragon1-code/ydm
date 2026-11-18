/**
 * Mirrors a download server names for its file, and the file's hash.
 *
 * RFC 6249 (Metalink/HTTP): a server lists copies of the file with
 * `Link: <url>; rel=duplicate; pri=1; geo=de` and its hash with
 * `Digest: SHA-256=…` (RFC 3230) or `Repr-Digest: sha-256=:…:` (RFC 9530);
 * `rel=describedby` points to a Metalink XML file (RFC 5854) with the same
 * and, often, a hash per piece. Download sites such as openSUSE do this.
 *
 * YDM uses mirrors only when the file's SHA-256 is known: bytes from
 * different servers are joined, and only the hash proves they are the
 * same file. Pure functions; the download worker applies them.
 */

import { kid, kids, parseXml } from './xml';

export interface Mirror {
  url: string;
  /** Lower is preferred (RFC 6249); 999999 when not given. */
  pri: number;
  /** ISO 3166 country code, if given. */
  geo?: string;
}

/** Mirrors used at most, besides the server the download came from. */
export const MAX_MIRRORS = 3;
const NO_PRI = 999_999;

/** A host on this machine or the local network: a public site naming one
 * as its mirror is not followed there. */
export function isLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!h.includes('.') && !h.includes(':')) return true; // localhost, intranet names
  if (/\.(local|localhost|internal|lan|home|corp)$/.test(h)) return true;
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  return h === '::1' || h === '::' || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h) || h.startsWith('::ffff:');
}

/**
 * Mirrors that may be used for a download from `origin`: never a local or
 * private address when the site itself is public (a hostile server could
 * point YDM at the user's own network), never plain http for an https
 * download.
 */
export function allowed(mirrors: Mirror[], origin: string): Mirror[] {
  const o = new URL(origin);
  const publicSite = !isLocalHost(o.hostname);
  return mirrors.filter((m) => {
    const u = new URL(m.url);
    if (o.protocol === 'https:' && u.protocol !== 'https:') return false;
    return !(publicSite && isLocalHost(u.hostname));
  });
}

/** Splits a Link header into its links: `<url>; param=value; …`. */
function links(header: string): { url: string; params: Record<string, string> }[] {
  const out: { url: string; params: Record<string, string> }[] = [];
  const re = /<([^>]*)>([^<]*)/g;
  for (let m = re.exec(header); m; m = re.exec(header)) {
    const params: Record<string, string> = {};
    for (const part of m[2]!.split(';').slice(1)) {
      const eq = part.indexOf('=');
      if (eq < 0) continue;
      const key = part.slice(0, eq).trim().toLowerCase();
      const value = part.slice(eq + 1).trim().replace(/,\s*$/, '').replace(/^"(.*)"$/, '$1');
      if (key) params[key] = value;
    }
    out.push({ url: m[1]!.trim(), params });
  }
  return out;
}

const httpUrl = (raw: string, base: string): string | null => {
  try {
    const u = new URL(raw, base);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
};

/** Mirrors and the Metalink file named by a response's Link header(s). */
export function parseLinks(header: string | null, base: string): { mirrors: Mirror[]; metalink: string | null } {
  const mirrors: Mirror[] = [];
  let metalink: string | null = null;
  for (const link of links(header ?? '')) {
    const rels = (link.params.rel ?? '').toLowerCase().split(/\s+/);
    const url = httpUrl(link.url, base);
    if (!url) continue;
    if (rels.includes('duplicate')) {
      const pri = Number.parseInt(link.params.pri ?? '', 10);
      const geo = link.params.geo?.toLowerCase();
      mirrors.push({ url, pri: Number.isFinite(pri) && pri > 0 ? pri : NO_PRI, ...(geo ? { geo } : {}) });
    } else if (rels.includes('describedby') && /metalink4\+xml/i.test(link.params.type ?? '')) {
      metalink ??= url;
    }
  }
  return { mirrors: best(mirrors, base), metalink };
}

/** The preferred mirrors, different from the origin and from each other. */
export function best(mirrors: Mirror[], origin: string): Mirror[] {
  const seen = new Set([origin]);
  return [...mirrors]
    .sort((a, b) => a.pri - b.pri)
    .filter((m) => !seen.has(m.url) && seen.add(m.url))
    .slice(0, MAX_MIRRORS);
}

function base64ToHex(b64: string): string | null {
  try {
    const bin = atob(b64.trim());
    if (bin.length !== 32) return null;
    return [...bin].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

/** The SHA-256 a response gives for the whole file, as hex, or null. */
export function parseDigest(digest: string | null, reprDigest: string | null): string | null {
  // Repr-Digest: sha-256=:BASE64:, possibly among others.
  for (const part of (reprDigest ?? '').split(',')) {
    const m = /^\s*sha-256\s*=\s*:([A-Za-z0-9+/=]+):\s*$/i.exec(part);
    const hex = m && base64ToHex(m[1]!);
    if (hex) return hex;
  }
  // Digest: SHA-256=BASE64, possibly among others.
  for (const part of (digest ?? '').split(',')) {
    const m = /^\s*sha-256\s*=\s*([A-Za-z0-9+/=]+)\s*$/i.exec(part);
    const hex = m && base64ToHex(m[1]!);
    if (hex) return hex;
  }
  return null;
}

export interface Metalink {
  size: number | null;
  sha256: string | null;
  /** A SHA-256 per piece of `length` bytes, when the file lists them. */
  pieces: { length: number; hashes: string[] } | null;
  mirrors: Mirror[];
}

const HEX64 = /^[0-9a-f]{64}$/;

/** A Metalink 4 file (RFC 5854) describing one file, or null. */
export function parseMeta4(xml: string, base: string): Metalink | null {
  let root;
  try {
    root = parseXml(xml);
  } catch {
    return null;
  }
  if (root.name !== 'metalink') return null;
  const files = kids(root, 'file');
  if (files.length !== 1) return null;
  const file = files[0]!;
  const sizeText = kid(file, 'size')?.text.trim() ?? '';
  const size = /^\d+$/.test(sizeText) ? Number(sizeText) : null;
  const sha = kids(file, 'hash')
    .find((h) => h.attrs.type?.toLowerCase() === 'sha-256')
    ?.text.trim()
    .toLowerCase();
  let pieces: Metalink['pieces'] = null;
  const p = kids(file, 'pieces').find((x) => x.attrs.type?.toLowerCase() === 'sha-256');
  const length = Number(p?.attrs.length);
  if (p && Number.isInteger(length) && length > 0) {
    const hashes = kids(p, 'hash').map((h) => h.text.trim().toLowerCase());
    if (hashes.length && hashes.every((h) => HEX64.test(h))) pieces = { length, hashes };
  }
  const mirrors: Mirror[] = [];
  for (const u of kids(file, 'url')) {
    const url = httpUrl(u.text.trim(), base);
    if (!url) continue;
    const pri = Number.parseInt(u.attrs.priority ?? '', 10);
    const geo = u.attrs.location?.toLowerCase();
    mirrors.push({ url, pri: Number.isFinite(pri) && pri > 0 ? pri : NO_PRI, ...(geo ? { geo } : {}) });
  }
  return { size, sha256: sha && HEX64.test(sha) ? sha : null, pieces, mirrors };
}
