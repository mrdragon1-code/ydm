# Publishing YDM

Once each store is set up, a release is just: raise `version` in `extension/package.json`
and push to `main`. When CI passes, the *Release* workflow tags the commit, publishes the
GitHub release and submits to every store whose secrets are set. Pushing without a new
version releases nothing.

## Automatic updates, for everyone

| Installed from | Updates |
|---|---|
| Chrome Web Store / Edge Add-ons | the store, automatically |
| addons.mozilla.org | AMO, automatically |
| GitHub, Firefox (`.xpi`) | Firefox itself, from this repository's `updates.json` — only with `FIREFOX_DISTRIBUTION=github` |
| GitHub, Chrome (unpacked) | Chrome cannot; the popup shows "YDM x.y is available" with a link |

Firefox can be updated by AMO **or** from GitHub, not both: AMO signs each version only once.
The repository variable `FIREFOX_DISTRIBUTION` (*Settings → Secrets and variables → Actions →
Variables*) picks one: `amo` (default, recommended once listed) or `github`.

## Dependencies

Dependabot proposes updates every week; minor and patch ones merge themselves once CI
passes. Turn on *Settings → General → Allow auto-merge*, and protect `main` requiring the
*CI / test* check (*Settings → Branches*), so nothing merges untested.

Never paste keys or tokens into an issue, a commit or a chat: only into GitHub's
**Settings → Secrets and variables → Actions**.

## 1. GitHub

1. Create an empty public repository (no README, no license: they are here already).
2. In this folder:
   ```sh
   git remote add origin https://github.com/<you>/ydm.git
   git push -u origin main
   ```
3. Replace `<you>` with your user name where it appears: `extension/package.json`
   (`homepage`, `repository`) and the support URL in the store listings below.
4. Check that the *CI* workflow goes green.

The privacy policy URL for the stores is then
`https://github.com/<you>/ydm/blob/main/PRIVACY.md`.

## 2. Chrome Web Store

1. Register at the [Chrome Web Store developer dashboard](https://chrome.google.com/webstore/devconsole)
   (one-off fee of 5 USD). Note the **publisher ID** shown in the account settings.
2. Build the zip: in `extension/`, `npx wxt zip` → `.output/ydm-extension-<v>-chrome.zip`.
3. **First upload by hand**: *New item* → upload the zip. The item ID exists only from now on.
4. Fill in the listing:
   - **Description**: `store/listing/en.md` (and `it.md` for Italian).
   - **Category**: Tools. **Language**: English.
   - **Screenshots** (1280×800): `node scripts/screenshots.mjs` in `extension/`, then
     `--lang it` for Italian ones. They land in `store/screenshots/`.
   - **Small promo tile** (440×280): `store/promo-440x280.png`.
   - **Privacy**: single purpose and each permission's justification from
     `store/permissions.md`; "does not collect user data"; privacy policy URL as above.
5. Submit for review. With access to all sites, expect a thorough review (days, sometimes
   longer); the clear justifications are what it looks at.
6. For automatic releases, create OAuth credentials (Google Cloud console → APIs & Services →
   enable *Chrome Web Store API* → OAuth client ID, type *Desktop*), get a refresh token, then
   add these repository secrets: `CHROME_EXTENSION_ID`, `CHROME_PUBLISHER_ID`,
   `CHROME_CLIENT_ID`, `CHROME_CLIENT_SECRET`, `CHROME_REFRESH_TOKEN`.
   `npx publish-browser-extension init` walks through it interactively.

## 3. Firefox Add-ons (AMO)

YDM's add-on ID is `ydm@yamantau` and it has been signed before as *unlisted*.

1. On [addons.mozilla.org](https://addons.mozilla.org/developers/) open the add-on and choose
   to make it **listed** (public), or submit a new version as *On this site*.
2. Listing: the same texts as for Chrome; category *Download Management*; support site and
   privacy policy as above. Mozilla receives the human-readable sources automatically
   (`ydm-extension-<v>-sources.zip`), which it requires for bundled code.
3. For automatic releases, create API keys at
   [Developer Hub → API keys](https://addons.mozilla.org/developers/addon/api/key/) and add the
   secrets `FIREFOX_EXTENSION_ID` (`ydm@yamantau`), `FIREFOX_JWT_ISSUER`, `FIREFOX_JWT_SECRET`.

## 4. Microsoft Edge Add-ons (optional, free)

1. Register at [Partner Center](https://partner.microsoft.com/dashboard/microsoftedge/) and
   submit the same Chrome zip by hand the first time.
2. For automatic releases: *Publish API* → create credentials, then the secrets
   `EDGE_PRODUCT_ID`, `EDGE_CLIENT_ID`, `EDGE_API_KEY`.

## Checking the secrets

*Actions → Release → Run workflow* with "dry run" ticked checks every store's credentials
without submitting anything.
