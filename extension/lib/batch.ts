/**
 * Many links from one: "https://example.com/photo[001-120].jpg" stands for
 * photo001.jpg … photo120.jpg.
 *
 * - [001-100]   numbers; the start's width gives the zero padding
 * - [1-100:5]   with a step
 * - [100-1]     counting down
 * - [a-z]       letters
 * - at most two ranges per link, every combination of them
 *
 * Anything else in brackets is left alone (an IPv6 host such as [::1]).
 */

/** As many links as YDM takes from one paste. */
export const MAX_EXPANDED = 500;

const RANGE = /\[(?:(\d{1,9})-(\d{1,9})(?::(\d{1,9}))?|([a-z])-([a-z])|([A-Z])-([A-Z]))\]/g;

/** How many values a range stands for, and the i-th of them. */
function range(m: RegExpMatchArray): { count: number; at(i: number): string } {
  if (m[1] !== undefined) {
    const from = Number(m[1]);
    const to = Number(m[2]);
    const step = Math.max(1, Number(m[3] ?? 1));
    const dir = to >= from ? 1 : -1;
    const width = m[1].length > 1 && m[1].startsWith('0') ? m[1].length : 0;
    return {
      count: Math.floor(Math.abs(to - from) / step) + 1,
      at: (i) => String(from + dir * i * step).padStart(width, '0'),
    };
  }
  const a = (m[4] ?? m[6])!.charCodeAt(0);
  const b = (m[5] ?? m[7])!.charCodeAt(0);
  const dir = b >= a ? 1 : -1;
  return { count: Math.abs(b - a) + 1, at: (i) => String.fromCharCode(a + dir * i) };
}

/** One pasted link's links (itself if it has no range), at most `budget`. */
function expandOne(token: string, budget: number): { urls: string[]; truncated: boolean } {
  const matches = [...token.matchAll(RANGE)].slice(0, 2);
  if (!matches.length) return { urls: [token], truncated: false };
  // The pieces: text, range, text, (range, text).
  const texts: string[] = [];
  let at = 0;
  for (const m of matches) {
    texts.push(token.slice(at, m.index));
    at = m.index! + m[0].length;
  }
  texts.push(token.slice(at));
  const ranges = matches.map(range);
  const total = ranges.reduce((n, r) => n * r.count, 1);
  const urls: string[] = [];
  for (let i = 0; i < Math.min(total, budget); i++) {
    // The i-th combination, the last range changing fastest.
    let rest = i;
    const picked = new Array<string>(ranges.length);
    for (let k = ranges.length - 1; k >= 0; k--) {
      picked[k] = ranges[k]!.at(rest % ranges[k]!.count);
      rest = Math.floor(rest / ranges[k]!.count);
    }
    urls.push(texts.map((text, k) => text + (picked[k] ?? '')).join(''));
  }
  return { urls, truncated: total > budget };
}

/** Pasted text with every range spelled out, links one per line; at most
 * {@link MAX_EXPANDED} links, `truncated` if there were more. */
export function expandPatterns(text: string): { text: string; count: number; truncated: boolean } {
  const out: string[] = [];
  let truncated = false;
  for (const token of text.split(/\s+/).filter(Boolean)) {
    const budget = MAX_EXPANDED - out.length;
    if (budget <= 0) {
      truncated = true;
      break;
    }
    const r = expandOne(token, budget);
    out.push(...r.urls);
    truncated ||= r.truncated;
  }
  return { text: out.join('\n'), count: out.length, truncated };
}
