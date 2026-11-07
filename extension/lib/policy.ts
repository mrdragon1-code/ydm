/** Which browser downloads YDM takes over, and the settings behind it.
 * Everything else is left alone. */

import type { Text } from './i18n';

export interface Settings {
  enabled: boolean;
  /** Below this, parallel connections gain nothing. */
  minSize: number;
  /** Most parallel connections per download. YDM starts with fewer and
   * adds more while the speed keeps rising. Browsers open at most six
   * HTTP/1.1 connections per host, shared by all downloads from it. */
  connections: number;
  /** Downloads running at once; the rest wait. */
  parallel: number;
  /** Programs (.exe, .msi, …) go to the browser's own downloader, whose
   * Safe Browsing check also looks at the site they come from. */
  programsToBrowser: boolean;
  /** Hosts never taken over; a host also covers its subdomains. */
  excluded: string[];
  /** Bytes per second for all downloads together, 0 for no limit. */
  speedLimit: number;
  /** 'auto' (the browser's language) or a locale code such as 'pt_BR'. */
  language: string;
  /** A system notification when a download finishes. */
  notify: boolean;
  /** SHA-256 of every finished file, shown in the downloads page. */
  checksum: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  minSize: 5 * 1024 * 1024,
  connections: 4,
  parallel: 3,
  programsToBrowser: true,
  excluded: [],
  speedLimit: 0,
  language: 'auto',
  notify: true,
  checksum: true,
};

export const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[];

export const LIMITS = {
  minSizeMb: [1, 1000],
  connections: [1, 6],
  parallel: [1, 6],
  speedLimitMb: [0, 1000],
} as const;

/** Settings from storage, with anything missing or out of range replaced. */
export function readSettings(stored: Record<string, unknown>): Settings {
  const int = (v: unknown, [lo, hi]: readonly [number, number], fallback: number) =>
    typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : fallback;
  const d = DEFAULT_SETTINGS;
  const mb = 1024 * 1024;
  return {
    enabled: typeof stored.enabled === 'boolean' ? stored.enabled : d.enabled,
    minSize:
      typeof stored.minSize === 'number' &&
      stored.minSize >= LIMITS.minSizeMb[0] * mb &&
      stored.minSize <= LIMITS.minSizeMb[1] * mb
        ? stored.minSize
        : d.minSize,
    connections: int(stored.connections, LIMITS.connections, d.connections),
    parallel: int(stored.parallel, LIMITS.parallel, d.parallel),
    programsToBrowser: typeof stored.programsToBrowser === 'boolean' ? stored.programsToBrowser : d.programsToBrowser,
    excluded: Array.isArray(stored.excluded)
      ? stored.excluded.filter((h): h is string => typeof h === 'string' && h.length > 0)
      : d.excluded,
    speedLimit:
      typeof stored.speedLimit === 'number' && stored.speedLimit >= 0 && stored.speedLimit <= LIMITS.speedLimitMb[1] * mb
        ? Math.floor(stored.speedLimit)
        : d.speedLimit,
    language: typeof stored.language === 'string' && /^(auto|[a-z]{2,3}(_[A-Z]{2})?)$/.test(stored.language)
      ? stored.language
      : d.language,
    notify: typeof stored.notify === 'boolean' ? stored.notify : d.notify,
    checksum: typeof stored.checksum === 'boolean' ? stored.checksum : d.checksum,
  };
}

export interface Candidate {
  url: string;
  incognito: boolean;
  state: string;
  /** -1 or 0 when the server sent no length. */
  totalBytes: number;
  /** Started by YDM itself: a finished file being saved, or a hand-back. */
  byUs: boolean;
  /** The page posted a form to this URL; fetching it again would be a GET. */
  fromPost: boolean;
  /** Name the browser picked, if it already has one. */
  name?: string;
  mime?: string;
}

export function shouldIntercept(c: Candidate, s: Settings): boolean {
  return (
    s.enabled &&
    !c.byUs &&
    // Incognito downloads must not end up in YDM's list.
    !c.incognito &&
    c.state === 'in_progress' &&
    /^https?:/i.test(c.url) &&
    !c.fromPost &&
    // Unknown size: probably generated on the fly, so no ranges and no gain.
    c.totalBytes >= s.minSize &&
    !isExcluded(c.url, s.excluded) &&
    !(s.programsToBrowser && isProgram(c.name || c.url, c.mime))
  );
}

/** File types Windows, macOS or Linux run directly: the ones Safe Browsing
 * checks most closely. Archives and disk images stay with YDM. */
const PROGRAM = new Set([
  'exe', 'msi', 'msix', 'msixbundle', 'appx', 'appxbundle', 'com', 'scr', 'pif', 'cpl',
  'bat', 'cmd', 'ps1', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'hta', 'lnk', 'reg',
  'jar', 'dll', 'sys', 'apk', 'pkg', 'app', 'deb', 'rpm', 'sh', 'run', 'appimage',
]);

const PROGRAM_MIME = new Set([
  'application/x-msdownload',
  'application/x-msi',
  'application/x-ms-installer',
  'application/x-dosexec',
  'application/vnd.microsoft.portable-executable',
  'application/vnd.android.package-archive',
  'application/java-archive',
]);

/** `name` is a file name, a path or a URL. */
export function isProgram(name: string, mime?: string): boolean {
  if (mime && PROGRAM_MIME.has(mime.split(';')[0]!.trim().toLowerCase())) return true;
  let path = name;
  try {
    path = decodeURIComponent(new URL(name).pathname);
  } catch {
    // Already a plain name.
  }
  const ext = /\.([a-z0-9]+)$/i.exec(path.split(/[/\\]/).at(-1) ?? '')?.[1]?.toLowerCase();
  return ext !== undefined && PROGRAM.has(ext);
}

export function isExcluded(url: string, hosts: string[]): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return hosts.some((h) => host === h || host.endsWith(`.${h}`));
}

/** What someone typed as a site ("https://www.example.com/x", "*.example.com")
 * reduced to a host name, or null if it is not one. "www." is dropped, so
 * the whole site is excluded, not only its www address. */
export function normalizeHost(input: string): string | null {
  let s = input.trim().toLowerCase().replace(/^\*\./, '');
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(s)) s = `https://${s}`;
  try {
    const host = new URL(s).hostname.replace(/^www\./, '');
    return /^[a-z0-9.-]+$/.test(host) && host.includes('.') ? host : null;
  } catch {
    return null;
  }
}

const SAVE_ERRORS: Record<string, string> = {
  FILE_VIRUS_INFECTED: 'saveVirus',
  FILE_BLOCKED: 'saveBlocked',
  FILE_SECURITY_CHECK_FAILED: 'saveBlocked',
  // Firefox reports anything but a network or disk failure as CRASH,
  // including its own security checks blocking the file.
  CRASH: 'saveCrash',
  FILE_NO_SPACE: 'saveNoSpace',
  FILE_TOO_LARGE: 'saveTooLarge',
  FILE_ACCESS_DENIED: 'saveAccessDenied',
};

/** Why the browser did not save a file YDM finished, as a message. */
export function describeSaveError(error: string | undefined): Text {
  const known = error && SAVE_ERRORS[error];
  if (known) return { key: `reason.${known}` };
  return error ? { key: 'reason.saveFailed', params: { error } } : { key: 'reason.saveFailedPlain' };
}
