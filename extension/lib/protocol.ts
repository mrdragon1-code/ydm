/** Messages between the background, the engine page and the popup. */

import type { Text } from './i18n';
import type { Settings } from './policy';

/** A reason shown to the user: a message key, translated by the page that
 * shows it. Plain strings are reasons saved by YDM 0.2, in Italian. */
export type Reason = Text | string;

export type State =
  | 'queued'
  | 'running'
  /** Stopped by the user; what is on disk is kept for later. */
  | 'paused'
  /** Finished in YDM's storage; the browser is copying it to Downloads. */
  | 'saving'
  | 'completed'
  | 'failed'
  | 'cancelled'
  /** YDM could not do it; handed back to the browser's own downloader. */
  | 'browser';

export interface Item {
  id: number;
  name: string;
  state: State;
  done: number;
  total: number | null;
  /** Bytes per second, smoothed. */
  speed: number;
  /** Why it failed or went back to the browser. */
  reason?: Reason;
  /** Transfer time in milliseconds, once the file is complete. */
  elapsed?: number;
  /** While running: each connection's range as `[start, pos, end]`. */
  parts?: Part[];
  /** Paused or queued with bytes on disk that a restart can keep. */
  resumable?: boolean;
  /** Where it is downloaded from. */
  url?: string;
  /** Of the finished file; `pending` while it is computed. */
  sha256?: string;
  /** Where the browser saved it, once known. */
  downloadId?: number;
}

export type Part = [start: number, pos: number, end: number];

/** Where a download stood, to pick it up after the browser was closed. */
export interface Checkpoint {
  total: number;
  /** ETag or Last-Modified: resuming is only safe if the file is the same. */
  validator: string;
  /** Byte ranges still missing, `[from, to)`; everything else is on disk. */
  missing: [number, number][];
}

/** Background → engine. */
export type EngineCommand =
  | {
      type: 'add';
      id: number;
      url: string;
      name?: string;
      connections: number;
      resume?: Checkpoint;
      /** Bytes per second, 0 for no limit. */
      limit: number;
      /** Compute the finished file's SHA-256. */
      checksum?: boolean;
    }
  /** `keep`: a pause, the partial file stays for a later resume. */
  | { type: 'cancel'; id: number; keep?: boolean }
  | { type: 'limit'; id: number; bytesPerSecond: number }
  /** The most connections this download may use now (per-host budget). */
  | { type: 'connections'; id: number; max: number }
  /** The browser has copied the file; delete YDM's copy. */
  | { type: 'release'; id: number }
  /** A fresh engine: delete leftover files except those to resume. */
  | { type: 'prune'; keep: number[] };

/** Engine → background. */
export type EngineEvent =
  /** `url` is where the file really is, after redirects. */
  | { type: 'started'; id: number; name: string; total: number | null; url: string }
  /** The server refused more connections than this. */
  | { type: 'capped'; id: number; connections: number }
  | { type: 'progress'; id: number; done: number; total: number | null; parts?: Part[] }
  | { type: 'checkpoint'; id: number; checkpoint: Checkpoint }
  | { type: 'ready'; id: number; name: string; blobUrl: string }
  | { type: 'hashed'; id: number; sha256: string }
  | { type: 'failed'; id: number; reason: Reason; retryInBrowser: boolean }
  | { type: 'cancelled'; id: number };

/** Engine page → download worker. */
export type WorkerCommand =
  | {
      type: 'start';
      url: string;
      name?: string;
      connections: number;
      file: string;
      resume?: Checkpoint;
      /** Bytes per second, 0 for no limit. */
      limit?: number;
    }
  | { type: 'limit'; bytesPerSecond: number }
  | { type: 'connections'; max: number }
  | { type: 'cancel' };

/** Download worker → engine page. Sent after the file handle is closed. */
export type WorkerEvent =
  | { type: 'started'; name: string; total: number | null; url: string }
  | { type: 'capped'; connections: number }
  | { type: 'progress'; done: number; total: number | null; parts?: Part[] }
  /** Everything outside `missing` has been flushed to disk. */
  | { type: 'checkpoint'; checkpoint: Checkpoint }
  | { type: 'done'; name: string; size: number }
  | { type: 'failed'; reason: Reason; retryInBrowser: boolean }
  | { type: 'cancelled' };

/** Background → popup and downloads page: the whole list, newest first,
 * or (`patch`) only the items that changed. */
export type PopupState =
  | (PageInfo & { type: 'state'; items: Item[] })
  | (PageInfo & { type: 'patch'; items: Item[]; removed: number[] });

interface PageInfo {
  enabled: boolean;
  /** Smallest download taken over, in bytes. */
  minSize: number;
  settings: Settings;
}

/** Popup → background. */
export type PopupCommand =
  | { type: 'cancel'; id: number }
  | { type: 'pause'; id: number }
  | { type: 'resume'; id: number }
  | { type: 'retry'; id: number }
  | { type: 'show'; id: number }
  | { type: 'enabled'; value: boolean }
  | { type: 'clear' }
  /** Takes a finished, failed or cancelled one off the list. */
  | { type: 'remove'; id: number }
  /** Pasted links or links picked from a page; `referrer`: that page. */
  | { type: 'urls'; urls: string[]; referrer?: string };
