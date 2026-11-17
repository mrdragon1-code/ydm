/**
 * Links in text read from an image (OCR). The text is noisy: spaces
 * creep into "https: //", a sentence's full stop sticks to the end, an
 * address breaks across two lines. This finds what are clearly addresses
 * and repairs only those mistakes that cannot change where a link leads.
 */

/** Endings of a bare address (no "http"), so that a sentence like
 * "see notes.txt" is not taken for a site. */
const TLD = /\.(com|net|org|io|dev|app|co|me|info|biz|edu|gov|it|de|fr|es|nl|eu|uk|us|ru|cn|jp|br|in|ch|at|be|pl|se|no|fi|dk|pt|cz|gr|ro|hu|xyz|site|online|store|tech|cloud|download|link|to|tv|cc|gg|ly|sh)$/i;

/** Characters an address can hold (RFC 3986, unencoded). */
const URL_CHAR = /[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]/;

/** Drops what closes the sentence around an address, one character at a
 * time: punctuation always, a ")" only when the address has no "(" for it. */
function trimSentenceEnd(raw: string): string {
  const count = (c: string) => raw.split(c).length - 1;
  for (;;) {
    const last = raw.at(-1);
    if (last && `.,;:!?'"]`.includes(last)) raw = raw.slice(0, -1);
    else if (last === ')' && count('(') < count(')')) raw = raw.slice(0, -1);
    else return raw;
  }
}

export function linksInText(text: string): string[] {
  const repaired = text
    // Typographic marks OCR produces for plain ones.
    .replace(/[‐‑‒–—]/g, '-')
    .replace(/[“”«»]/g, '"')
    // "https : //", "http:/ /", "https;//": spaces and a misread colon.
    .replace(/\b(https?)\s*[:;]\s*\/\s*\/\s*/gi, (_, scheme: string) => `${scheme.toLowerCase()}://`)
    // An address cut at the end of a line, the rest on the next one: only
    // after a character that cannot end an address ("/", "-", "=", ...; not
    // a full stop, which ends sentences), and only if the next line goes on
    // like a path (a word holding a dot, slash, digit, "-", "_" or "=").
    .replace(/(https?:\/\/\S*[/\-_=&?])[ \t]*\n[ \t]*(?=[A-Za-z0-9]\S*[./\d\-_=])/g, '$1');

  const out = new Set<string>();
  const candidates = repaired.match(/\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\/\S*/gi) ?? [];
  for (let raw of candidates) {
    // Keep only address characters, then drop what closes a sentence.
    raw = [...raw].filter((c) => URL_CHAR.test(c)).join('');
    raw = trimSentenceEnd(raw);
    const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    let url: URL;
    try {
      url = new URL(withScheme);
    } catch {
      continue;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
    // A real host: has a dot and a plausible ending, or an IP address.
    const host = url.hostname;
    const ip = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[');
    if (!ip && !(host.includes('.') && (/^https?:\/\//i.test(raw) || TLD.test(host)))) continue;
    out.add(url.href);
  }
  return [...out];
}
