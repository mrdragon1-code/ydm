import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'wxt';

const LOCALES = path.resolve(import.meta.dirname, 'locales');

/** The extension's name and description in every language, for the
 * browser's own `_locales` (toolbar, extensions page, store listings).
 * Everything else is translated at runtime by lib/i18n.ts. */
function manifestLocales() {
  const read = (file: string) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {});
  const codes = new Set(['en']);
  for (const dir of ['auto', 'overrides']) {
    const full = path.join(LOCALES, dir);
    if (existsSync(full)) for (const f of readdirSync(full)) if (f.endsWith('.json')) codes.add(f.slice(0, -5));
  }
  const en = read(path.join(LOCALES, 'en.json'));
  return [...codes].map((code) => {
    const layers = [read(path.join(LOCALES, 'overrides', `${code}.json`)), read(path.join(LOCALES, 'auto', `${code}.json`)), en];
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

export default defineConfig({
  // `npm run dev` does not open a separate browser: load .output/chrome-mv3-dev
  // once in your own Chrome and it reloads itself on every change.
  // (web-ext is installed for the Firefox end-to-end test.)
  webExt: { disabled: true },
  hooks: {
    'build:publicAssets': (_wxt, files) => {
      files.push(...manifestLocales());
    },
  },
  manifest: ({ browser }) => ({
    name: '__MSG_extName__',
    short_name: '__MSG_extShortName__',
    description: '__MSG_extDescription__',
    default_locale: 'en',
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
      // "Download complete", with a button to show the file.
      'notifications',
      ...(browser === 'firefox' ? [] : ['offscreen']),
    ],
    // Fetching a download from any site, with that site's cookies.
    host_permissions: ['<all_urls>'],
    ...(browser === 'firefox' && {
      browser_specific_settings: {
        gecko: {
          id: 'ydm@yamantau',
          strict_min_version: '140.0',
          data_collection_permissions: { required: ['none'] },
        },
        // Desktop only: Firefox for Android has no downloads API to take over.
        gecko_android: { strict_min_version: '142.0' },
      },
    }),
  }),
});
