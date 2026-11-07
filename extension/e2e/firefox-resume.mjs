// Resume in a real Firefox: a download is cut off by closing Firefox, then
// Firefox is opened again on the same profile and YDM must fetch only the
// missing part. web-ext installs YDM as a temporary add-on on each start, so
// the profile keeps its storage and internal id across the reinstall, as a
// normally installed add-on would.
//
//   node e2e/firefox-resume.mjs     (after `npm run build:firefox`)

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const FIREFOX = process.env.FIREFOX ?? 'C:/Program Files/Mozilla Firefox/firefox.exe';
const SIZE_MB = 24;

const dir = mkdtempSync(path.join(tmpdir(), 'ydm-firefox-dl-'));
const profile = mkdtempSync(path.join(tmpdir(), 'ydm-firefox-profile-'));
// 512 KB/s per connection: about 12 s with four connections.
const server = spawn(path.join(ROOT, 'engine/target/release/ydm-testserver.exe'), [
  '--port', '0', '--size', String(SIZE_MB), '--rate', '512', '--filename', 'big.bin', '--log',
]);
let log = '';
server.stdout.on('data', (c) => (log += c));
const base = await new Promise((resolve) => {
  server.stdout.on('data', () => {
    const url = /serving \d+ MB at (http:\/\/[^/]+)/.exec(log)?.[1];
    if (url && /sha256/.test(log)) resolve(url);
  });
});
const expectedSha = /sha256 (\w+)/.exec(log)[1];

const prefs = {
  'browser.download.dir': dir.replaceAll('\\', '\\\\'),
  'browser.download.folderList': 2,
  'browser.download.useDownloadDir': true,
  'browser.download.always_ask_before_handling_new_types': false,
  // Same storage and same internal address after web-ext reinstalls YDM.
  'extensions.webextensions.keepStorageOnUninstall': true,
  'extensions.webextensions.keepUuidOnUninstall': true,
};
const firefox = (startUrl) =>
  spawn(
    process.execPath,
    [
      path.join(ROOT, 'extension/node_modules/web-ext/bin/web-ext.js'), 'run',
      '--source-dir', path.join(ROOT, 'extension/.output/firefox-mv2'),
      '--firefox', FIREFOX, '--arg=-headless', '--no-reload',
      '--firefox-profile', profile, '--keep-profile-changes', '--profile-create-if-missing',
      ...(startUrl ? ['--start-url', startUrl] : []),
      ...Object.entries(prefs).flatMap(([k, v]) => ['--pref', `${k}=${v}`]),
    ],
    { stdio: 'ignore' },
  );

const ranged = (text) =>
  text
    .split('\n')
    .map((l) => /^GET \/file range=bytes=(\d+)-(\d+) /.exec(l))
    .filter((m) => m && !(m[1] === '0' && m[2] === '0'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ok = false;
try {
  // 1. Start the download, let it run past a checkpoint, then close Firefox.
  let ff = firefox(`${base}/page?auto`);
  for (const deadline = Date.now() + 60_000; ranged(log).length === 0 && Date.now() < deadline; ) await sleep(250);
  if (ranged(log).length === 0) throw new Error('YDM did not start the download');
  await sleep(6000);
  ff.kill();
  await sleep(3000);
  const before = log.length;
  console.log(`  closed Firefox after ${ranged(log).length} ranged requests`);

  // 2. Open Firefox again: YDM picks the download up on its own.
  ff = firefox(null);
  let seconds = null;
  const t = Date.now();
  for (const deadline = Date.now() + 90_000; Date.now() < deadline; ) {
    await sleep(250);
    if (existsSync(path.join(dir, 'big.bin')) && !readdirSync(dir).some((f) => f.endsWith('.part'))) {
      seconds = (Date.now() - t) / 1000;
      break;
    }
  }
  ff.kill();

  const again = ranged(log.slice(before)).reduce((n, m) => n + Number(m[2]) - Number(m[1]) + 1, 0);
  const sha = seconds === null ? null : createHash('sha256').update(readFileSync(path.join(dir, 'big.bin'))).digest('hex');
  const checks = [
    ['file in the download folder after reopening', seconds !== null],
    ['byte-exact', sha === expectedSha],
    ['only the missing part fetched again', again > 0 && again < SIZE_MB * 2 ** 20 * 0.8],
  ];
  for (const [name, passed] of checks) console.log(`  ${passed ? '✓' : '✗'} ${name}`);
  console.log(`  after reopening: ${(again / 2 ** 20).toFixed(1)} MB of ${SIZE_MB} fetched again`);
  ok = checks.every(([, passed]) => passed);
} finally {
  server.kill();
  await sleep(1000);
  rmSync(dir, { recursive: true, force: true });
  rmSync(profile, { recursive: true, force: true });
}
process.exit(ok ? 0 : 1);
