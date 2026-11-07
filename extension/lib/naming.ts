/** Choosing a safe file name for a download. */

const FALLBACK = 'download';
const MAX_LENGTH = 200;
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
// Bidi controls can make "invoice‮fdp.exe" display as "invoiceexe.pdf".
const BIDI = /[‎‏‪-‮⁦-⁩]/g;
// eslint-disable-next-line no-control-regex
const INVALID = /[<>:"|?*\u0000-\u001f\u007f]/g;

/** File name from a `Content-Disposition` value; `filename*` wins. */
export function fromContentDisposition(value: string | null): string | null {
  if (!value) return null;
  let plain: string | null = null;
  for (const param of splitParams(value).slice(1)) {
    const eq = param.indexOf('=');
    if (eq < 0) continue;
    const key = param.slice(0, eq).trim().toLowerCase();
    const val = param.slice(eq + 1).trim();
    if (key === 'filename*') {
      const m = /^([^']*)'[^']*'(.*)$/.exec(val);
      if (!m) continue;
      const decoded = decodeExtValue(m[1] ?? '', m[2] ?? '');
      if (decoded) return decoded;
    } else if (key === 'filename' && plain === null) {
      plain = unquote(val) || null;
    }
  }
  return plain;
}

/** Last non-empty path segment of the URL. */
export function fromUrl(url: string): string | null {
  try {
    const segments = new URL(url).pathname.split('/').filter(Boolean);
    const last = segments.at(-1);
    return last ? safeDecode(last) : null;
  } catch {
    return null;
  }
}

/**
 * Turns an untrusted name into a plain file name: no folders, nothing
 * Windows rejects, no reserved device names, no bidi tricks.
 */
export function sanitize(name: string): string {
  const base = name.split(/[/\\]/).at(-1) ?? '';
  let clean = base
    .replace(BIDI, '')
    .replace(INVALID, '_')
    .trim()
    .replace(/^[. ]+|[. ]+$/g, '');
  if (RESERVED.test((clean.split('.')[0] ?? '').trim())) clean = `_${clean}`;
  if (clean.length > MAX_LENGTH) {
    const dot = clean.lastIndexOf('.');
    const ext = dot > 0 && clean.length - dot <= 16 ? clean.slice(dot) : '';
    clean = clean.slice(0, MAX_LENGTH - ext.length).replace(/[. ]+$/, '') + ext;
  }
  return clean || FALLBACK;
}

function decodeExtValue(charset: string, encoded: string): string | null {
  try {
    if (charset.toLowerCase() === 'utf-8') return decodeURIComponent(encoded) || null;
    // ISO-8859-1: each %XX byte is the code point of the same value.
    return encoded.replace(/%([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))) || null;
  } catch {
    return null;
  }
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Splits on `;` outside double quotes. */
function splitParams(value: string): string[] {
  const out: string[] = [];
  let start = 0;
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (quoted && c === '\\') i++;
    else if (c === '"') quoted = !quoted;
    else if (c === ';' && !quoted) {
      out.push(value.slice(start, i));
      start = i + 1;
    }
  }
  out.push(value.slice(start));
  return out;
}

function unquote(val: string): string {
  if (val.length < 2 || !val.startsWith('"') || !val.endsWith('"')) return val;
  return val.slice(1, -1).replace(/\\(.)/g, '$1');
}
