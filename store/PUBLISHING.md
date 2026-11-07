# Publishing YDM

YDM is distributed from **GitHub releases only**: https://github.com/mrdragon1-code/ydm/releases

A release is just: raise `version` in `extension/package.json` and merge to `main`. When CI
passes, the *Release* workflow tags the commit and publishes a release with:

| File | For |
|---|---|
| `YDM-Setup-<v>.exe` | Windows installer: the user ticks Firefox and/or Chrome |
| `ydm-<v>-firefox.xpi` | Firefox, signed by Mozilla; updates itself |
| `ydm-<v>-chrome.zip` | Chrome, Edge, Brave: unzip and *Load unpacked* |
| `ydm-<v>-sources.zip` | the sources Mozilla reviews when signing |
| `updates.json` | what installed Firefox copies check for updates |

Merging without a new version releases nothing.

Never paste keys or tokens into an issue, a commit or a chat: only into GitHub's
**Settings → Secrets and variables → Actions**.

## One-time setup: signing for Firefox

Firefox only installs add-ons signed by Mozilla. Signing is free and does not publish YDM on
addons.mozilla.org ("unlisted"). Without it, releases have no Firefox add-on and the
installer offers Chrome only.

1. Sign in at https://addons.mozilla.org/developers/ (a Firefox account, free).
2. Open https://addons.mozilla.org/developers/addon/api/key/ and generate credentials:
   a **JWT issuer** (looks like `user:12345:67`) and a **JWT secret**.
3. In https://github.com/mrdragon1-code/ydm/settings/secrets/actions add two repository
   secrets: `FIREFOX_JWT_ISSUER` and `FIREFOX_JWT_SECRET`.

YDM's add-on ID is `ydm@yamantau`; Mozilla signs each version only once, so every release
needs a new version number.

## Updates

| Installed | Updates |
|---|---|
| Firefox (installer or `.xpi`) | by itself: Firefox checks `updates.json` in the latest release |
| Chrome/Edge/Brave (installer or `.zip`) | Chrome cannot update an unpacked copy; YDM's popup shows "YDM x.y is available" with a link to the new release, to install over the old folder |

## Dependencies

Dependabot proposes updates every week; minor and patch ones merge themselves once CI
passes. `main` is protected: the *test* check must pass, no force pushes.

## Building the installer locally

Install [Inno Setup 6](https://jrsoftware.org/isinfo.php) (`winget install JRSoftware.InnoSetup`),
build the extension, put `payload\chrome\` (the unpacked Chrome build) and optionally
`payload\ydm-firefox.xpi` next to `installer\ydm.iss`, then:

```bat
ISCC.exe /DVersion=1.0.0 installer\ydm.iss              rem with Firefox
ISCC.exe /DVersion=1.0.0 /DNoFirefox installer\ydm.iss  rem Chrome only
```

Silent install, for scripts: `YDM-Setup-1.0.0.exe /VERYSILENT /BROWSERS=firefox,chrome`.
