import type { BrowserContext, Worker } from '@playwright/test';

/**
 * YDM's service worker, once it really listens for downloads.
 *
 * The worker appears before its script has finished running. A download
 * started in between reaches no listener: the browser keeps it, and a test
 * waiting for YDM's copy waits forever. A fixed pause was not enough on a
 * busy machine (CI); this waits for the listener itself.
 */
export async function ydmWorker(context: BrowserContext, timeout = 30_000): Promise<Worker> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout }));
    const listening = await worker
      .evaluate(() => (globalThis as unknown as { chrome: { downloads: { onCreated: { hasListeners(): boolean } } } }).chrome.downloads.onCreated.hasListeners())
      .catch(() => false);
    if (listening) return worker;
    if (Date.now() > deadline) throw new Error('YDM never started listening for downloads');
    await new Promise((r) => setTimeout(r, 50));
  }
}
