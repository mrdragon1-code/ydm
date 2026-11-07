# Contributing to YDM

Thank you! Bug reports, fixes and translations are all welcome.

## Reporting a problem

Open an issue with your browser and version, the site (if you can share it), and what the
popup said: when YDM hands a download back to the browser it shows the reason.

## Code

```sh
cd engine && cargo build --release -p ydm-testserver   # once, for the end-to-end tests
cd extension && npm install
npm run check && npm test && npm run e2e && npm run e2e:firefox
```

Keep changes small and tested. The engine has unit tests (`lib/*.test.ts`) and real-browser
tests (`e2e/`); a change in behaviour should come with a test that would have caught it.

## Translating YDM

English is the source: `extension/locales/en.json`. Languages written by people live in
`extension/locales/overrides/<code>.json` (`it.json` is the example). They ship with YDM and
work in every browser.

To add or improve a language:

1. Copy `extension/locales/en.json` to `extension/locales/overrides/<code>.json`, using the
   browser's language code (`de`, `fr`, `pt_BR`, `zh_CN`…).
2. Translate the values, not the keys. Keep every `{placeholder}` exactly as it is; they are
   filled with numbers and names.
3. You may leave out any message: it falls back to English.
4. Run `npm test` in `extension/`: it checks that no placeholder went missing.

Short, plain words are best: buttons are verbs ("Pause", "Resume"), as in the browser's own
menus. `ext.name` and `ext.description` are the store listing's name and summary (at most 75
and 132 characters).

Until a language is here, Chrome users can still have YDM in it: the browser translates it
on the device. A file written by a person always wins over that.
