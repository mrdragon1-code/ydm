/**
 * Byte-range bookkeeping for one download.
 *
 * Each segment is owned by one connection, which fetches it front to back.
 * A connection that runs out of work takes the back half of the segment
 * with the most bytes left, so none sits idle near the end. A connection
 * the server keeps refusing retires and leaves its segment to the others.
 *
 * Writes are synchronous in the download worker, so claiming bytes and
 * writing them happen in one uninterrupted step: no in-flight state.
 */

/** Never split below this: a new request would cost more than it saves. */
export const MIN_SPLIT = 1 << 20;

export interface Segment {
  start: number;
  /** Every byte in `start..pos` is on disk. */
  pos: number;
  /** Exclusive; shrinks when another connection takes the tail. */
  end: number;
  /** Its connection retired; the next idle one adopts it. */
  orphan: boolean;
}

export class Segments {
  readonly list: Segment[] = [];
  /** Connections still running. */
  private active: number;

  constructor(total: number, connections: number) {
    const n = Math.max(1, Math.min(connections, total));
    const size = Math.floor(total / n);
    for (let i = 0; i < n; i++) {
      const start = i * size;
      const end = i === n - 1 ? total : start + size;
      this.list.push({ start, pos: start, end, orphan: false });
    }
    this.active = this.list.length;
  }

  /** Picks up the `missing` ranges of an earlier run. Ranges beyond the
   * number of connections start as orphans, adopted as connections free up. */
  static resume(missing: [number, number][], connections: number): Segments {
    const segs = new Segments(0, 1);
    segs.list.length = 0;
    for (const [from, to] of missing) {
      if (to > from) segs.list.push({ start: from, pos: from, end: to, orphan: segs.list.length >= connections });
    }
    segs.active = connections;
    return segs;
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

  /**
   * Takes up to `len` bytes at the head of a segment. Returns where to write
   * them and how many to keep; fewer than `len` means the segment ended.
   */
  claim(id: number, len: number): { offset: number; take: number } {
    const s = this.get(id);
    const take = Math.min(len, s.end - s.pos);
    const offset = s.pos;
    s.pos += take;
    return { offset, take };
  }

  /**
   * Work for a connection whose segment is done: an orphan, or the back
   * half of the largest remaining segment. `null` means it should stop,
   * and it is then counted out.
   */
  nextWork(): number | null {
    const orphan = this.list.findIndex((s) => s.orphan && s.end > s.pos);
    if (orphan >= 0) {
      this.get(orphan).orphan = false;
      return orphan;
    }
    let victim = -1;
    for (let i = 0; i < this.list.length; i++) {
      const left = this.remaining(i);
      if (left >= 2 * MIN_SPLIT && (victim < 0 || left > this.remaining(victim))) victim = i;
    }
    if (victim < 0) {
      this.active--;
      return null;
    }
    const v = this.get(victim);
    const mid = v.pos + Math.floor((v.end - v.pos) / 2);
    this.list.push({ start: mid, pos: mid, end: v.end, orphan: false });
    v.end = mid;
    return this.list.length - 1;
  }

  /** Lets a failing connection leave; refused for the last one. */
  retire(id: number): boolean {
    if (this.active <= 1) return false;
    this.active--;
    this.get(id).orphan = true;
    return true;
  }

  written(): number {
    return this.list.reduce((sum, s) => sum + (s.pos - s.start), 0);
  }

  complete(): boolean {
    return this.list.every((s) => s.pos === s.end);
  }
}
