# Building YDM from these sources

For add-on reviewers. The build is reproducible on Windows, macOS or Linux.

Requirements: Node.js 22 and npm 10.

```sh
npm ci
npm run build:firefox
```

The add-on is then in `.output/firefox-mv2/`, identical to the submitted package.
(`npm run build` builds the Chrome version into `.output/chrome-mv3/`.)

- Bundler: [WXT](https://wxt.dev) 0.21 (Vite). No obfuscation; minification only.
- No remote code: every script is in the package. The only bundled third-party asset is the
  Martian Mono font (`@fontsource-variable/martian-mono`, SIL Open Font License).
- Translations: `locales/en.json` (source) and `locales/overrides/*.json`. Other languages
  are produced at runtime by the browser's own on-device Translator API where it exists
  (not in Firefox); no network service is used.
- Source repository and tests: see `homepage` in `package.json`.
