import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fill, isoDuration, parseMpd } from './dash';
import { parseXml } from './xml';

const URL_ = 'https://cdn.example.com/v/42/manifest.mpd';
const mpd = (period: string, attrs = 'type="static" mediaPresentationDuration="PT8S"') =>
  `<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011" ${attrs}><Period>${period}</Period></MPD>`;

describe('XML reader', () => {
  it('elements, attributes, text, entities; namespaces and comments dropped', () => {
    const x = parseXml('<?xml version="1.0"?><!-- hi --><a x="1 &amp; 2"><cenc:pssh>AA&lt;=</cenc:pssh><b/><![CDATA[skip]]></a>');
    expect(x.name).toBe('a');
    expect(x.attrs).toEqual({ x: '1 & 2' });
    expect(x.children.map((c) => [c.name, c.text])).toEqual([
      ['pssh', 'AA<='],
      ['b', ''],
    ]);
  });
});

describe('DASH manifests', () => {
  it('the fixture made by ffmpeg: best video and audio, every segment by timeline', () => {
    const text = readFileSync(path.resolve(import.meta.dirname, '../e2e/fixtures/dash/manifest.mpd'), 'utf8');
    const m = parseMpd(text, 'http://127.0.0.1:1/dash/manifest.mpd');
    if (!m.ok) throw new Error(m.reason);
    expect(m.duration).toBe(8);
    expect(m.video.init?.url).toBe('http://127.0.0.1:1/dash/init-0.m4s');
    expect(m.video.segments.map((s) => s.url.split('/').at(-1))).toEqual(Array.from({ length: 8 }, (_, i) => `chunk-0-${i + 1}.m4s`));
    expect(m.audio?.segments).toHaveLength(8);
    expect(m.audio?.codecs).toBe('mp4a.40.2');
    expect(m.video.height).toBe(90);
  });

  it('$Time$ addressing, inherited template, best quality first', () => {
    const m = parseMpd(
      mpd(`
        <AdaptationSet contentType="video" mimeType="video/mp4">
          <SegmentTemplate timescale="1000" initialization="$RepresentationID$/init.mp4" media="$RepresentationID$/$Time$.m4s">
            <SegmentTimeline><S t="0" d="4000" r="1"/><S d="2000"/></SegmentTimeline>
          </SegmentTemplate>
          <Representation id="v360" bandwidth="800000" height="360" codecs="avc1.4d401e"/>
          <Representation id="v1080" bandwidth="5000000" height="1080" codecs="avc1.640028"/>
        </AdaptationSet>`),
      URL_,
    );
    if (!m.ok) throw new Error(m.reason);
    expect(m.video.height).toBe(1080);
    expect(m.video.init?.url).toBe('https://cdn.example.com/v/42/v1080/init.mp4');
    expect(m.video.segments.map((s) => s.url.split('/').at(-1))).toEqual(['0.m4s', '4000.m4s', '8000.m4s']);
    expect(m.audio).toBeNull();
  });

  it('$Number$ with a fixed duration and padding', () => {
    expect(fill('seg-$Number%05d$-$RepresentationID$$$.m4s', { RepresentationID: 'a', Number: 7, Bandwidth: 1 })).toBe('seg-00007-a$.m4s');
    const m = parseMpd(
      mpd(
        `<AdaptationSet mimeType="video/mp4"><Representation id="1" bandwidth="1" height="720" codecs="hvc1.1.6.L93">
          <SegmentTemplate startNumber="0" timescale="10" duration="25" media="s$Number$.m4s" initialization="i.mp4"/>
        </Representation></AdaptationSet>`,
        'type="static" mediaPresentationDuration="PT10S"',
      ),
      URL_,
    );
    if (!m.ok) throw new Error(m.reason);
    expect(m.video.segments.map((s) => s.url.split('/').at(-1))).toEqual(['s0.m4s', 's1.m4s', 's2.m4s', 's3.m4s']);
  });

  it('SegmentList with byte ranges, and one file per track (Reddit style)', () => {
    const list = parseMpd(
      mpd(`<AdaptationSet mimeType="video/mp4"><Representation id="v" bandwidth="1" codecs="avc1.64001f">
        <BaseURL>video.mp4</BaseURL>
        <SegmentList><Initialization sourceURL="video.mp4" range="0-799"/><SegmentURL media="video.mp4" mediaRange="800-1999"/></SegmentList>
      </Representation></AdaptationSet>`),
      URL_,
    );
    if (!list.ok) throw new Error(list.reason);
    expect(list.video.init).toEqual({ url: 'https://cdn.example.com/v/42/video.mp4', range: { offset: 0, length: 800 } });
    expect(list.video.segments).toEqual([{ url: 'https://cdn.example.com/v/42/video.mp4', range: { offset: 800, length: 1200 } }]);

    const files = parseMpd(
      mpd(`
        <AdaptationSet contentType="video"><Representation mimeType="video/mp4" bandwidth="2" height="720" codecs="avc1.4d401f"><BaseURL>DASH_720.mp4</BaseURL><SegmentBase indexRange="800-900"/></Representation></AdaptationSet>
        <AdaptationSet contentType="audio"><Representation mimeType="audio/mp4" bandwidth="1" codecs="mp4a.40.2"><BaseURL>DASH_AUDIO_128.mp4</BaseURL></Representation></AdaptationSet>`),
      URL_,
    );
    if (!files.ok) throw new Error(files.reason);
    expect(files.video).toMatchObject({ init: null, segments: [{ url: 'https://cdn.example.com/v/42/DASH_720.mp4' }] });
    expect(files.audio?.segments).toEqual([{ url: 'https://cdn.example.com/v/42/DASH_AUDIO_128.mp4' }]);
  });

  it('refused with the reason: DRM, live, several periods, WebM only, not a manifest', () => {
    const rep = '<Representation id="1" bandwidth="1" codecs="avc1.4d401e"><BaseURL>v.mp4</BaseURL></Representation>';
    expect(parseMpd(mpd(`<AdaptationSet mimeType="video/mp4"><ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/>${rep}</AdaptationSet>`), URL_)).toEqual({ ok: false, reason: 'drm' });
    expect(parseMpd(mpd(`<AdaptationSet mimeType="video/mp4">${rep}</AdaptationSet>`, 'type="dynamic"'), URL_)).toEqual({ ok: false, reason: 'live' });
    expect(parseMpd('<MPD type="static"><Period/><Period/></MPD>', URL_)).toEqual({ ok: false, reason: 'multiPeriod' });
    expect(parseMpd(mpd(`<AdaptationSet mimeType="video/webm"><Representation id="1" bandwidth="1" codecs="vp9"><BaseURL>v.webm</BaseURL></Representation></AdaptationSet>`), URL_)).toEqual({ ok: false, reason: 'webm' });
    expect(parseMpd('<html></html>', URL_)).toEqual({ ok: false, reason: 'unreadable' });
  });

  it('ISO durations', () => {
    expect(isoDuration('PT1H2M3.5S')).toBe(3723.5);
    expect(isoDuration('P1DT1S')).toBe(86401);
    expect(isoDuration('nonsense')).toBe(0);
  });
});

