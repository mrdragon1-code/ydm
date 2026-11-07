// Builds the installable YDM into ../release:
//   chrome/               unpacked folder to load once in Chrome/Edge/Brave (stays installed)
//   ydm-<v>-chrome.zip    for the Chrome Web Store / Edge Add-ons
//   ydm-<v>-firefox.zip   the unsigned Firefox add-on
//   ydm-<v>-sources.zip   human-readable sources, which Mozilla asks for
//   *.xpi                 the Firefox add-on signed by Mozilla: installs for good
//
// Signing needs a free addons.mozilla.org account's API credentials in
// WEB_EXT_API_KEY and WEB_EXT_API_SECRET; without them it is skipped.
// Mozilla signs each version only once: raise "version" in package.json first.
//
//   npm run release

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

const HERE = path.resolve(import.meta.dirname, '..');
const OUT = path.join(HERE, '.output');
const RELEASE = path.resolve(HERE, '../release');
const { version } = JSON.parse(readFileSync(path.join(HERE, 'package.json'), 'utf8'));
const run = (...args) => execFileSync(process.execPath, args, { cwd: HERE, stdio: 'inherit' });
const wxt = path.join(HERE, 'node_modules/wxt/bin/wxt.mjs');

run(wxt, 'zip');
run(wxt, 'zip', '-b', 'firefox');

// The unpacked Chrome folder is replaced; signed .xpi files from earlier
// versions are kept.
rmSync(path.join(RELEASE, 'chrome'), { recursive: true, force: true });
mkdirSync(RELEASE, { recursive: true });
cpSync(path.join(OUT, 'chrome-mv3'), path.join(RELEASE, 'chrome'), { recursive: true });
for (const [from, to] of [
  [`ydm-extension-${version}-chrome.zip`, `ydm-${version}-chrome.zip`],
  [`ydm-extension-${version}-firefox.zip`, `ydm-${version}-firefox.zip`],
  [`ydm-extension-${version}-sources.zip`, `ydm-${version}-sources.zip`],
]) {
  cpSync(path.join(OUT, from), path.join(RELEASE, to));
}

if (process.env.WEB_EXT_API_KEY && process.env.WEB_EXT_API_SECRET) {
  run(
    path.join(HERE, 'node_modules/web-ext/bin/web-ext.js'),
    'sign',
    '--channel', 'unlisted',
    '--source-dir', path.join(OUT, 'firefox-mv2'),
    '--artifacts-dir', RELEASE,
    '--upload-source-code', path.join(RELEASE, `ydm-${version}-sources.zip`),
  );
} else {
  console.log('\nFirefox: not signed (WEB_EXT_API_KEY / WEB_EXT_API_SECRET not set).');
}

console.log(`\nRelease ${version} in ${RELEASE}:`);
for (const f of readdirSync(RELEASE)) console.log(`  ${f}`);
if (!existsSync(path.join(RELEASE, 'chrome', 'manifest.json'))) process.exit(1);
