import { describe, expect, it } from 'vitest';
import { isNewer, latestRelease, updatesItself } from './updates';

describe('isNewer', () => {
  it.each([
    ['1.0.1', '1.0.0', true],
    ['v1.10.0', '1.9.9', true],
    ['2.0', '1.99.99', true],
    ['1.0.0', '1.0.0', false],
    ['1.0.0', '1.0.1', false],
    ['1.0', '1.0.0', false],
    ['nightly', '1.0.0', false],
  ])('%s vs %s → %s', (a, b, expected) => expect(isNewer(a, b)).toBe(expected));
});

describe('updatesItself', () => {
  it('store copies and self-hosted Firefox builds update themselves', () => {
    expect(updatesItself({ update_url: 'https://clients2.google.com/service/update2/crx' })).toBe(true);
    expect(updatesItself({ browser_specific_settings: { gecko: { update_url: 'https://x/updates.json' } } })).toBe(true);
    expect(updatesItself({ browser_specific_settings: { gecko: { id: 'ydm@yamantau' } } })).toBe(false);
    expect(updatesItself({})).toBe(false);
  });
});

describe('latestRelease', () => {
  const answer = (body: object, ok = true) =>
    (async () => ({ ok, json: async () => body })) as unknown as typeof fetch;

  it('reports a newer release with its page', async () => {
    const r = await latestRelease(
      'me/ydm',
      '1.0.0',
      answer({ tag_name: 'v1.1.0', html_url: 'https://github.com/me/ydm/releases/tag/v1.1.0' }),
    );
    expect(r).toEqual({ version: '1.1.0', url: 'https://github.com/me/ydm/releases/tag/v1.1.0' });
  });

  it('ignores the same version, drafts, pre-releases and errors', async () => {
    expect(await latestRelease('me/ydm', '1.1.0', answer({ tag_name: 'v1.1.0' }))).toBeNull();
    expect(await latestRelease('me/ydm', '1.0.0', answer({ tag_name: 'v2.0.0', prerelease: true }))).toBeNull();
    expect(await latestRelease('me/ydm', '1.0.0', answer({}, false))).toBeNull();
  });

  it('never links outside the repository', async () => {
    const r = await latestRelease('me/ydm', '1.0.0', answer({ tag_name: 'v1.2.0', html_url: 'https://evil.example/x' }));
    expect(r?.url).toBe('https://github.com/me/ydm/releases/latest');
  });
});
