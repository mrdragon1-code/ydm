import { type BrowserContext, chromium, test as base, expect, type Page, type Worker } from '@playwright/test';
import path from 'node:path';
import { ydmWorker } from './ready';

// Links written in an image, read on the device (Tesseract, shipped inside
// YDM) and offered in the same list as "Download all links".

const EXTENSION = path.resolve(import.meta.dirname, '../.output/chrome-mv3');

const test = base.extend<{ context: BrowserContext; worker: Worker; id: string }>({
  context: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
    });
    await use(context);
    await context.close();
  },
  worker: async ({ context }, use) => use(await ydmWorker(context)),
  id: async ({ worker }, use) => use(new URL(worker.url()).host),
});

/** A screenshot-like PNG: dark text on white, as a data: URL. */
async function picture(page: Page, lines: string[]): Promise<string> {
  return page.evaluate((lines) => {
    const canvas = document.createElement('canvas');
    canvas.width = 900;
    canvas.height = 60 + lines.length * 44;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#111';
    ctx.font = '26px Arial, sans-serif';
    lines.forEach((line, i) => ctx.fillText(line, 24, 48 + i * 44));
    return canvas.toDataURL('image/png');
  }, lines);
}

type Ext = typeof globalThis & { chrome: { storage: { local: { set(v: object): Promise<void>; get(k: string): Promise<Record<string, unknown>> } } } };

test('"Find links in this image": read on the device, offered to pick', async ({ context, worker, id }) => {
  test.setTimeout(90_000);
  const page = await context.newPage();
  const src = await picture(page, ['New release, get it here:', 'https://downloads.example.com/app/setup-2.4.1.zip', 'Thanks for testing!']);
  // What the context menu stores before opening the page.
  await worker.evaluate((src) => (globalThis as Ext).chrome.storage.local.set({ 'ocr:menu-0001': { src, page: 'https://example.com/' } }), src);
  await page.goto(`chrome-extension://${id}/app.html#downloads/ocr=menu-0001`);
  await expect(page.locator('#grabTitle')).toHaveText('Links in the image');
  await expect(page.locator('#grabList li')).toHaveCount(1, { timeout: 60_000 });
  await expect(page.locator('#grabList li')).toContainText('https://downloads.example.com/app/setup-2.4.1.zip');
  // The request is used once and gone.
  expect(await worker.evaluate(() => (globalThis as Ext).chrome.storage.local.get('ocr:menu-0001'))).toEqual({});
});

test('only web and inline images are read: never a local file', async ({ context, worker, id }) => {
  await worker.evaluate(() => (globalThis as Ext).chrome.storage.local.set({ 'ocr:file-0001': { src: 'file:///C:/Windows/win.ini' } }));
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/app.html#downloads/ocr=file-0001`);
  await expect(page.locator('#grabMessage')).toHaveText('The image could not be read.');
  await expect(page.locator('#grabList li')).toHaveCount(0);
});

test('a screenshot pasted in "Add URLs" lists its links', async ({ context, id }) => {
  test.setTimeout(90_000);
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/app.html#downloads`);
  const src = await picture(page, ['Mirror 1: https://mirror.example.org/iso/distro-24.04.iso', 'Mirror 2: http://192.168.1.20:8080/distro.iso']);
  await page.locator('#add').click();
  await page.locator('#urls').evaluate(async (field, src) => {
    const blob = await (await fetch(src)).blob();
    const data = new DataTransfer();
    data.items.add(new File([blob], 'shot.png', { type: 'image/png' }));
    field.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, src);
  await expect(page.locator('#grabList li')).toHaveCount(2, { timeout: 60_000 });
  await expect(page.locator('#grabList')).toContainText('https://mirror.example.org/iso/distro-24.04.iso');
  await expect(page.locator('#grabList')).toContainText('http://192.168.1.20:8080/distro.iso');
});

test('a screenshot pasted in the popup opens the downloads page with its links', async ({ context, id }) => {
  test.setTimeout(90_000);
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  const src = await picture(popup, ['Patch: https://cdn.example.com/patches/fix-77.msi']);
  await popup.locator('#add').click();
  const opened = context.waitForEvent('page', { predicate: (p) => p.url().includes('/app.html#downloads/ocr=') });
  await popup.locator('#urls').evaluate(async (field, src) => {
    const blob = await (await fetch(src)).blob();
    const data = new DataTransfer();
    data.items.add(new File([blob], 'shot.png', { type: 'image/png' }));
    field.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, src);
  const page = await opened;
  await expect(page.locator('#grabList li')).toHaveCount(1, { timeout: 60_000 });
  await expect(page.locator('#grabList')).toContainText('https://cdn.example.com/patches/fix-77.msi');
});
