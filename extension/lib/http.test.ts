import { describe, expect, it } from 'vitest';
import { isRetryableStatus, parseContentRange, validator } from './http';

describe('parseContentRange', () => {
  it('parses valid ranges', () => {
    expect(parseContentRange('bytes 0-0/1234')).toEqual({ first: 0, last: 0, total: 1234 });
    expect(parseContentRange('bytes 10-99/*')).toEqual({ first: 10, last: 99, total: null });
  });

  it('rejects anything else', () => {
    expect(parseContentRange('bytes */1234')).toBeNull();
    expect(parseContentRange('items 0-1/2')).toBeNull();
    expect(parseContentRange(null)).toBeNull();
  });
});

describe('validator', () => {
  it('prefers a strong ETag, skips weak ones', () => {
    expect(validator(new Headers({ etag: '"v1"', 'last-modified': 'x' }))).toBe('"v1"');
    expect(validator(new Headers({ etag: 'W/"v1"', 'last-modified': 'x' }))).toBe('x');
    expect(validator(new Headers())).toBeNull();
  });
});

describe('isRetryableStatus', () => {
  it('retries server trouble, not client errors', () => {
    expect([500, 503, 429, 408].every(isRetryableStatus)).toBe(true);
    expect([400, 403, 404, 416].some(isRetryableStatus)).toBe(false);
  });
});
