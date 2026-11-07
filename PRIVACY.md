# YDM privacy policy

_Last updated: 7 November 2026_

**YDM collects no data and sends nothing to its authors or to anyone else.** There is no
account, no analytics, no telemetry, no advertising and no server run by YDM.

## What stays on your device

- **Your download list and settings**, in the browser's extension storage, so the list
  survives a restart and a download can resume where it stopped.
- **Partly downloaded files**, in the extension's private storage (OPFS), deleted as soon
  as the browser has saved the finished file to your Downloads folder.
- **How many connections a site accepted**, for a week, so YDM does not keep opening more
  than that site allows.
- **YDM's own interface text translated into your language**, if you asked for it. The
  translation is made by your browser's built-in translator on your device.

All of this is removed when you uninstall YDM.

## Network requests

YDM connects only to the address of the file you are downloading (and wherever that site
redirects it), exactly as the browser would. The browser attaches that site's own cookies
and, like the browser, YDM sends the address of the page the download came from as the
Referer (only the site's origin when the file is on another site).

## Permissions, and why

| Permission | Why |
|---|---|
| Access to all sites | To download a file from whatever site it is on, with that site's cookies, as the browser does. |
| `downloads` | To take over large downloads and to save finished files to your Downloads folder. |
| `storage`, `unlimitedStorage` | To keep the list, the settings, and partly downloaded files of any size. |
| `webRequest` | Only to notice when a page submits a form, so YDM leaves those downloads to the browser. |
| `declarativeNetRequestWithHostAccess` | To add the page's Referer to YDM's own requests, only for the download's site. |
| `contextMenus` | For "Download with YDM" and "Download all links with YDM". |
| `scripting` | To read the links of a page, only when you ask for "Download all links". |
| `notifications` | To tell you a download has finished. |
| `offscreen` (Chrome) | To run downloads in a background page, since Chrome's service worker cannot. |

Incognito downloads never go through YDM and never appear in its list.

## Contact

Questions or concerns: open an issue in this repository.
