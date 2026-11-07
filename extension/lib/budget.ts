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

/** What each host tolerated, remembered for a week. */
export interface HostCap {
  connections: number;
  at: number;
}

export const CAP_MAX_AGE = 7 * 24 * 3600 * 1000;

export function freshCaps(caps: Record<string, HostCap>, now = Date.now()): Record<string, HostCap> {
  return Object.fromEntries(Object.entries(caps).filter(([, c]) => now - c.at < CAP_MAX_AGE));
}