describe('broken manifests do not hang or fill memory', () => {
  it('a zero-length timeline entry, a runaway repeat, a huge duration', () => {
    const t = (s: string, dur = 'PT8S') =>
      parseMpd(
        `<MPD type="static" mediaPresentationDuration="${dur}"><Period><AdaptationSet mimeType="video/mp4"><Representation id="1" bandwidth="1" codecs="avc1.4d401e"><SegmentTemplate timescale="1" media="$Number$.m4s">${s}</SegmentTemplate></Representation></AdaptationSet></Period></MPD>`,
        'https://x.example/m.mpd',
      );
    expect(t('<SegmentTimeline><S d="0" r="-1"/></SegmentTimeline>').ok).toBe(false);
    expect(t('<SegmentTimeline><S d="1" r="999999999"/></SegmentTimeline>').ok).toBe(false);
    expect(
      parseMpd(
        '<MPD type="static" mediaPresentationDuration="P9999D"><Period><AdaptationSet mimeType="video/mp4"><Representation id="1" bandwidth="1" codecs="avc1.4d401e"><SegmentTemplate timescale="1000" duration="1" media="$Number$.m4s"/></Representation></AdaptationSet></Period></MPD>',
        'https://x.example/m.mpd',
      ).ok,
    ).toBe(false);
  });

  it('a video whose audio cannot be taken is refused, not saved silent', () => {
    const m = parseMpd(
      `<MPD type="static" mediaPresentationDuration="PT8S"><Period>
        <AdaptationSet mimeType="video/mp4"><Representation id="v" bandwidth="1" codecs="avc1.4d401e"><BaseURL>v.mp4</BaseURL></Representation></AdaptationSet>
        <AdaptationSet mimeType="audio/webm"><Representation id="a" bandwidth="1" codecs="opus"><BaseURL>a.webm</BaseURL></Representation></AdaptationSet>
      </Period></MPD>`,
      'https://x.example/m.mpd',
    );
    expect(m).toEqual({ ok: false, reason: 'webm' });
  });

  it('attributes holding ">" and an unquoted one do not lose the element', () => {
    const x = parseXml('<a><b note="x > y" broken=1 ok="1"/><c/></a>');
    expect(x.children.map((c) => c.name)).toEqual(['b', 'c']);
    expect(x.children[0]!.attrs).toMatchObject({ note: 'x > y', ok: '1' });
  });
});
