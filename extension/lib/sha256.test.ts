import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Sha256 } from './sha256';

const node = (d: Uint8Array) => createHash('sha256').update(d).digest('hex');

describe('Sha256', () => {
  it('matches known vectors', () => {
    expect(new Sha256().hex()).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(new Sha256().update(new TextEncoder().encode('abc')).hex()).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it.each([0, 1, 55, 56, 63, 64, 65, 119, 120, 1000, 100_003])('matches node for %i bytes', (n) => {
    const data = randomBytes(n);
    expect(new Sha256().update(data).hex()).toBe(node(data));
  });

  it('gives the same hash however the data is cut', () => {
    const data = randomBytes(10_000);
    const h = new Sha256();
    for (let i = 0; i < data.length; ) {
      const n = 1 + ((i * 7919) % 300);
      h.update(data.subarray(i, i + n));
      i += n;
    }
    expect(h.hex()).toBe(node(data));
  });

  it('is fast enough to run while the file is being saved', () => {
    const data = randomBytes(64 << 20);
    const t = performance.now();
    new Sha256().update(data).hex();
    const mbps = 64 / ((performance.now() - t) / 1000);
    console.log(`SHA-256: ${mbps.toFixed(0)} MB/s`);
    // A smoke check, not a benchmark: shared CI machines are slower.
    expect(mbps).toBeGreaterThan(20);
  });
});
