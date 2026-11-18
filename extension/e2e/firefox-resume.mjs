// Resume in a real Firefox: a download is cut off by closing Firefox, then
// Firefox is opened again on the same profile and YDM must fetch only the
// missing part. web-ext installs YDM as a temporary add-on on each start, so
// the profile keeps its storage and internal id across the reinstall, as a
// normally installed add-on would.
//
//   node e2e/firefox-resume.mjs     (after `npm run build:firefox`)

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { savedWatcher } from './saved.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const FIREFOX = process.env.FIREFOX ?? 'C:/Program Files/Mozilla Firefox/firefox.exe';
const SIZE_MB = 24;

const dir = mkdtempSync(path.join(tmpdir(), 'ydm-firefox-dl-'));
const profile = mkdtempSync(path.join(tmpdir(), 'ydm-firefox-profile-'));
// 128 KB/s per connection: about 30 s even with all six connections, so
// Firefox is closed well before the end.
const server = spawn(path.join(ROOT, 'engine/target/release/ydm-testserver.exe'), [
  '--port', '0', '--size', String(SIZE_MB), '--rate', '128', '--filename', 'big.bin', '--log',
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
  // Long enough for at least two checkpoints to be saved (every 3 s, then
  // written to Firefox's storage): Firefox is killed, not closed, and a
  // slow machine may still be writing the latest one.
  await sleep(10_000);
  ff.kill();
  await sleep(3000);
  const before = log.length;
  console.log(`  closed Firefox after ${ranged(log).length} ranged requests`);

  // 2. Open Firefox again: YDM picks the download up on its own.
  ff = firefox(null);
  let seconds = null;
  const saved = savedWatcher(dir, 'big.bin', SIZE_MB * 2 ** 20);
  const t = Date.now();
  for (const deadline = Date.now() + 90_000; Date.now() < deadline; ) {
    await sleep(250);
    if (saved()) {
      seconds = (Date.now() - t) / 1000;
      break;
    }
  }
  ff.kill();

  const after = ranged(log.slice(before));
  const again = after.reduce((n, m) => n + Number(m[2]) - Number(m[1]) + 1, 0);
  // Resumed, not started over: no request after reopening begins at the
  // file's first byte. (How much was kept depends on how fast the machine
  // was before Firefox closed, so it is not a fixed share of the file.)
  const restarted = after.some((m) => m[1] === '0');
  const read = () => readFileSync(path.join(dir, 'big.bin'));
  const sha = seconds === null ? null : createHash('sha256').update(read()).digest('hex');
  if (sha !== null && sha !== expectedSha) {
    // What is wrong, and whether it was only not finished yet.
    const expected = Buffer.from(await (await fetch(`${base}/file`)).arrayBuffer());
    const describe = (got) => {
      let first = -1;
      let wrong = 0;
      for (let i = 0; i < Math.min(got.length, expected.length); i++) {
        if (got[i] !== expected[i]) {
          if (first < 0) first = i;
          wrong++;
        }
      }
      return `size ${got.length}/${expected.length}, ${wrong} bytes differ, first at ${first}`;
    };
    console.log(`  DIAG at detection: ${describe(read())}`);
    await sleep(3000);
    console.log(`  DIAG 3 s later:   ${describe(read())}`);
    console.log(`  DIAG ranges before close: ${ranged(log.slice(0, before)).map((m) => `${m[1]}-${m[2]}`).join(' ')}`);
    console.log(`  DIAG ranges after:        ${after.map((m) => `${m[1]}-${m[2]}`).join(' ')}`);
  }
  const checks = [
    ['file in the download folder after reopening', seconds !== null],
    ['byte-exact', sha === expectedSha],
    ['only the missing part fetched again', again > 0 && again < SIZE_MB * 2 ** 20 && !restarted],
  ];
  for (const [name, passed] of checks) console.log(`  ${passed ? '✓' : '✗'} ${name}`);
  console.log(`  after reopening: ${(again / 2 ** 20).toFixed(1)} MB of ${SIZE_MB} fetched again`);
  ok = checks.every(([, passed]) => passed);
} finally {
  server.kill();
  await sleep(1000);
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
process.exit(ok ? 0 : 1);
