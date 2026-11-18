/**
 * Connections per host. Chrome and Firefox open at most six HTTP/1.1
 * connections to one host, for the whole browser; requests beyond that
 * wait in the browser's queue. Three downloads of four connections from
 * the same mirror would then slow each other down and the page you are
 * browsing on that site would stall too. So the running downloads of a
 * host share six connections; when one finishes, the others get its
 * share back.
 */

export const PER_HOST = 6;
/** Left for the page itself and the browser's own requests to the host. */
const RESERVED = 0;

export interface Running {
  id: number;
  host: string;
}

/** How many connections each running download may use. `cap(host)` is
 * the most a host tolerated before (it refused more), if known. */
export function budgets(
  running: Running[],
  wanted: number,
  cap: (host: string) => number | undefined = () => undefined,
): Map<number, number> {
  const byHost = new Map<string, number[]>();
  for (const r of running) byHost.set(r.host, [...(byHost.get(r.host) ?? []), r.id]);
  const out = new Map<number, number>();
  for (const [host, ids] of byHost) {
    const pool = Math.max(1, Math.min(PER_HOST - RESERVED, cap(host) ?? Infinity));
    // Earlier downloads get the remainder: they are further along.
    const base = Math.floor(pool / ids.length);
    let extra = pool - base * ids.length;
    for (const id of ids.sort((a, b) => a - b)) {
      out.set(id, Math.max(1, Math.min(wanted, base + (extra-- > 0 ? 1 : 0))));
    }
  }
  return out;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * What YDM learned about a host. `connections`: the most it tolerated (it
 * refused more), kept a week. `best`: the connection count of the fastest
 * download from it, kept a month, so the next download starts there
 * instead of ramping up again.
 */
export interface HostCap {
  connections?: number;
  at: number;
  best?: number;
  speed?: number;
  bestAt?: number;
}

export const CAP_MAX_AGE = 7 * 24 * 3600 * 1000;
export const BEST_MAX_AGE = 30 * 24 * 3600 * 1000;
/** A tolerated count rises by one at most this often: trying one more
 * after every download would bring a burst of refusals every other time. */
export const RAISE_EVERY = 3600 * 1000;

/** Drops what is too old to trust; hosts with nothing left go. */
export function freshCaps(caps: Record<string, HostCap>, now = Date.now()): Record<string, HostCap> {
  const out: Record<string, HostCap> = {};
  for (const [host, c] of Object.entries(caps)) {
    if (!c || typeof c !== 'object') continue;
    const keep: HostCap = { at: c.at };
    if (typeof c.connections === 'number' && now - c.at < CAP_MAX_AGE) keep.connections = c.connections;
    if (typeof c.best === 'number' && typeof c.bestAt === 'number' && now - c.bestAt < BEST_MAX_AGE) {
      keep.best = c.best;
      keep.bestAt = c.bestAt;
      if (typeof c.speed === 'number') keep.speed = c.speed;
    }
    if (keep.connections !== undefined || keep.best !== undefined) out[host] = keep;
  }
  return out;
}

/** What a download reported about its host. */
export type CapEvent =
  /** The server refused more connections than this. */
  | { type: 'capped'; connections: number }
  /** Its fastest step (`connections`, `speed`), the most connections it
   * had open at once, and whether the server refused any. */
  | { type: 'tuned'; connections: number; speed: number; most: number; refused: boolean };

/** The host's record after an event. A refusal only lowers what is
 * tolerated; a download that used every allowed connection without being
 * refused lets it rise by one, so a host is not held down forever. */
export function mergeCap(old: HostCap | undefined, e: CapEvent, now = Date.now()): HostCap {
  const next: HostCap = { ...(old ?? { at: now }) };
  if (e.type === 'capped') {
    next.connections = Math.max(1, Math.min(old?.connections ?? Infinity, e.connections));
    next.at = now;
    return next;
  }
  // A slower download (sharing the host with others, a busy hour) does not
  // replace a better record unless that record is old.
  const better = e.speed >= (old?.speed ?? 0) * 0.8 || now - (old?.bestAt ?? 0) >= CAP_MAX_AGE;
  if (e.speed > 0 && e.connections > 0 && better) {
    next.best = Math.min(PER_HOST, e.connections);
    next.speed = Math.round(e.speed);
    next.bestAt = now;
  }
  if (!e.refused && next.connections !== undefined && e.most >= next.connections && now - next.at >= RAISE_EVERY) {
    if (next.connections + 1 >= PER_HOST) delete next.connections;
    else next.connections += 1;
    next.at = now;
  }
  return next;
}
