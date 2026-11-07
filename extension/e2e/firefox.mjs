// End-to-end check in a real Firefox: Playwright cannot load extensions in
// Firefox, so this drives it with web-ext (temporary profile, headless).
//
// Two sites, each serving 24 MB at 2 MB/s per connection: one requires a
// login cookie, one blocks hotlinking (checks the Referer). Each passes when
// the file lands in the download folder byte-exact, YDM fetched it in
// parallel ranges, and faster than one connection could.
//
//   npm run e2e:firefox          (FIREFOX=path\to\firefox.exe to override)
//   YDM_FIREFOX_BUILD=firefox-mv2-dev node e2e/firefox.mjs   (the `npm run dev:firefox` build)

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '../..');
const FIREFOX = process.env.FIREFOX ?? 'C:/Program Files/Mozilla Firefox/firefox.exe';
const SIZE_MB = 24;
const RATE_MB = 2;

const SCENARIOS = [
  // /start waits, then logs in (sets the cookie) and opens the file.
  { name: 'site with login cookie', args: ['--require-cookie', 'sid=42'], start: '/start', mustHaveCookie: true },
  // /page?auto clicks a link to the file after a few seconds: sends the Referer.
  { name: 'site with hotlink protection', args: ['--require-referer', 'http://127.0.0.1'], start: '/page?auto', mustHaveCookie: false },
];

let ok = true;
for (const scenario of SCENARIOS) {
  console.log(`— ${scenario.name}`);
  ok = (await run(scenario)) && ok;
}
process.exit(ok ? 0 : 1);

async function run(scenario) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ydm-firefox-'));
  const server = spawn(path.join(ROOT, 'engine/target/release/ydm-testserver.exe'), [
    '--port', '0', '--size', String(SIZE_MB), '--rate', String(RATE_MB * 1024),
    '--filename', 'big.bin', '--log', ...scenario.args,
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
    // user.js is parsed like JS: backslashes must be escaped.
    'browser.download.dir': dir.replaceAll('\\', '\\\\'),
    'browser.download.folderList': 2,
    'browser.download.useDownloadDir': true,
    'browser.download.always_ask_before_handling_new_types': false,
  };
  const firefox = spawn(
    process.execPath,
    [
      path.join(ROOT, 'extension/node_modules/web-ext/bin/web-ext.js'), 'run',
      '--source-dir', path.join(ROOT, 'extension/.output', process.env.YDM_FIREFOX_BUILD ?? 'firefox-mv2'),
      '--firefox', FIREFOX, '--arg=-headless', '--no-reload',
      // The start page waits a few seconds, so the extension is installed first.
      '--start-url', `${base}${scenario.start}`,
      ...Object.entries(prefs).flatMap(([k, v]) => ['--pref', `${k}=${v}`]),
    ],
    { stdio: 'ignore' },
  );

  let seconds = null;
  let firstRequest = 0;
  for (const deadline = Date.now() + 60_000; Date.now() < deadline; ) {
    await new Promise((r) => setTimeout(r, 250));
    firstRequest ||= /GET \/file/.test(log) ? Date.now() : 0;
    if (existsSync(path.join(dir, 'big.bin')) && !readdirSync(dir).some((f) => f.endsWith('.part'))) {
      seconds = (Date.now() - firstRequest) / 1000;
      break;
    }
  }
  firefox.kill();
  server.kill();

  const ranged = log
    .split('\n')
    .filter((l) => /^GET \/file range=bytes=\d+-\d+ /.test(l) && !/=0-0 /.test(l))
    .filter((l) => !scenario.mustHaveCookie || l.endsWith('cookie=yes'));
  const file = path.join(dir, 'big.bin');
  const sha = seconds === null ? null : createHash('sha256').update(readFileSync(file)).digest('hex');
  let zone = '';
  try {
    zone = readFileSync(`${file}:Zone.Identifier`, 'utf8');
  } catch {}
  const checks = [
    ['file in the download folder', seconds !== null],
    ['byte-exact', sha === expectedSha],
    ['Mark-of-the-Web (ZoneId=3)', /ZoneId=3/.test(zone)],
    ['parallel ranges through YDM', ranged.length >= 2],
    [`faster than one connection (${SIZE_MB / RATE_MB} s)`, seconds !== null && seconds < (SIZE_MB / RATE_MB) * 0.6],
  ];
  rmSync(dir, { recursive: true, force: true });

  for (const [name, passed] of checks) console.log(`  ${passed ? '✓' : '✗'} ${name}`);
  console.log(
    seconds === null
      ? '  no file after 60 s'
      : `  ${SIZE_MB} MB in ${seconds.toFixed(1)} s with ${ranged.length} ranged requests`,
  );
  return checks.every(([, passed]) => passed);
}
