// The store's small promo tile (440×280) and marquee (1400×560), drawn in
// YDM's own style: malachite, Martian Mono, the segmented bar.
//
//   node scripts/promo.mjs

import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const HERE = path.resolve(import.meta.dirname, '..');
const OUT = path.resolve(HERE, '../store');
const font = readFileSync(
  path.join(HERE, 'node_modules/@fontsource-variable/martian-mono/files/martian-mono-latin-wght-normal.woff2'),
).toString('base64');

const page = (w, h, scale) => `<!doctype html><html><head><style>
@font-face { font-family: M; src: url(data:font/woff2;base64,${font}) format('woff2'); font-weight: 100 800; }
* { margin: 0; box-sizing: border-box; }
body { width: ${w}px; height: ${h}px; background: #0f1512; color: #e4ebe7; font-family: M, monospace;
  display: grid; align-content: center; padding: 0 ${48 * scale}px; gap: ${18 * scale}px; overflow: hidden; }
.mark { display: flex; align-items: center; gap: ${16 * scale}px; font-weight: 650; font-size: ${44 * scale}px; letter-spacing: .22em; }
.mark i { width: ${40 * scale}px; height: ${16 * scale}px; border-radius: 3px;
  background: linear-gradient(90deg,#3cc592 0 28%,transparent 28% 36%,#3cc592 36% 64%,transparent 64% 72%,#3cc592 72%); }
p { font-size: ${15 * scale}px; color: #8c9a93; letter-spacing: .02em; }
.bar { height: ${12 * scale}px; border-radius: 3px; background: #26342c; position: relative; }
.bar b { position: absolute; top: 0; bottom: 0; background: #3cc592; border-radius: 2px; }
.num { display: flex; justify-content: space-between; font-size: ${13 * scale}px; color: #3cc592; }
</style></head><body>
<div class="mark"><i></i>YDM</div>
<p>Faster downloads, in parallel pieces</p>
<div class="bar"><b style="left:0;width:21%"></b><b style="left:25%;width:19%"></b><b style="left:50%;width:22%"></b><b style="left:75%;width:16%"></b></div>
<div class="num"><span>4 connections</span><span>3.4 s vs 12.2 s</span></div>
</body></html>`;

const browser = await chromium.launch({ channel: 'chromium' });
for (const [w, h, scale, name] of [
  [440, 280, 1, 'promo-440x280.png'],
  [1400, 560, 2.2, 'marquee-1400x560.png'],
]) {
  const p = await browser.newPage({ viewport: { width: w, height: h } });
  await p.setContent(page(w, h, scale));
  await p.waitForTimeout(200);
  await p.screenshot({ path: path.join(OUT, name) });
}
await browser.close();
console.log(`promo images in ${OUT}`);
