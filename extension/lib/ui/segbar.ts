/** The signature progress bar, drawn as a CSS background from the ranges:
 * filled where bytes are on disk, empty where a connection has still to
 * get there, and a thin cut where one connection's range ends and the next
 * begins. */

import type { Part } from '../protocol';

export function paint(total: number, done: number, parts: Part[] | undefined): string {
  const fill = 'var(--malachite)';
  const pct = (n: number) => `${((n / total) * 100).toFixed(3)}%`;
  if (!parts?.length) return `linear-gradient(90deg, ${fill} 0 ${pct(done)}, transparent ${pct(done)})`;
  // What is missing; everything else is on disk (also from before a restart).
  const gaps = parts
    .filter(([, pos, end]) => pos < end)
    .map(([, pos, end]) => [pos, end] as const)
    .sort((a, b) => a[0] - b[0]);
  const stops: string[] = [];
  let at = 0;
  for (const [from, to] of gaps) {
    if (from > at) stops.push(`${fill} ${pct(at)} ${pct(from)}`);
    stops.push(`transparent ${pct(from)} ${pct(to)}`);
    at = to;
  }
  if (at < total) stops.push(`${fill} ${pct(at)} 100%`);
  const cuts = parts
    .map(([start]) => start)
    .filter((start) => start > 0)
    .map(
      (start) =>
        `linear-gradient(90deg, transparent calc(${pct(start)} - 1px), var(--paper) calc(${pct(start)} - 1px) calc(${pct(start)} + 1px), transparent calc(${pct(start)} + 1px))`,
    );
  return [...cuts, `linear-gradient(90deg, ${stops.join(', ') || 'transparent 0 100%'})`].join(', ');
}

/** Connections fetching right now. */
export function working(parts: Part[] | undefined): number {
  return parts?.filter(([, pos, end]) => pos < end).length ?? 0;
}
