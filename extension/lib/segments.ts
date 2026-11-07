/**
 * Byte-range bookkeeping for one download.
 *
 * Each segment is owned by one connection, which fetches it front to back.
 * A connection that runs out of work helps the segment that will finish
 * last (bytes left ÷ its speed), taking its back half, so no connection
 * sits idle near the end and a slow one cannot hold the download up. A
 * connection the server keeps refusing retires and leaves its segment to
 * the others.
 *
 * Writes are synchronous in the download worker, so claiming bytes and
 * writing them happen in one uninterrupted step: no in-flight state.
 */

/** Never split below this: a new request would cost more than it saves. */
export const MIN_SPLIT = 1 << 20;

/** Speeds are averaged over about this long. */
const SPEED_WINDOW_MS = 2000;

export interface Segment {
  start: number;
  /** Every byte in `start..pos` is on disk. */
  pos: number;
  /** Exclusive; shrinks when another connection takes the tail. */
  end: number;
  /** Its connection retired; the next idle one adopts it. */
  orphan: boolean;
  /** Bytes per second, smoothed; 0 until measured. */
  speed: number;
  /** When `speed` was last updated, and `pos` then. */
  sampledAt: number;
  sampledPos: number;
}

export class Segments {
  readonly list: Segment[] = [];
  /** Connections still running. */
  private active: number;

  constructor(
    total: number,
    connections: number,
    private readonly now: () => number = () => performance.now(),
  ) {
    const n = Math.max(1, Math.min(connections, total));
    const size = Math.floor(total / n);
    for (let i = 0; i < n; i++) {
      const start = i * size;
      const end = i === n - 1 ? total : start + size;
      this.list.push(this.segment(start, end));
    }
    this.active = this.list.length;
  }

  /** Picks up the `missing` ranges of an earlier run. Ranges beyond the
   * number of connections start as orphans, adopted as connections free up. */
  static resume(missing: [number, number][], connections: number, now?: () => number): Segments {
    const segs = new Segments(0, 1, now);
    segs.list.length = 0;
    for (const [from, to] of missing) {
      if (to > from) segs.list.push({ ...segs.segment(from, to), orphan: segs.list.length >= connections });
    }
    segs.active = connections;
    return segs;
  }

  private segment(start: number, end: number): Segment {
    return { start, pos: start, end, orphan: false, speed: 0, sampledAt: this.now(), sampledPos: start };
  }

  /** Every range with its progress, for the popup. */
  parts(): [number, number, number][] {
    return this.list.map((s) => [s.start, s.pos, s.end]);
  }

  /** The ranges not yet on disk, for a checkpoint. */
  missing(): [number, number][] {
    return this.list.filter((s) => s.pos < s.end).map((s) => [s.pos, s.end]);
  }

  get(id: number): Segment {
    const s = this.list[id];
    if (!s) throw new RangeError(`no segment ${id}`);
    return s;
  }

  remaining(id: number): number {
    const s = this.get(id);
    return s.end - s.pos;
  }

  /** Connections currently fetching (not finished, not retired). */
  get running(): number {
    return this.active;
  }

  /**
   * Takes up to `len` bytes at the head of a segment. Returns where to write
   * them and how many to keep; fewer than `len` means the segment ended.
   */
  claim(id: number, len: number): { offset: number; take: number } {
    const s = this.get(id);
    const take = Math.min(len, s.end - s.pos);
    const offset = s.pos;
    s.pos += take;
    this.sample(s);
    return { offset, take };
  }

  private sample(s: Segment) {
    const now = this.now();
    const dt = now - s.sampledAt;
    if (dt < 250) return;
    const instant = ((s.pos - s.sampledPos) * 1000) / dt;
    const weight = Math.min(1, dt / SPEED_WINDOW_MS);
    s.speed = s.speed ? s.speed + weight * (instant - s.speed) : instant;
    s.sampledAt = now;
    s.sampledPos = s.pos;
  }

  /** Seconds until a segment is done at its current speed; unmeasured
   * ones count as slow, so a new connection's range is not split blindly. */
  private eta(s: Segment): number {
    const left = s.end - s.pos;
    if (left <= 0) return 0;
    if (!s.speed) return left / 1;
    return left / s.speed;
  }

  /**
   * Work for a connection whose segment is done: an orphan, or the back
   * half of the segment that will finish last. `null` means it should stop,
   * and it is then counted out.
   */
  nextWork(): number | null {
    const id = this.help();
    if (id === null) this.active--;
    return id;
  }

  /** Like `nextWork` for a connection being added: `null` leaves the
   * count alone, since nothing was counted in. */
  addWork(): number | null {
    const id = this.help();
    if (id !== null) this.active++;
    return id;
  }

  private help(): number | null {
    const orphan = this.list.findIndex((s) => s.orphan && s.end > s.pos);
    if (orphan >= 0) {
      this.get(orphan).orphan = false;
      return orphan;
    }
    let victim = -1;
    let worst = 0;
    for (let i = 0; i < this.list.length; i++) {
      const s = this.list[i]!;
      if (s.orphan || this.remaining(i) < 2 * MIN_SPLIT) continue;
      const eta = this.eta(s);
      if (victim < 0 || eta > worst) {
        victim = i;
        worst = eta;
      }
    }
    if (victim < 0) return null;
    const v = this.get(victim);
    // Split where both halves finish together: a new connection starts at
    // about the median speed, the old one goes on at its own.
    const others = this.list.filter((s) => s !== v && s.speed > 0).map((s) => s.speed);
    const fresh = median(others) || v.speed || 1;
    const share = v.speed ? fresh / (fresh + v.speed) : 0.5;
    const left = v.end - v.pos;
    const take = Math.min(left - MIN_SPLIT, Math.max(MIN_SPLIT, Math.floor(left * share)));
    const mid = v.end - take;
    this.list.push(this.segment(mid, v.end));
    v.end = mid;
    return this.list.length - 1;
  }

  /**
   * A connection crawling far behind the others, near the end of the
   * download, where it would hold everything up: the caller drops its
   * request and gives the range to a fresh connection. Only one at a time,
   * and only when there are others to compare with.
   */
  straggler(): number | null {
    const live = this.list.filter((s) => s.pos < s.end && !s.orphan && s.speed > 0);
    if (live.length < 2) return null;
    const med = median(live.map((s) => s.speed));
    const now = this.now();
    let worst: Segment | null = null;
    for (const s of live) {
      // Measured for a while, far below the others, and with enough left
      // that a new request is worth it.
      if (now - s.sampledAt > 1000) continue;
      if (s.speed >= med / 4 || s.end - s.pos < 2 * MIN_SPLIT) continue;
      if (!worst || s.speed < worst.speed) worst = s;
    }
    return worst ? this.list.indexOf(worst) : null;
  }

  /** A connection with no segment leaves to free a slot; refused for the
   * last one, which must finish the download. */
  leave(): boolean {
    if (this.active <= 1) return false;
    this.active--;
    return true;
  }

  /** Lets a failing connection leave; refused for the last one. */
  retire(id: number): boolean {
    if (this.active <= 1) return false;
    this.active--;
    this.get(id).orphan = true;
    return true;
  }

  /** Total speed of all connections, bytes per second. */
  speed(): number {
    return this.list.reduce((sum, s) => sum + (s.pos < s.end ? s.speed : 0), 0);
  }

  written(): number {
    return this.list.reduce((sum, s) => sum + (s.pos - s.start), 0);
  }

  complete(): boolean {
    return this.list.every((s) => s.pos === s.end);
  }
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}
