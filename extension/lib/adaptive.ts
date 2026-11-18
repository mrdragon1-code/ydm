/**
 * How many connections a download uses. It starts with a few (or with what
 * worked best on this site before) and adds one at a time while the total
 * speed keeps rising. When an extra connection buys nothing (the line is
 * full, or an HTTP/2 server multiplexes every request onto one socket) it
 * holds, and tries once more a little later: conditions change during a
 * long download. A server that refuses connections (429, 503, resets)
 * lowers the ceiling for good.
 */

/** Connections a download opens straight away, with no history. */
export const START = 4;
/** Time each step gets before its speed is judged. */
export const STEP_MS = 1000;
/** An extra connection must raise the speed by this much to stay. */
const GAIN = 1.1;
/** After adding stopped paying off: first wait before trying again, and
 * the longest wait (each failed try doubles it). */
export const RETRY_MS = 10_000;
const RETRY_MAX_MS = 60_000;

export type Decision = 'add' | 'hold';

export class Adaptive {
  /** Most connections allowed now: the user's setting, the per-host
   * budget, and what the server tolerates. */
  private ceiling: number;
  /** What the server tolerates, once it has refused a connection. */
  private tolerated = Infinity;
  /** Speed of the last step judged, the bar the next connection must beat. */
  private bar = 0;
  private stepAt: number;
  private stepBytes = 0;
  /** Adding stopped paying off: no more tries before this time. */
  private retryAt: number | null = null;
  private retryWait = RETRY_MS;
  /** The best seen so far, remembered for the site. */
  private peak = { connections: 0, speed: 0 };

  constructor(
    max: number,
    /** Connections that worked best on this site before, if known. */
    private readonly hint?: number,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.ceiling = Math.max(1, max);
    this.stepAt = now();
  }

  /** Connections to open at the start. */
  initial(): number {
    return Math.max(1, Math.min(this.hint ?? START, this.ceiling));
  }

  get max(): number {
    return this.ceiling;
  }

  /** The fastest step so far and how many connections it had. */
  get best(): { connections: number; speed: number } {
    return { ...this.peak };
  }

  /** The per-host budget changed: a raise lets probing resume at once. */
  setMax(max: number) {
    const next = Math.max(1, Math.min(max, this.tolerated));
    if (next > this.ceiling) this.retryAt = null;
    this.ceiling = next;
  }

  /** The server refused a connection while `running` were open. */
  refused(running: number) {
    this.tolerated = Math.max(1, running - 1);
    this.ceiling = Math.min(this.ceiling, this.tolerated);
  }

  /**
   * Called regularly with the connections fetching now, the bytes received
   * so far, and how many of them are still warming up (no first byte yet,
   * or just got it). Warming connections are not judged: their set-up time
   * would make an extra connection look useless.
   */
  tick(running: number, bytes: number, warming = 0): Decision {
    const now = this.now();
    if (warming > 0) {
      this.stepAt = now;
      this.stepBytes = bytes;
      return 'hold';
    }
    const elapsed = now - this.stepAt;
    if (elapsed < STEP_MS) return 'hold';
    const speed = ((bytes - this.stepBytes) * 1000) / elapsed;
    this.stepAt = now;
    this.stepBytes = bytes;
    if (speed > this.peak.speed) this.peak = { connections: running, speed };

    if (running >= this.ceiling) {
      this.bar = speed;
      return 'hold';
    }
    if (this.retryAt !== null) {
      // Holding: the bar follows the current speed, so a later try is
      // judged against now, not against an old peak.
      this.bar = speed;
      if (now < this.retryAt) return 'hold';
      this.retryAt = null;
      return 'add';
    }
    if (this.bar > 0 && speed < this.bar * GAIN) {
      // The last connection did not pay for itself: hold, try again later.
      this.retryAt = now + this.retryWait;
      this.retryWait = Math.min(RETRY_MAX_MS, this.retryWait * 2);
      this.bar = speed;
      return 'hold';
    }
    if (this.bar > 0) this.retryWait = RETRY_MS;
    this.bar = speed;
    return 'add';
  }
}
