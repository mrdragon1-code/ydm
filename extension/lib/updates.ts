/**
 * Newer versions for copies installed from GitHub.
 *
 * Copies from a store update themselves (the store adds `update_url` to the
 * manifest), and so does a Firefox build signed for GitHub (its own
 * `update_url`). A copy loaded unpacked in Chrome cannot: Chrome only
 * updates from its store. For that one only, YDM looks once a day at the
 * latest GitHub release and the popup offers it. One small request to
 * GitHub's public API; nothing about you is sent.
 */

export const CHECK_EVERY_MS = 24 * 3600 * 1000;

export interface Available {
  version: string;
  url: string;
}

/** Whether this copy can update itself. */
export function updatesItself(manifest: { update_url?: string; browser_specific_settings?: unknown }): boolean {
  const gecko = (manifest.browser_specific_settings as { gecko?: { update_url?: string } } | undefined)?.gecko;
  return Boolean(manifest.update_url || gecko?.update_url);
}

/** `a` newer than `b`, for versions like 1.2.10. */
export function isNewer(a: string, b: string): boolean {
  const pa = a.replace(/^v/, '').split('.').map(Number);
  const pb = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (Number.isNaN(x) || Number.isNaN(y)) return false;
    if (x !== y) return x > y;
  }
  return false;
}

/** The latest release of `repo` ("owner/name"), if newer than `current`. */
export async function latestRelease(repo: string, current: string, fetcher: typeof fetch = fetch): Promise<Available | null> {
  const res = await fetcher(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json' },
    credentials: 'omit',
    cache: 'no-store',
  });
  if (!res.ok) return null;
  const release = (await res.json()) as { tag_name?: string; html_url?: string; draft?: boolean; prerelease?: boolean };
  if (!release.tag_name || release.draft || release.prerelease) return null;
  // Only links to the repository's own releases are ever shown.
  const url = release.html_url?.startsWith(`https://github.com/${repo}/releases/`)
    ? release.html_url
    : `https://github.com/${repo}/releases/latest`;
  return isNewer(release.tag_name, current) ? { version: release.tag_name.replace(/^v/, ''), url } : null;
}
