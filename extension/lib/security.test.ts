import { describe, expect, it } from 'vitest';
import {
  cached,
  checkContent,
  checkName,
  checkUrl,
  decide,
  type Endpoints,
  fromVirusTotal,
  incomplete,
  lookUpHash,
  lookUpUrl,
  MALICIOUS_AT,
  RateGate,
  remember,
  sniff,
  testKey,
  urlId,
} from './security';

const AT: Endpoints = { virusTotal: 'https://vt.test', urlhaus: 'https://uh.test', malwareBazaar: 'https://mb.test' };
const HASH = 'a'.repeat(64);

/** A stand-in for the services: answers by URL, and records what was sent. */
function fake(routes: Record<string, () => Response | Promise<Response>>) {
  const sent: { url: string; init?: RequestInit }[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    sent.push({ url, init });
    for (const [prefix, answer] of Object.entries(routes)) if (url.startsWith(prefix)) return answer();
    return new Response('', { status: 404 });
  }) as typeof fetch;
  return { fetcher, sent };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const vtStats = (stats: object) => json({ data: { attributes: { last_analysis_stats: stats } } });

describe('on the device', () => {
  it('flags addresses that hide or fake the real site', () => {
    expect(checkUrl('https://user:pw@evil.test/a.zip').map((f) => f.reason.key)).toEqual(['security.local.credentials']);
    expect(checkUrl('https://xn--pple-43d.com/app.dmg').map((f) => f.reason.key)).toEqual(['security.local.punycode']);
    expect(checkUrl('http://45.13.2.9/setup.exe').map((f) => f.reason.key)).toEqual(['security.local.ipHost']);
    expect(checkUrl('http://[2001:db8::1]/x').map((f) => f.reason.key)).toEqual(['security.local.ipHost']);
  });

  it('leaves ordinary and local addresses alone', () => {
    for (const url of [
      'https://releases.ubuntu.com/26.04/ubuntu.iso',
      'http://127.0.0.1:8080/file',
      'http://192.168.1.10/share/movie.mkv',
      'not a url',
    ]) {
      expect(checkUrl(url)).toEqual([]);
    }
  });

  it('spots a program hiding behind a second extension', () => {
    const [f] = checkName('Fattura_2026.pdf.exe');
    expect(f).toMatchObject({ level: 'suspicious', reason: { key: 'security.local.doubleExtension', params: { looks: 'pdf', is: 'exe' } } });
    expect(checkName('photo.JPG.scr')).toHaveLength(1);
    for (const ok of ['setup.exe', 'archive.tar.gz', 'report.pdf', 'v1.2.exe', 'movie.mkv']) expect(checkName(ok)).toEqual([]);
  });

  it('reads what a file really is from its first bytes', () => {
    expect(sniff(new Uint8Array([0x4d, 0x5a, 0x90, 0]))).toBe('windows');
    expect(sniff(new Uint8Array([0x7f, 0x45, 0x4c, 0x46]))).toBe('linux');
    expect(sniff(new Uint8Array([0xcf, 0xfa, 0xed, 0xfe]))).toBe('mac');
    expect(sniff(new TextEncoder().encode('#!/bin/sh'))).toBe('script');
    expect(sniff(new TextEncoder().encode('%PDF-1.7'))).toBeNull();
    expect(sniff(new Uint8Array([]))).toBeNull();
  });

  it('flags a program named like a document, not a program named as one', () => {
    const mz = new Uint8Array([0x4d, 0x5a, 0, 0]);
    expect(checkContent('invoice.pdf', mz)).toMatchObject([{ level: 'suspicious', reason: { key: 'security.local.disguised' } }]);
    expect(checkContent('setup.exe', mz)).toEqual([]);
    expect(checkContent('invoice.pdf', new TextEncoder().encode('%PDF-1.7'))).toEqual([]);
  });
});

