import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'wxt';

const LOCALES = path.resolve(import.meta.dirname, 'locales');

/** The GitHub repository, "owner/name", for links and self-updates. */
const REPO = process.env.YDM_REPO || JSON.parse(readFileSync(path.join(import.meta.dirname, 'package.json'), 'utf8')).ydmRepo;

/**
 * Builds signed for installing from GitHub (not from addons.mozilla.org)
 * update themselves: Firefox checks this file, which each release
 * publishes. AMO builds must not carry it; AMO updates them itself.
 */
const SELF_HOSTED = process.env.YDM_SELF_HOSTED === '1';

/** Test builds only: where a local stand-in for VirusTotal and abuse.ch
 * listens. Release builds leave it empty and always use the real services. */
const SCAN_BASE = process.env.YDM_SCAN_BASE ?? '';
if (SCAN_BASE && !/^http:\/\/127\.0\.0\.1:\d+$/.test(SCAN_BASE)) {
  throw new Error('YDM_SCAN_BASE must be a local test address');
}

/** The extension's name and description in every language, for the
 * browser's own `_locales` (toolbar, extensions page, store listings).
 * Everything else is translated at runtime by lib/i18n.ts. */
function manifestLocales() {
  const read = (file: string) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {});
  const codes = new Set(['en']);
  for (const dir of ['overrides']) {
    const full = path.join(LOCALES, dir);
    if (existsSync(full)) for (const f of readdirSync(full)) if (f.endsWith('.json')) codes.add(f.slice(0, -5));
  }
  const en = read(path.join(LOCALES, 'en.json'));
  return [...codes].map((code) => {
    const layers = [read(path.join(LOCALES, 'overrides', `${code}.json`)), en];
    const pick = (key: 'name' | 'description') => layers.map((l) => l.ext?.[key]).find(Boolean) as string;
    // Chrome caps the name at 75 characters and the description at 132.
    const messages = {
      extName: { message: pick('name').slice(0, 75) },
      extShortName: { message: 'YDM' },
      extDescription: { message: pick('description').slice(0, 132) },
    };
    return { relativeDest: `_locales/${code}/messages.json`, contents: JSON.stringify(messages, null, 2) };
  });
}

/** The OCR engine (Tesseract), shipped inside YDM so that images are read
 * on the device: the worker, the SIMD WebAssembly build, the English model.
 * Copied from the npm packages, not kept in the repository. */
function ocrAssets() {
  const from = (p: string) => path.join(import.meta.dirname, 'node_modules', p);
  return [
    { contents: ocrWorker(from('tesseract.js/dist/worker.min.js')), relativeDest: 'ocr/worker.min.js' },
    { absoluteSrc: from('tesseract.js-core/tesseract-core-simd-lstm.wasm.js'), relativeDest: 'ocr/tesseract-core-simd-lstm.wasm.js' },
    { absoluteSrc: from('@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz'), relativeDest: 'ocr/eng.traineddata.gz' },
  ];
}

/** Tesseract's worker without its two fallbacks for engines that lack
 * `globalThis` (none YDM supports): both build code with the Function
 * constructor, which add-on reviews reject and our policy forbids anyway.
 * Each must be found exactly once; a new tesseract.js that changes them
 * stops the build, to be looked at again. */
function ocrWorker(file: string): string {
  let code = readFileSync(file, 'utf8');
  const fallbacks: [dead: string, live: string][] = [
    ['Function("r","regeneratorRuntime = r")(i)', 'void 0'],
    ['this||new Function("return this")()', 'this'],
  ];
  for (const [dead, live] of fallbacks) {
    if (code.split(dead).length !== 2) throw new Error(`tesseract.js worker changed: "${dead}" not found once`);
    code = code.replace(dead, () => live);
  }
  return code;
}

/** Extension pages may compile WebAssembly (the OCR engine), nothing else. */
const CSP = "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';";

export default defineConfig({
  // The self-updating Firefox build goes elsewhere, not to replace the AMO one.
  outDir: SELF_HOSTED ? '.selfhosted' : '.output',
  vite: () => ({
    resolve: {
      // Not needed by any supported browser (see lib/no-polyfill.ts).
      alias: { 'regenerator-runtime/runtime': path.join(import.meta.dirname, 'lib/no-polyfill.ts') },
    },
    // Seen by the code as import.meta.env.YDM_REPO.
    define: {
      'import.meta.env.YDM_REPO': JSON.stringify(REPO ?? ''),
      'import.meta.env.YDM_SCAN_BASE': JSON.stringify(SCAN_BASE),
    },
  }),
  // `npm run dev` does not open a separate browser: load .output/chrome-mv3-dev
  // once in your own Chrome and it reloads itself on every change.
  // (web-ext is installed for the Firefox end-to-end test.)
  webExt: { disabled: true },
  hooks: {
    'build:publicAssets': (_wxt, files) => {
      files.push(...manifestLocales(), ...ocrAssets());
    },
  },
  manifest: ({ browser }) => ({
    name: '__MSG_extName__',
    short_name: '__MSG_extShortName__',
    description: '__MSG_extDescription__',
    default_locale: 'en',
    ...(REPO && { homepage_url: `https://github.com/${REPO}` }),
    permissions: [
      'downloads',
      'storage',
      // Large files are staged in the extension's own storage before saving.
      'unlimitedStorage',
      'contextMenus',
      // Only to notice form posts, which YDM leaves to the browser.
      'webRequest',
      // Adds the page's Referer to YDM's own requests, as the browser would.
      'declarativeNetRequestWithHostAccess',
      // "Download all links": reads the links of the page you ask it to.
      'scripting',
      // "Download complete", and security warnings.
      'notifications',
      // Looks for a newer version of a copy loaded unpacked, every half hour.
      'alarms',
      ...(browser === 'firefox' ? [] : ['offscreen']),
    ],
    // Fetching a download from any site, with that site's cookies.
    host_permissions: ['<all_urls>'],
    content_security_policy: browser === 'firefox' ? CSP : { extension_pages: CSP },
    ...(browser === 'firefox' && {
      browser_specific_settings: {
        gecko: {
          id: 'ydm@yamantau',
          strict_min_version: '140.0',
          // Online checks (only with the user's own key) send the download's
          // address and the file's hash: asked for when they are turned on.
          data_collection_permissions: { required: ['none'], optional: ['browsingActivity', 'websiteActivity'] },
          ...(SELF_HOSTED &&
            REPO && { update_url: `https://github.com/${REPO}/releases/latest/download/updates.json` }),
        },
        // Desktop only: Firefox for Android has no downloads API to take over.
        gecko_android: { strict_min_version: '142.0' },
      },
    }),
  }),
});
