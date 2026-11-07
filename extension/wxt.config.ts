import { defineConfig } from 'wxt';

export default defineConfig({
  // `npm run dev` does not open a separate browser: load .output/chrome-mv3-dev
  // once in your own Chrome and it reloads itself on every change.
  // (web-ext is installed for the Firefox end-to-end test.)
  webExt: { disabled: true },
  manifest: ({ browser }) => ({
    name: 'YDM',
    description: 'Download più veloci e sicuri, senza fronzoli.',
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
      ...(browser === 'firefox' ? [] : ['offscreen']),
    ],
    // Fetching a download from any site, with that site's cookies.
    host_permissions: ['<all_urls>'],
    ...(browser === 'firefox' && {
      browser_specific_settings: {
        gecko: {
          id: 'ydm@yamantau',
          strict_min_version: '128.0',
          data_collection_permissions: { required: ['none'] },
        },
      },
    }),
  }),
});
