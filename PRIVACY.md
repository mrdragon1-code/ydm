# YDM privacy policy

_Last updated: 16 November 2026_

**YDM collects no data and sends nothing to its authors.** There is no account, no
analytics, no telemetry, no advertising and no server run by YDM. Nothing about your
downloads leaves your device unless you enter your own key for an online malware check
(see below).

## What stays on your device

- **Your download list and settings**, in the browser's extension storage, so the list
  survives a restart and a download can resume where it stopped.
- **Partly downloaded files**, in the extension's private storage (OPFS), deleted as soon
  as the browser has saved the finished file to your Downloads folder.
- **How many connections a site accepted**, for a week, so YDM does not keep opening more
  than that site allows.
- **Security checks on the device**: the download's address, the file's name and its first
  64 bytes are examined locally to spot disguised programs. Nothing is sent.
- **The answers of online malware checks**, for a week, if you turned them on, so the same
  file or address is not asked about twice.
- **Your VirusTotal and abuse.ch API keys**, if you entered them. They are stored only in
  the browser's extension storage and are never shown again by YDM's pages.
- **YDM's own interface text translated into your language**, if you asked for it. The
  translation is made by your browser's built-in translator on your device.

All of this is removed when you uninstall YDM.

## Network requests

YDM connects only to the address of the file you are downloading (and wherever that site
redirects it), exactly as the browser would. The browser attaches that site's own cookies
and, like the browser, YDM sends the address of the page the download came from as the
Referer (only the site's origin when the file is on another site).

### Online malware checks (off unless you enter a key)

YDM ships no key. Only if you paste **your own** free API key in the Security screen, YDM
asks that service about each download it checks:

- **VirusTotal** (Google): the download's address and the finished file's **SHA-256**.
- **abuse.ch** (URLhaus, MalwareBazaar): the download's address and the file's SHA-256.

The file itself is never uploaded. The requests carry no cookies and no Referer, and go
directly from your browser to the service, under that service's own privacy policy and
terms (their free tiers are for personal, non-commercial use). Remove the key and these
requests stop at once.

### Updates

Firefox checks this repository for a newer YDM, as it does for every add-on that is
not from addons.mozilla.org. A copy loaded unpacked in Chrome, which Chrome cannot update,
asks GitHub's public API once a day for the latest YDM version number, to offer the
update. If you installed it with the Windows installer, a scheduled task of your own also asks
GitHub every 3 hours for the latest release and downloads it from there. No information about
you or your downloads is sent.

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
| `alarms` | To look every half hour for a newer YDM installed in its folder, and load it. |
| `notifications` | To tell you a download has finished, or that one was stopped by a security check. |
| `offscreen` (Chrome) | To run downloads in a background page, since Chrome's service worker cannot. |

Incognito downloads never go through YDM and never appear in its list.

## Contact

Questions or concerns: open an issue in this repository.
