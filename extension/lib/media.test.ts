import { describe, expect, it } from 'vitest';
import { mediaKind, parsePlaylist, qualityOf, sequenceIv, videoName } from './media';

const BASE = 'https://cdn.example.com/v/abc/master.m3u8';

describe('what a response is', () => {
  it('recognizes playlists, files and stream pieces', () => {
    expect(mediaKind('https://x.example/a/index.m3u8')).toBe('hls');
    expect(mediaKind('https://x.example/play?id=1', 'application/vnd.apple.mpegurl; charset=utf-8')).toBe('hls');
    expect(mediaKind('https://x.example/manifest.mpd')).toBe('dash');
    expect(mediaKind('https://x.example/movie.mp4', 'video/mp4')).toBe('direct');
    expect(mediaKind('https://x.example/movie.webm')).toBe('direct');
    // Pieces of streams, and things that are not video.
    expect(mediaKind('https://x.example/seg12.ts', 'video/mp2t')).toBeNull();
    expect(mediaKind('https://x.example/chunk-5.m4s', 'video/mp4')).toBeNull();
    expect(mediaKind('https://x.example/videoplayback?range=0-1000', 'video/mp4')).toBeNull();
    expect(mediaKind('https://x.example/page.html', 'text/html')).toBeNull();
    expect(mediaKind('not a url')).toBeNull();
  });
});

describe('HLS playlists', () => {
  it('a master playlist lists its qualities, best first, and which have separate audio', () => {
    const p = parsePlaylist(
      [
        '#EXTM3U',
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="en",URI="audio/en.m3u8"',
        '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2"',
        '360/index.m3u8',
        '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,CODECS="avc1.640028",AUDIO="aud"',
        'https://other.example.com/1080/index.m3u8',
      ].join('\n'),
      BASE,
    );
    expect(p).toEqual({
      type: 'master',
      drm: false,
      variants: [
        { url: 'https://other.example.com/1080/index.m3u8', bandwidth: 5000000, height: 1080, codecs: 'avc1.640028', separateAudio: true },
        { url: 'https://cdn.example.com/v/abc/360/index.m3u8', bandwidth: 800000, height: 360, codecs: 'avc1.4d401e,mp4a.40.2', separateAudio: false },
      ],
    });
  });

  it('a media playlist: segments, durations, sequence, AES-128 keys, fMP4 map', () => {
    const p = parsePlaylist(
      [
        '#EXTM3U',
        '#EXT-X-MEDIA-SEQUENCE:7',
        '#EXT-X-MAP:URI="init.mp4"',
        '#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example.com/k1",IV=0x000102030405060708090a0b0c0d0e0f',
        '#EXTINF:4.0,',
        'a.m4s',
        '#EXT-X-KEY:METHOD=NONE',
        '#EXTINF:3.5,',
        'b.m4s',
        '#EXT-X-ENDLIST',
      ].join('\n'),
      'https://cdn.example.com/v/abc/720/index.m3u8',
    );
    if (p.type !== 'media') throw new Error('expected media');
    expect(p.ended).toBe(true);
    expect(p.drm).toBe(false);
    expect(p.duration).toBe(7.5);
    expect(p.map).toEqual({ url: 'https://cdn.example.com/v/abc/720/init.mp4', range: undefined });
    expect(p.segments.map((s) => [s.url.split('/').at(-1), s.sequence, s.key.method])).toEqual([
      ['a.m4s', 7, 'AES-128'],
      ['b.m4s', 8, 'NONE'],
    ]);
    expect([...p.segments[0]!.key.iv!]).toEqual([...Array(16).keys()]);
    expect(p.segments[0]!.key.uri).toBe('https://keys.example.com/k1');
  });

  it('byte ranges inside one file', () => {
    const p = parsePlaylist(['#EXTM3U', '#EXTINF:2,', '#EXT-X-BYTERANGE:1000@0', 'all.ts', '#EXTINF:2,', '#EXT-X-BYTERANGE:500', 'all.ts', '#EXT-X-ENDLIST'].join('\n'), BASE);
    if (p.type !== 'media') throw new Error('expected media');
    expect(p.segments.map((s) => s.range)).toEqual([
      { offset: 0, length: 1000 },
      { offset: 1000, length: 500 },
    ]);
  });

  it('protected streams are recognized, never treated as plain', () => {
    for (const key of [
      '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://abc",KEYFORMAT="com.apple.streamingkeydelivery"',
      '#EXT-X-KEY:METHOD=SAMPLE-AES-CTR,URI="data:text/plain;base64,AAAA",KEYFORMAT="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"',
      '#EXT-X-KEY:METHOD=AES-128,URI="k",KEYFORMAT="com.microsoft.playready"',
    ]) {
      const p = parsePlaylist(['#EXTM3U', key, '#EXTINF:2,', 'a.ts', '#EXT-X-ENDLIST'].join('\n'), BASE);
      expect(p.drm, key).toBe(true);
    }
    const master = parsePlaylist(
      ['#EXTM3U', '#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,URI="skd://x",KEYFORMAT="com.apple.streamingkeydelivery"', '#EXT-X-STREAM-INF:BANDWIDTH=1', 'v.m3u8'].join('\n'),
      BASE,
    );
    expect(master.drm).toBe(true);
  });

  it('live streams are told apart from finished ones', () => {
    const p = parsePlaylist(['#EXTM3U', '#EXTINF:2,', 'a.ts'].join('\n'), BASE);
    expect(p.type === 'media' && p.ended).toBe(false);
  });

  it('not a playlist', () => {
    expect(() => parsePlaylist('<html>', BASE)).toThrow();
  });
});

describe('small helpers', () => {
  it('the default IV is the sequence number, big-endian', () => {
    expect([...sequenceIv(1)]).toEqual([...Array(15).fill(0), 1]);
    expect([...sequenceIv(0x01020304)].slice(12)).toEqual([1, 2, 3, 4]);
  });

  it('quality text and file names', () => {
    expect(qualityOf(1080, 5_000_000)).toBe('1080p · 5.0 Mbit/s');
    expect(qualityOf(0, 0)).toBe('');
    expect(videoName('My "Trip": day 1 / part 2 | YouTube', 'mp4')).toBe('My Trip day 1 part 2 YouTube.mp4');
    expect(videoName('   ', 'mp4')).toBe('video.mp4');
  });
});
