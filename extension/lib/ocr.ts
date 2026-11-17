/**
 * Text in an image, read on this computer by Tesseract (WebAssembly).
 *
 * Everything it needs ships inside YDM (public/ocr, copied from the npm
 * packages at build time): the engine, its worker and the English model,
 * which is enough for web addresses. No image and no text leaves the
 * device. Runs in an extension page; one engine is kept while the page is
 * open, and reads run one at a time.
 */

import { createWorker, OEM, type Worker } from 'tesseract.js';

/** Pixels read at most: above this an image is scaled down first. A
 * 4K screenshot fits; a 100-megapixel photo would exhaust memory. */
const MAX_PIXELS = 12_000_000;

let engine: Promise<Worker> | null = null;
/** Progress of the read in course (reads are queued, so there is one). */
let onProgress: ((share: number) => void) | null = null;
/** The previous read: the next one starts when it is over. */
let queue: Promise<unknown> = Promise.resolve();

function start(): Promise<Worker> {
  const url = (path: string) => browser.runtime.getURL(path as '/popup.html');
  return createWorker('eng', OEM.LSTM_ONLY, {
    workerPath: url('/ocr/worker.min.js'),
    corePath: url('/ocr/tesseract-core-simd-lstm.wasm.js'),
    langPath: url('/ocr'),
    gzip: true,
    // The model is part of YDM: nothing to cache, nothing to download.
    cacheMethod: 'none',
    // An extension's own script file, not a blob: allowed by its policy.
    workerBlobURL: false,
    logger: (m: { status: string; progress: number }) => {
      if (m.status === 'recognizing text') onProgress?.(m.progress);
    },
  });
}

// The engine holds about 100 MB: freed with the page.
addEventListener('pagehide', () => {
  void engine?.then((w) => w.terminate()).catch(() => {});
  engine = null;
});

/** The text of `image`. `progress` gets 0..1 while it is being read. */
export function readText(image: Blob, progress?: (share: number) => void): Promise<string> {
  const run = queue.then(async () => {
    engine ??= start();
    const worker = await engine.catch((e) => {
      engine = null; // a failed start may work next time
      throw e;
    });
    onProgress = progress ?? null;
    try {
      const { data } = await worker.recognize(await prepared(image));
      return data.text;
    } finally {
      onProgress = null;
    }
  });
  queue = run.catch(() => {});
  return run;
}

/** Small screenshots read far better at twice the size; huge pictures are
 * scaled down to what fits in memory. Others are read as they are. */
async function prepared(image: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(image).catch(() => null);
  if (!bitmap) return image;
  try {
    const pixels = bitmap.width * bitmap.height;
    let scale = Math.max(bitmap.width, bitmap.height) < 1600 ? 2 : 1;
    if (pixels * scale * scale > MAX_PIXELS) scale = Math.sqrt(MAX_PIXELS / pixels);
    if (scale === 1) return image;
    const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return image;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return await canvas.convertToBlob({ type: 'image/png' });
  } finally {
    bitmap.close();
  }
}
