/**
 * Videos on web pages: recognizing them from the requests a page makes,
 * and reading HLS playlists. Pure functions; the network comes in from
 * outside.
 *
 * Protected streams (DRM: Widevine, FairPlay, PlayReady, SAMPLE-AES) are
 * recognized only to say so: YDM never tries to get around protection.
 */

/** A video seen on a page. */
export interface MediaFound {
  url: string;
  kind: 'direct' | 'hls' | 'dash';
  /** For the list: a name, then what is known of quality and size. */
  title: string;
  /** e.g. "1080p", "720p · 2.4 Mbit/s"; '' when unknown. */
  quality: string;
  /** Bytes, exact for files, estimated for streams; null when unknown. */
  size: number | null;
  /** Protected (DRM): shown, never downloaded. */
  drm: boolean;
  /** A live stream: shown, not downloadable. */
  live?: boolean;
  /** Another reason it cannot be downloaded yet (a `reason.*` key). */
  unsupported?: 'webm' | 'notSupported' | 'notVideo';
  /** The page it was on, sent as the Referer. */
  page?: string;
}

/** What a response is, from its address and Content-Type; null: not a video. */
export function mediaKind(url: string, contentType = ''): MediaFound['kind'] | 'dash' | null {
  const type = contentType.split(';')[0]!.trim().toLowerCase();
  let path = '';
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    return null;
  }
  if (type === 'application/vnd.apple.mpegurl' || type === 'application/x-mpegurl' || type === 'audio/mpegurl' || path.endsWith('.m3u8')) {
    return 'hls';
  }
  if (type === 'application/dash+xml' || path.endsWith('.mpd')) return 'dash';
  // Pieces of a stream are not videos of their own.
  if (type === 'video/mp2t' || /\.(ts|m4s|m4v|m4a|aac)$/.test(path) || /[?&](range|bytestart|sq|segment)=/i.test(url)) return null;
  if (/^video\/(mp4|webm|ogg|quicktime|x-matroska|x-msvideo)$/.test(type)) return 'direct';
  if (!type && /\.(mp4|webm|mkv|mov)$/.test(path)) return 'direct';
  return null;
}

// --- HLS playlists ---------------------------------------------------------

export interface Variant {
  url: string;
  bandwidth: number;
  /** Height in pixels, 0 if not given. */
  height: number;
  codecs: string;
  /** Plays its audio from a separate playlist. */
  separateAudio: boolean;
  /** That playlist: the group's default track, else its first. */
  audio?: string;
}

export interface Key {
  method: 'NONE' | 'AES-128';
  uri?: string;
  /** 16 bytes, or null: the segment's media sequence number is the IV. */
  iv: Uint8Array<ArrayBuffer> | null;
}

export interface Segment {
  url: string;
  duration: number;
  /** Media sequence number, for the default IV. */
  sequence: number;
  key: Key;
  /** "length@offset" sub-range of the URL, if any. */
  range?: { offset: number; length: number };
}

export type Playlist =
  | { type: 'master'; variants: Variant[]; drm: boolean }
  | {
      type: 'media';
      segments: Segment[];
      /** fMP4: the initialization section, played before every segment. */
      map?: { url: string; range?: { offset: number; length: number } };
      /** VOD or finished: false for live streams, which are not supported. */
      ended: boolean;
      drm: boolean;
      duration: number;
    };

/** Attributes of a tag: KEY=value, KEY="quoted, with commas". */
function attributes(line: string): Record<string, string> {
  const out: Record<string, string> = {};
  const body = line.slice(line.indexOf(':') + 1);
  for (const m of body.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)) out[m[1]!] = m[2]!.replace(/^"|"$/g, '');
  return out;
}

function resolve(uri: string, base: string): string {
  return new URL(uri, base).href;
}

function byteRange(value: string, previousEnd: number): { offset: number; length: number } {
  const [length, offset] = value.split('@').map(Number) as [number, number | undefined];
  return { length, offset: offset ?? previousEnd };
}

/** Protection a player needs a licence for: not AES-128 with a plain key. */
function protectedKey(attrs: Record<string, string>): boolean {
  const method = attrs.METHOD ?? 'NONE';
  const format = attrs.KEYFORMAT ?? 'identity';
  return (method !== 'NONE' && method !== 'AES-128') || format !== 'identity';
}

