/**
 * How many connections a download uses. It starts with a few and adds one
 * at a time while the total speed keeps rising; when an extra connection
 * buys nothing (the line is full, or an HTTP/2 server multiplexes every
 * request onto one socket) it stops there. A server that refuses
 * connections (429, 503, resets) lowers the ceiling for good.
 */

/** Connections a download opens straight away. */
export const START = 4;
/** Time each step gets before its speed is judged. */
export const STEP_MS = 1000;
/** An extra connection must raise the speed by this much to stay. */
const GAIN = 1.1;

export type Decision = 'add' | 'hold';

export class Adaptive {
  /** Most connections allowed now: the user's setting, the per-host
   * budget, and what the server tolerates. */
  private ceiling: number;
  /** What the server tolerates, once it has refused a connection. */
  private tolerated = Infinity;
  private bestSpeed = 0;
  private stepAt: number;
  private stepBytes = 0;
  /** No more probing: adding stopped paying off. */
  private settled = false;

  constructor(
    max: number,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.ceiling = Math.max(1, max);
    this.stepAt = now();
  }

  /** Connections to open at the start. */
  initial(): number {
    return Math.min(START, this.ceiling);
  }

  get max(): number {
    return this.ceiling;
  }

  /** The per-host budget changed: a raise lets probing resume. */
  setMax(max: number) {
    const next = Math.max(1, Math.min(max, this.tolerated));
    if (next > this.ceiling) this.settled = false;
    this.ceiling = next;
  }

  /** The server refused a connection while `running` were open. */
  refused(running: number) {
    this.tolerated = Math.max(1, running - 1);
    this.ceiling = Math.min(this.ceiling, this.tolerated);
    this.settled = true;
  }

  /** Called regularly with the connections fetching now and the bytes
   * received so far. */
  tick(running: number, bytes: number): Decision {
    const now = this.now();
    const elapsed = now - this.stepAt;
    if (elapsed < STEP_MS) return 'hold';
    const speed = ((bytes - this.stepBytes) * 1000) / elapsed;
    this.stepAt = now;
    this.stepBytes = bytes;
    if (this.settled || running >= this.ceiling) {
      this.bestSpeed = Math.max(this.bestSpeed, speed);
      return 'hold';
    }
    if (this.bestSpeed > 0 && speed < this.bestSpeed * GAIN) {
      // The last connection did not pay for itself.
      this.settled = true;
      this.bestSpeed = Math.max(this.bestSpeed, speed);
      return 'hold';
    }
    this.bestSpeed = Math.max(this.bestSpeed, speed);
    return 'add';
  }
}
