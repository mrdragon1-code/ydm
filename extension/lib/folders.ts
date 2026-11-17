/**
 * Sorting saved files into folders inside Downloads: by kind (Video,
 * Documents, …) and by the user's rules ("files from this site go to …",
 * "this extension goes to …"). Pure functions; the background applies them
 * when the browser saves a file.
 *
 * A folder comes from the user, so it is checked like a file name: never
 * outside Downloads, nothing Windows rejects, at most two levels.
 */

import { type Category, categoryOf, extOfName } from './filetypes';
import { sanitize } from './naming';

export type { Category } from './filetypes';

export interface FolderRule {
  /** `site`: the download's host or a subdomain; `ext`: the file's extension. */
  kind: 'site' | 'ext';
  /** Lowercase host ("example.com") or extension without the dot ("pdf"). */
  match: string;
  folder: string;
}

export interface Organize {
  organize: boolean;
  /** A folder per kind; '' saves that kind in Downloads itself. */
  folders: Record<Category, string>;
  rules: FolderRule[];
}

export const MAX_RULES = 50;
const MAX_DEPTH = 2;
const MAX_SEGMENT = 64;

/** A folder as typed by the user, made safe ("Video", "Work/PDF"); '' for
 * "Downloads itself"; null if it cannot be used. */
export function cleanFolder(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  // Absolute paths and drives would leave the Downloads folder.
  if (/^[/\\]/.test(trimmed) || /^[a-z]:/i.test(trimmed)) return null;
  const parts = trimmed.split(/[/\\]+/).filter(Boolean);
  if (parts.length > MAX_DEPTH) return null;
  for (const part of parts) {
    if (part === '.' || part === '..' || part.length > MAX_SEGMENT) return null;
    // Each level must already be a valid name: not changed by sanitize()
    // (reserved names like CON, characters Windows rejects, trailing dots).
    if (sanitize(part) !== part) return null;
  }
  return parts.join('/');
}

/** A rule as typed by the user, made safe; null if it cannot be used. */
export function cleanRule(raw: unknown): FolderRule | null {
  const r = raw as Partial<FolderRule> | null;
  if (!r || (r.kind !== 'site' && r.kind !== 'ext') || typeof r.match !== 'string' || typeof r.folder !== 'string') return null;
  const match = r.match.trim().toLowerCase().replace(r.kind === 'ext' ? /^\.+/ : /^www\./, '');
  const valid = r.kind === 'ext' ? /^[a-z0-9]{1,10}$/.test(match) : /^[a-z0-9.-]+\.[a-z0-9-]+$/.test(match);
  const folder = cleanFolder(r.folder);
  if (!valid || folder === null) return null;
  return { kind: r.kind, match, folder };
}

function hostMatches(host: string, site: string): boolean {
  return host === site || host.endsWith(`.${site}`);
}

/** The folder for a file: the first rule that fits, else its kind's folder;
 * '' when sorting is off or nothing applies. */
export function folderFor(name: string, url: string | undefined, s: Organize): string {
  if (!s.organize) return '';
  let host = '';
  try {
    host = url ? new URL(url).hostname.toLowerCase() : '';
  } catch {
    // Not a web address: only extension rules can match.
  }
  const ext = extOfName(name);
  for (const rule of s.rules) {
    if (rule.kind === 'ext' ? rule.match === ext : host !== '' && hostMatches(host, rule.match)) return rule.folder;
  }
  const kind = categoryOf(name);
  return kind ? s.folders[kind] : '';
}

/** A path relative to Downloads, as the downloads API takes it. */
export function withFolder(folder: string, name: string): string {
  return folder ? `${folder}/${name}` : name;
}

/** Folder names in a language, used when sorting is first turned on: they
 * are then kept as they are, so they do not change with the interface. */
export function defaultFolders(translate: (key: string) => string): Record<Category, string> {
  return {
    video: translate('folders.video'),
    audio: translate('folders.audio'),
    images: translate('folders.images'),
    documents: translate('folders.documents'),
    archives: translate('folders.archives'),
    programs: translate('folders.programs'),
  };
}
