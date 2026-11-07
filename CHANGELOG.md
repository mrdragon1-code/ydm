# Changelog

## 1.0.0

First public release.

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