describe('verdict', () => {
  it('the worst finding decides', () => {
    const s = { level: 'suspicious', reason: { key: 'x' }, source: 'local' } as const;
    const m = { level: 'malicious', reason: { key: 'y' }, source: 'virustotal' } as const;
    expect(decide([], ['local'], false).level).toBe('clean');
    expect(decide([s], ['local'], false).level).toBe('suspicious');
    expect(decide([s, m], ['local', 'virustotal'], true).level).toBe('malicious');
  });

  it('asked online and nobody answered: not verified, rather than clean', () => {
    expect(decide([], ['local'], true).level).toBe('unknown');
    expect(decide([], ['local', 'virustotal'], true).level).toBe('clean');
  });

  it(`a known virus takes ${MALICIOUS_AT} engines; fewer is a warning`, () => {
    expect(fromVirusTotal({ malicious: 3, undetected: 60 }, 'file')).toMatchObject({ level: 'malicious', reason: { params: { count: 3, total: 63 } } });
    expect(fromVirusTotal({ malicious: 1, undetected: 60 }, 'file')?.level).toBe('suspicious');
    expect(fromVirusTotal({ suspicious: 2, harmless: 60 }, 'url')?.level).toBe('suspicious');
    expect(fromVirusTotal({ harmless: 70, undetected: 2 }, 'file')).toBeNull();
  });
});

