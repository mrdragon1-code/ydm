import { describe, expect, it } from 'vitest';
import { translateOne } from './translate';

/** A fake translator: uppercases, and can drop or mangle tokens. */
const fake = (mangle: (s: string) => string = (s) => s) => ({
  translate: async (s: string) => mangle(s.toUpperCase()),
});

describe('translateOne', () => {
  it('keeps placeholders and the product name untouched', async () => {
    expect(await translateOne(fake(), 'Download with YDM: {count} files')).toBe('DOWNLOAD WITH YDM: {count} FILES');
  });

  it('accepts tokens the translator spaced out', async () => {
    expect(await translateOne(fake((s) => s.replace('⟦0⟧', '⟦ 0 ⟧')), '{size} left')).toBe('{size} LEFT');
  });

  it('drops a translation that lost a placeholder', async () => {
    expect(await translateOne(fake((s) => s.replace('⟦0⟧', '')), '{size} left')).toBeNull();
  });

  it('works for text without placeholders', async () => {
    expect(await translateOne(fake(), 'Pause')).toBe('PAUSE');
  });
});
