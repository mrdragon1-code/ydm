# YDM — Yamantau Download Manager

Faster, safer downloads, right inside your browser. Install it like any
extension and it just works: no program to install, no extra windows.

**[Leggi in italiano](README.it.md)** · [Privacy](PRIVACY.md) · [Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md)

```
Browser
 ├─ background       takes over downloads, queue, per-host connection budget, badge, menus
 ├─ engine           offscreen document (Chrome/Edge/Brave) · background page (Firefox)
 │    ├─ one Web Worker per download
 │    │    ├─ parallel Range requests, adaptive connection count, work stealing
 │    │    └─ batched positional writes to OPFS (on disk, not in RAM)
 │    └─ one worker computing SHA-256 while the file is saved
 └─ at the end the browser saves the file to Downloads, like one of its own
```

## What it does

- **Takes over large downloads** (5 MB and up, http/https) and fetches them in parallel
  pieces. Everything else stays with the browser: small files, unknown sizes, incognito,
  results of a form POST (YDM would repeat them as a GET).
- **Adaptive connections**: starts with four, adds more only while the speed keeps rising,
  backs off for good on a server that refuses them (remembered per site for a week).
- **Shares the browser's limit**: browsers open at most six connections to one site. YDM
  divides those six among its downloads from that site instead of queueing behind itself,
  and gives a finished download's share to the others.
- **No straggler at the end**: an idle connection helps the piece that will finish last,
  and a connection crawling far behind the others starts over.
- **Never loses a download**: if a site refuses YDM, the download goes back to the
  browser and the popup says why ("the site does not accept external downloads (403)").
- **Resumes after the browser is closed**, fetching only the missing pieces, and only if
  the server still has the very same file (same ETag or date, same size).
- **Downloads page**: history, search, filters, details, the **SHA-256** of each file with
  a box to compare it with the one the site publishes.
- **Add URLs** (paste one or many) and **download all links of a page**, filtered by type.
- **Notification** when a download finishes, with a button to show the file.
- **Settings**: on/off, minimum size, maximum connections (1–6), simultaneous downloads,
  speed limit, excluded sites, and **"Leave programs to the browser"** (on by default),
  so Safe Browsing also checks the site `.exe`, `.msi` and similar files come from.
- **Your language**: English and Italian are built in. In Chrome, any other language is
  translated **on your device by the browser's own translator** (no server, no account):
  YDM offers it once, and keeps the result.

## How it downloads

1. **First request** — `GET` with `Range: bytes=0-`: its headers give the size, range
   support, ETag and name, and its body becomes the first piece. No separate probe.
2. **Pieces** — four connections to start, more while they pay off, within the site's
   share of the browser's six.
3. **Refused connections** — after two failures in a row a connection retires and leaves
   its piece to the others; the download fails only if all of them fail.
4. **Writing** — network chunks are gathered into 1 MB writes at their exact place in the
   OPFS file: memory use does not depend on the file size.
5. **Saving** — the browser copies the file to Downloads, picking the final name and
   applying Mark-of-the-Web and Safe Browsing as for any download.

Security: the browser adds cookies per site, as for its own downloads (no cookie can
reach another site); `If-Range` prevents mixing two versions of a file; server-supplied
names are cleaned (folders, reserved Windows names, bidi characters that hide the
extension) and shown as text only; incognito downloads never go through YDM.

### Limits worth knowing

The extra speed comes from servers that limit bandwidth **per connection**. With HTTP/2
servers (many CDNs) the browser carries all parallel requests over one connection and an
extension cannot change that: there YDM is as fast as the browser, not slower. The file
is also written twice (OPFS, then Downloads): on very large files the final copy takes a
few extra seconds.

Mark-of-the-Web is applied (`ZoneId=3`), but in Chrome the recorded origin is the
extension (`HostUrl=chrome-extension://…`), because the browser saves a blob and the API
cannot name the source. For that reason the Safe Browsing check on the site's address may
not run for files YDM saves; hence the "Leave programs to the browser" setting.

### Measurements (end-to-end tests)

24 MB from a site limited to 2 MB/s per connection, behind a login, byte-identical file:

| | browser alone | YDM |
|---|---|---|
| Chromium | 12.2 s | 3.4 s |
| Firefox | 12.7 s | 3.1 s |

## Install

- **Chrome, Edge, Brave**: from the Chrome Web Store / Edge Add-ons (links once published),
  or from a [release](https://github.com/mrdragon1-code/ydm/releases): unzip `ydm-*-chrome.zip`, open `chrome://extensions`,
  enable developer mode, *Load unpacked*.
- **Firefox** (140 or later): from addons.mozilla.org (link once published).

## Development (`extension/`)

```sh
npm install
npm run dev            # load .output/chrome-mv3-dev once in Chrome; it reloads on every change
npm run dev:firefox    # same for Firefox: .output/firefox-mv2-dev via about:debugging
npm test               # unit tests (vitest)
npm run e2e            # build + tests in a real Chromium (Playwright)
npm run e2e:firefox    # build + tests in a real Firefox (web-ext): download, resume after restart
npm run check          # type check
npm run build          # .output/chrome-mv3   ·   npm run build:firefox
node scripts/screenshots.mjs   # store screenshots from real downloads
```

The end-to-end tests use the Rust test server in `engine/crates/ydm-testserver`
(ranges, per-connection limits, required cookie or Referer, refused ranges, connection
caps). Build it once with `cargo build --release -p ydm-testserver` inside `engine/`.

Firefox keeps Manifest V2 with a persistent background page on purpose: an MV3 event
page would be stopped in the middle of a download.

## Releasing

Raise `version` in `extension/package.json` and push to `main`. When CI passes, the *Release*
workflow tags the commit, attaches the zips to a GitHub release and submits them to every
store whose secrets are set; installed copies then update themselves (see
[store/PUBLISHING.md](store/PUBLISHING.md)). Dependabot keeps dependencies current; minor
updates merge themselves when CI passes.

## License

[MIT](LICENSE)