export function parsePlaylist(text: string, base: string): Playlist {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines[0] !== '#EXTM3U') throw new Error('not an HLS playlist');

  if (lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'))) {
    // Each audio group's playlist: the default track, else the first.
    const audioOf = new Map<string, string>();
    for (const a of lines.filter((l) => l.startsWith('#EXT-X-MEDIA') && /TYPE=AUDIO/.test(l)).map(attributes)) {
      if (!a.URI || !a['GROUP-ID']) continue;
      if (!audioOf.has(a['GROUP-ID']) || a.DEFAULT === 'YES') audioOf.set(a['GROUP-ID'], resolve(a.URI, base));
    }
    const variants: Variant[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (!line.startsWith('#EXT-X-STREAM-INF')) continue;
      const a = attributes(line);
      const uri = lines.slice(i + 1).find((l) => !l.startsWith('#'));
      if (!uri) continue;
      variants.push({
        url: resolve(uri, base),
        bandwidth: Number(a.BANDWIDTH ?? a['AVERAGE-BANDWIDTH'] ?? 0),
        height: Number(/x(\d+)$/.exec(a.RESOLUTION ?? '')?.[1] ?? 0),
        codecs: a.CODECS ?? '',
        separateAudio: !!a.AUDIO && audioOf.has(a.AUDIO),
        ...(a.AUDIO && audioOf.has(a.AUDIO) && { audio: audioOf.get(a.AUDIO) }),
      });
    }
    // Session keys in a master playlist announce protection too.
    const drm = lines.filter((l) => l.startsWith('#EXT-X-SESSION-KEY')).some((l) => protectedKey(attributes(l)));
    variants.sort((x, y) => y.height - x.height || y.bandwidth - x.bandwidth);
    return { type: 'master', variants, drm };
  }

  const segments: Segment[] = [];
  let sequence = Number(lines.find((l) => l.startsWith('#EXT-X-MEDIA-SEQUENCE'))?.split(':')[1] ?? 0);
  let key: Key = { method: 'NONE', iv: null };
  let drm = false;
  let map: { url: string; range?: { offset: number; length: number } } | undefined;
  let duration = 0;
  let range: { offset: number; length: number } | undefined;
  let rangeEnd = 0;
  for (const line of lines) {
    if (line.startsWith('#EXT-X-KEY')) {
      const a = attributes(line);
      if (protectedKey(a)) drm = true;
      key =
        a.METHOD === 'AES-128'
          ? { method: 'AES-128', uri: a.URI ? resolve(a.URI, base) : undefined, iv: a.IV ? hexBytes(a.IV) : null }
          : { method: 'NONE', iv: null };
    } else if (line.startsWith('#EXT-X-MAP')) {
      const a = attributes(line);
      if (a.URI) map = { url: resolve(a.URI, base), range: a.BYTERANGE ? byteRange(a.BYTERANGE, 0) : undefined };
    } else if (line.startsWith('#EXTINF')) {
      duration = Number.parseFloat(line.slice(8)) || 0;
    } else if (line.startsWith('#EXT-X-BYTERANGE')) {
      range = byteRange(line.split(':')[1] ?? '', rangeEnd);
    } else if (!line.startsWith('#')) {
      segments.push({ url: resolve(line, base), duration, sequence: sequence++, key, range });
      if (range) rangeEnd = range.offset + range.length;
      range = undefined;
      duration = 0;
    }
  }
  return {
    type: 'media',
    segments,
    map,
    ended: lines.includes('#EXT-X-ENDLIST') || lines.some((l) => l === '#EXT-X-PLAYLIST-TYPE:VOD'),
    drm,
    duration: segments.reduce((n, s) => n + s.duration, 0),
  };
}

function hexBytes(hex: string): Uint8Array<ArrayBuffer> {
  const clean = hex.replace(/^0x/i, '').padStart(32, '0');
  return Uint8Array.from(clean.match(/../g)!.map((b) => Number.parseInt(b, 16)));
}

/** The IV of a segment without one: its sequence number, big-endian. */
export function sequenceIv(sequence: number): Uint8Array<ArrayBuffer> {
  const iv = new Uint8Array(16);
  new DataView(iv.buffer).setUint32(12, sequence >>> 0);
  new DataView(iv.buffer).setUint32(8, Math.floor(sequence / 2 ** 32));
  return iv;
}

/** "1080p" or "2.4 Mbit/s" or both, for the list. */
export function qualityOf(height: number, bandwidth: number): string {
  const rate = bandwidth ? `${(bandwidth / 1e6).toFixed(1)} Mbit/s` : '';
  return [height ? `${height}p` : '', rate].filter(Boolean).join(' · ');
}

/** A file name for a video: the page's title, cleaned, with the extension. */
export function videoName(title: string, ext: string): string {
  const base = title
    .replace(/[\\/:*?"<>|\u0000-\u001f‎‏‪-‮⁦-⁩]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
    .replace(/[. ]+$/, '');
  return `${base || 'video'}.${ext}`;
}
