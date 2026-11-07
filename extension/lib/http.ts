/** Small HTTP helpers for the download worker. */

/** Parses `bytes first-last/total` (total may be `*`). */
export function parseContentRange(
  value: string | null,
): { first: number; last: number; total: number | null } | null {
  const m = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(value?.trim() ?? '');
  if (!m) return null;
  return { first: Number(m[1]), last: Number(m[2]), total: m[3] === '*' ? null : Number(m[3]) };
}

/** Strong ETag, else Last-Modified: sent as If-Range so every part comes
 * from the same version of the file. Weak ETags are not allowed there. */
export function validator(headers: Headers): string | null {
  const etag = headers.get('etag');
  if (etag && !etag.startsWith('W/')) return etag;
  return headers.get('last-modified');
}

export function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 429 || status === 408;
}
