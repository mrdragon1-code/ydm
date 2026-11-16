# Changelog

## 1.1.1

### Fixed
- The YDM logo in the side bar of the downloads and settings page is centred again (the arrow
  sat beside its square).

## 1.1.0

### New
- Security checks before a file reaches the Downloads folder:
  - on the device, always on, nothing sent: double extensions (`invoice.pdf.exe`), programs
    disguised as documents, pictures or videos (by their first bytes), look-alike
    (punycode) and bare-IP addresses, names and passwords hidden in the address;
  - online, only with the user's own free key: VirusTotal (file hash and address) and
    abuse.ch URLhaus / MalwareBazaar. Answers kept for a week; VirusTotal's free limit of
    four requests a minute respected.
- A known virus is deleted and never saved; a suspicious download stops and asks in a
  warning window ("Download anyway" saves the very same file). Small files the browser
  keeps are checked by their address too.
- A shield on every download: checked, suspicious, blocked or not checked.
- One page for Downloads, Security, Settings and About, with its own address per screen
  (`app.html#settings`); the old pages lead there.

- Chrome, Edge, Brave installed with the Windows installer now **update themselves**: a
  scheduled task of the user's own fetches each new release from GitHub (SHA-256 checked) and
  YDM reloads itself with it once no download is running. Firefox already did.
- A security service that does not answer within 15 seconds no longer leaves a download
  waiting forever: YDM says the file could not be checked and asks whether to download it.

### Faster
- Without an online key, a finished file is saved at once: its SHA-256 is computed while the
  browser saves it, not before (the whole file was read twice in a row).

### Fixed
- The SHA-256 shown for a checked file no longer stays at "computing…".
- A download waiting for an answer keeps its file and its progress when the browser restarts,
  so "Download anyway" still works and goes on where it stopped.
- The same finding is no longer listed twice when an address is checked twice.
- Retrying a download checks it again from scratch.

## 1.0.1

First public release, from GitHub.

### Install
- Windows installer `YDM-Setup.exe`: choose Firefox and/or Chrome, no administrator rights.
- Firefox add-on signed by Mozilla, updating itself from GitHub.
- Chrome, Edge, Brave: folder to load unpacked; the popup says when a new version is out.

## 1.0.0

Not released (signed once before the GitHub releases existed).

### Faster
- Adaptive connections: starts with four and adds more while the speed keeps rising, up to six.
- Downloads from one site share the browser's six connections instead of queueing behind each other.
- A site that refuses extra connections is remembered for a week.
- An idle connection helps the piece that will finish last; a crawling connection starts over.
- Network data is written in 1 MB batches.
- Open pages receive only what changed; the list is saved at most once a second.

### New
- Downloads page: history (500 entries), search, filters, details.
- SHA-256 of every finished file, computed while it is saved, with a box to compare it.
- Add URLs by pasting them; download all links of a page, filtered by type.
- Notification when a download finishes.
- English by default, Italian built in; in Chrome any other language is translated on the
  device by the browser's own translator.

### Changed
- Popup redesigned; settings page translated.
- Firefox 140 or later.

## 0.2.0

Pause, resume, retry; speed limit; resume after the browser is closed; programs left to the browser.
