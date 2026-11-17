/** Collecting the downloadable links of a page, and parsing pasted URLs. */

import { EXTENSION_GROUPS } from './filetypes';

export interface PageLink {
  url: string;
  /** Link text or file name, for the list. */
  label: string;
  /** Lowercase extension without the dot, '' if none. */
  ext: string;
}

/** Extensions offered in the "download all links" list. Pages link to
 * other pages far more than to files; only these count as files. A page
 * link ending in ".md" or ".txt" is far more often a text page than a file
 * to keep, so those stay out of this list. */
export const FILE_EXTENSIONS = new Set([
  ...Object.values(EXTENSION_GROUPS)
    .flat()
    .filter((e) => e !== 'md' && e !== 'txt'),
  // data
  'bin', 'torrent', 'srt', 'json', 'xml', 'sql', 'db',
]);

export function extensionOf(url: string): string {
  try {
    const last = new URL(url).pathname.split('/').at(-1) ?? '';
    return /\.([a-z0-9]{1,9})$/i.exec(decodeURIComponent(last))?.[1]?.toLowerCase() ?? '';
  } catch {
    return '';
  }
}

/** Runs inside the page (injected): every link, media source and
 * download attribute, as absolute URLs. Must not use anything outside. */
export function collectInPage(): { url: string; label: string }[] {
  const out: { url: string; label: string }[] = [];
  const add = (href: string | null | undefined, label: string) => {
    if (!href) return;
    try {
      out.push({ url: new URL(href, document.baseURI).href, label: label.trim().slice(0, 200) });
    } catch {
      // Not a URL.
    }
  };
  for (const a of document.querySelectorAll<HTMLAnchorElement>('a[href]')) add(a.href, a.textContent || a.download);
  for (const m of document.querySelectorAll<HTMLMediaElement | HTMLSourceElement>('video[src], audio[src], source[src]')) {
    add(m.getAttribute('src'), m.getAttribute('title') ?? '');
  }
  return out;
}

/** The page's file links: http(s), a known file extension, no duplicates. */
export function fileLinks(raw: { url: string; label: string }[]): PageLink[] {
  const seen = new Set<string>();
  const out: PageLink[] = [];
  for (const { url, label } of raw) {
    if (!/^https?:/i.test(url)) continue;
    const clean = url.replace(/#.*$/, '');
    if (seen.has(clean)) continue;
    const ext = extensionOf(clean);
    if (!FILE_EXTENSIONS.has(ext)) continue;
    seen.add(clean);
    const name = decodeURIComponent(new URL(clean).pathname.split('/').at(-1) ?? '');
    out.push({ url: clean, label: label || name, ext });
  }
  return out;
}

/** URLs in pasted text: one per line, or separated by spaces. */
export function parseUrls(text: string): string[] {
  const out = new Set<string>();
  for (const token of text.split(/\s+/)) {
    if (!token) continue;
    try {
      const u = new URL(token);
      if (u.protocol === 'http:' || u.protocol === 'https:') out.add(u.href);
    } catch {
      // Not a URL.
    }
  }
  return [...out];
}