describe('online lookups', () => {
  it('sends nothing at all without a key', async () => {
    const { fetcher, sent } = fake({});
    expect(await lookUpUrl('https://a.test/x.zip', {}, fetcher, AT)).toEqual({ findings: [], checked: [] });
    expect(await lookUpHash(HASH, {}, fetcher, AT)).toEqual({ findings: [], checked: [] });
    expect(sent).toHaveLength(0);
  });

  it('VirusTotal: the file by its hash, with the key, without cookies', async () => {
    const { fetcher, sent } = fake({ [`${AT.virusTotal}/files/${HASH}`]: () => vtStats({ malicious: 12, undetected: 50 }) });
    const r = await lookUpHash(HASH, { virusTotal: 'k1' }, fetcher, AT);
    expect(r.checked).toEqual(['virustotal']);
    expect(r.findings).toMatchObject([{ level: 'malicious', source: 'virustotal' }]);
    expect(sent[0]!.init).toMatchObject({ headers: { 'x-apikey': 'k1' }, credentials: 'omit', referrerPolicy: 'no-referrer' });
  });

  it('VirusTotal: an address never seen counts as answered, nothing against it', async () => {
    const { fetcher, sent } = fake({});
    const r = await lookUpUrl('https://a.test/x.zip', { virusTotal: 'k' }, fetcher, AT);
    expect(r).toEqual({ findings: [], checked: ['virustotal'] });
    expect(sent[0]!.url).toBe(`${AT.virusTotal}/urls/${urlId('https://a.test/x.zip')}`);
  });

  it('a refused key, a limit or no network: the service did not answer', async () => {
    for (const answer of [() => json({}, 401), () => json({}, 429), () => Promise.reject(new TypeError('offline'))]) {
      const { fetcher } = fake({ [AT.virusTotal]: answer as () => Response });
      expect((await lookUpHash(HASH, { virusTotal: 'k' }, fetcher, AT)).checked).toEqual([]);
    }
  });

  it('URLhaus and MalwareBazaar: known malware is malicious', async () => {
    const { fetcher, sent } = fake({
      [`${AT.urlhaus}/url/`]: () => json({ query_status: 'ok', threat: 'malware_download' }),
      [`${AT.malwareBazaar}/`]: () => json({ query_status: 'ok', data: [{ signature: 'AgentTesla' }] }),
    });
    const u = await lookUpUrl('http://bad.test/a.exe', { abuseCh: 'k2' }, fetcher, AT);
    expect(u.findings).toMatchObject([{ level: 'malicious', source: 'urlhaus' }]);
    const h = await lookUpHash(HASH, { abuseCh: 'k2' }, fetcher, AT);
    expect(h.findings).toMatchObject([{ level: 'malicious', reason: { key: 'security.bazaar.knownNamed', params: { name: 'AgentTesla' } } }]);
    expect(sent[0]!.init).toMatchObject({ method: 'POST', headers: { 'Auth-Key': 'k2' } });
    expect(String(sent[1]!.init?.body)).toBe(`query=get_info&hash=${HASH}`);
  });

  it('abuse.ch: no results is answered and clean; an error is not answered', async () => {
    const clean = fake({ [AT.malwareBazaar]: () => json({ query_status: 'hash_not_found' }) });
    expect(await lookUpHash(HASH, { abuseCh: 'k' }, clean.fetcher, AT)).toEqual({ findings: [], checked: ['malwarebazaar'] });
    const broken = fake({ [AT.malwareBazaar]: () => json({ query_status: 'unknown_auth_key' }) });
    expect((await lookUpHash(HASH, { abuseCh: 'k' }, broken.fetcher, AT)).checked).toEqual([]);
  });

  it('a service too slow to answer: the file is unchecked, the user is asked, nothing cached', async () => {
    // Never answers, but gives up when the request is aborted.
    const hang = (async (_: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
      })) as typeof fetch;
    const found = await lookUpHash(HASH, { virusTotal: 'k'.repeat(32), abuseCh: 'k'.repeat(32) }, hang, AT, 20);
    expect(found.checked).toEqual([]);
    expect(found.findings.map((f) => [f.level, f.reason.key, f.reason.params?.service])).toEqual(
      expect.arrayContaining([
        ['unknown', 'security.timeout', 'VirusTotal'],
        ['unknown', 'security.timeout', 'MalwareBazaar'],
      ]),
    );
    expect(incomplete(found.findings)).toBe(true);
    expect(decide(found.findings, found.checked, true).level).toBe('unknown');
    expect(remember({}, 'k', { findings: found.findings, checked: ['urlhaus'] })).toEqual({});
  });

  it('a service that is down is not a timeout: nobody is asked', async () => {
    const down = (async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof fetch;
    const found = await lookUpUrl('https://x.test/f', { virusTotal: 'k'.repeat(32) }, down, AT, 20);
    expect(found).toEqual({ findings: [], checked: [] });
  });

  it('a key is tested with a hash nobody has', async () => {
    expect(await testKey('virusTotal', 'good', fake({}).fetcher, AT)).toBe(true);
    expect(await testKey('virusTotal', 'bad', fake({ [AT.virusTotal]: () => json({}, 401) }).fetcher, AT)).toBe(false);
    expect(await testKey('abuseCh', 'good', fake({ [AT.malwareBazaar]: () => json({ query_status: 'hash_not_found' }) }).fetcher, AT)).toBe(true);
  });

  it('builds VirusTotal URL ids as base64url without padding', () => {
    expect(urlId('http://www.example.com/')).toBe('aHR0cDovL3d3dy5leGFtcGxlLmNvbS8');
    expect(urlId('https://a.test/?q=ü&x=~')).not.toMatch(/[+/=]/);
  });
});

describe('limits and memory', () => {
  it('waits once four requests were made in a minute', async () => {
    let now = 0;
    const waited: number[] = [];
    const gate = new RateGate(4, () => now, async (ms) => {
      waited.push(ms);
      now += ms;
    });
    for (let i = 0; i < 4; i++) await gate.take();
    expect(waited).toEqual([]);
    now = 10_000;
    await gate.take();
    expect(waited).toEqual([50_000]);
  });

  it('remembers verdicts for a week, but not an answer from nobody', () => {
    const hit = { findings: [], checked: ['virustotal' as const] };
    let cache = remember({}, 'h1', hit, 1000);
    expect(cached(cache, 'h1', 2000)).toEqual(hit);
    expect(cached(cache, 'h1', 1000 + 8 * 24 * 3600 * 1000)).toBeNull();
    cache = remember(cache, 'h2', { findings: [], checked: [] }, 1000);
    expect(cached(cache, 'h2', 2000)).toBeNull();
  });
});
