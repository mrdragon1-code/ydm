# Chrome Web Store: privacy practices form

Copy each answer into the matching field of the item's *Privacy practices* tab.

## Single purpose

YDM downloads large files faster by fetching them in several parallel pieces, then saves
them to the Downloads folder through the browser's own download manager.

## Permission justifications

**Host permissions (`<all_urls>`)**
YDM downloads a file from whatever site it is on. It must fetch that file, in parallel byte
ranges, from the file's own site with that site's cookies, exactly as the browser's download
would. It only requests the addresses of files being downloaded.

**downloads**
To take over large downloads the browser starts (cancelling the browser's copy), to save the
finished file to the Downloads folder, and to show it in its folder.

**storage**
To keep the download list, the settings and resume checkpoints across browser restarts.

**unlimitedStorage**
Files are assembled in the extension's private storage before being saved; games and disk
images are often larger than the default quota.

**offscreen**
Chrome's service worker cannot start Web Workers or create blob URLs. Downloads run in Web
Workers inside an offscreen document, which hands the finished file to the browser.

**webRequest**
Used only to notice when a page submits a form (POST). Downloads that result from a form are
left to the browser, since repeating them as a plain request would be wrong. No request is
blocked, modified or recorded.

**declarativeNetRequestWithHostAccess**
Sites that block hotlinking require the Referer the browser would send. A session rule adds
the originating page's Referer only to YDM's own requests and only for the download's site;
it is removed when the download ends.

**contextMenus**
Adds "Download with YDM" on links and "Download all links with YDM" on pages.

**scripting**
When the user asks for "Download all links with YDM", reads the links of that one page so the
user can choose which to download. Nothing runs on pages otherwise.

**notifications**
Tells the user a download has finished, with a button to show the file.

## Remote code

No, YDM does not use remote code. All code is in the package.

## Data usage

YDM does not collect or transmit any user data. Tick none of the data categories, and
certify the three statements (no sale, no unrelated use, no creditworthiness use).
