/**
 * DASH manifests (MPD): which video and audio to take, and the address of
 * every segment. Video and audio come as separate fragmented MP4 tracks,
 * joined into one file by lib/fmp4.ts.
 *
 * Supported: static (on-demand) manifests with one period; segments by
 * SegmentTemplate ($Number$ or $Time$, with or without a SegmentTimeline),
 * SegmentList, or one file per track (SegmentBase / BaseURL only). MP4
 * tracks only (H.264, HEVC, AV1 video; AAC, AC-3, E-AC-3, Opus audio).
 * Protected (DRM), live, multi-period and WebM-only manifests are
 * recognized and refused, with the reason.
 */

import { kid, kids, parseXml, type XmlElement } from './xml';

export interface Range {
  offset: number;
  length: number;
}

/** One request: a URL, maybe only part of it. */
export interface Piece {
  url: string;
  range?: Range;
}

export interface Track {
  init: Piece | null;
  segments: Piece[];
  bandwidth: number;
  codecs: string;
  height: number;
}

export type Unsupported = 'drm' | 'live' | 'multiPeriod' | 'webm' | 'codec' | 'unreadable';

/** More segments than this is a broken manifest, not a video (a day at 1 s
 * each fits): refused instead of filling memory. */
const MAX_SEGMENTS = 100_000;

export type Mpd =
  | { ok: true; video: Track; audio: Track | null; duration: number }
  | { ok: false; reason: Unsupported };

const VIDEO_CODECS = /^(avc[1-4]|hvc1|hev1|av01|dvh1|dvhe)/;
const AUDIO_CODECS = /^(mp4a|ac-3|ec-3|ac-4|opus|fLaC)/i;

/** "PT1H2M3.5S" → seconds. */
export function isoDuration(s: string | undefined): number {
  const m = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(s ?? '');
  if (!m) return 0;
  const [, d, h, min, sec] = m.map((x) => Number(x ?? 0));
  return d! * 86400 + h! * 3600 + min! * 60 + sec!;
}

function range(s: string | undefined): Range | undefined {
  const m = /^(\d+)-(\d+)$/.exec(s ?? '');
  return m ? { offset: Number(m[1]), length: Number(m[2]) - Number(m[1]) + 1 } : undefined;
}

/** Fills $RepresentationID$, $Number%05d$, $Time$, $Bandwidth$, $$. */
export function fill(template: string, vars: { RepresentationID: string; Number?: number; Time?: number; Bandwidth: number }): string {
  return template.replace(/\$(RepresentationID|Number|Time|Bandwidth|)(%0(\d+)d)?\$/g, (_, name: string, _f, width?: string) => {
    if (!name) return '$';
    const value = String(vars[name as keyof typeof vars] ?? '');
    return width ? value.padStart(Number(width), '0') : value;
  });
}

function protectedBy(el: XmlElement | undefined): boolean {
  return kids(el, 'ContentProtection').length > 0;
}

/** The URL every relative address of `el` is resolved against. */
function baseOf(el: XmlElement | undefined, parent: string): string {
  const base = kid(el, 'BaseURL')?.text;
  return base ? new URL(base, parent).href : parent;
}

/** A SegmentTemplate/SegmentList/SegmentBase, the nearest one wins. */
function nearest(name: string, ...levels: (XmlElement | undefined)[]): XmlElement | undefined {
  for (const l of levels) {
    const found = kid(l, name);
    if (found) return found;
  }
  return undefined;
}

/** Template attributes inherited from the adaptation set, per attribute. */
function merged(rep: XmlElement | undefined, set: XmlElement | undefined, period: XmlElement | undefined): XmlElement | undefined {
  const all = [kid(period, 'SegmentTemplate'), kid(set, 'SegmentTemplate'), kid(rep, 'SegmentTemplate')].filter(Boolean) as XmlElement[];
  if (!all.length) return undefined;
  return {
    name: 'SegmentTemplate',
    attrs: Object.assign({}, ...all.map((t) => t.attrs)),
    children: all.at(-1)!.children.length ? all.at(-1)!.children : (all.findLast((t) => t.children.length)?.children ?? []),
    text: '',
  };
}

function track(rep: XmlElement, set: XmlElement, period: XmlElement, mpd: XmlElement, url: string, duration: number): Track | null {
  const base = baseOf(rep, baseOf(set, baseOf(period, baseOf(mpd, url))));
  const id = rep.attrs.id ?? '';
  const bandwidth = Number(rep.attrs.bandwidth ?? 0);
  const out = (init: Piece | null, segments: Piece[]): Track => ({
    init,
    segments,
    bandwidth,
    codecs: rep.attrs.codecs ?? set.attrs.codecs ?? '',
    height: Number(rep.attrs.height ?? set.attrs.height ?? 0),
  });

  const template = merged(rep, set, period);
  if (template) {
    const a = template.attrs;
    const timescale = Number(a.timescale ?? 1);
    const vars = { RepresentationID: id, Bandwidth: bandwidth };
    const init = a.initialization ? { url: new URL(fill(a.initialization, vars), base).href } : null;
    if (!a.media) return null;
    const segments: Piece[] = [];
    let number = Number(a.startNumber ?? 1);
    const timeline = kid(template, 'SegmentTimeline');
    if (timeline) {
      let time = 0;
      for (const s of kids(timeline, 'S')) {
        if (s.attrs.t !== undefined) time = Number(s.attrs.t);
        const d = Number(s.attrs.d ?? 0);
        if (!(d > 0)) return null;
        let repeat = Number(s.attrs.r ?? 0);
        // r = -1: repeat until the end of the period.
        if (repeat < 0) repeat = Math.max(0, Math.ceil((duration * timescale - time) / d) - 1);
        if (segments.length + repeat >= MAX_SEGMENTS) return null;
        for (let i = 0; i <= repeat; i++) {
          segments.push({ url: new URL(fill(a.media, { ...vars, Number: number++, Time: time }), base).href });
          time += d;
        }
      }
    } else {
      const d = Number(a.duration ?? 0);
      if (!(d > 0) || !duration) return null;
      const count = Math.ceil((duration * timescale) / d);
      if (count > MAX_SEGMENTS) return null;
      for (let i = 0; i < count; i++) {
        segments.push({ url: new URL(fill(a.media, { ...vars, Number: number + i, Time: i * d }), base).href });
      }
    }
    return segments.length ? out(init, segments) : null;
  }

  const list = nearest('SegmentList', rep, set, period);
  if (list) {
    const initEl = kid(list, 'Initialization');
    const init = initEl ? { url: new URL(initEl.attrs.sourceURL ?? '', base).href, range: range(initEl.attrs.range) } : null;
    const segments = kids(list, 'SegmentURL').map((s) => ({ url: new URL(s.attrs.media ?? '', base).href, range: range(s.attrs.mediaRange) }));
    return segments.length && segments.length <= MAX_SEGMENTS ? out(init, segments) : null;
  }

  // One file for the whole track (SegmentBase, or nothing but a BaseURL):
  // fetched whole; its fragments are found in the file itself.
  return out(null, [{ url: base }]);
}

function best(tracks: Track[], quality: (t: Track) => number): Track | null {
  return tracks.sort((a, b) => quality(b) - quality(a))[0] ?? null;
}

export function parseMpd(text: string, url: string): Mpd {
  let mpd: XmlElement;
  try {
    mpd = parseXml(text);
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  if (mpd.name !== 'MPD') return { ok: false, reason: 'unreadable' };
  if (mpd.attrs.type === 'dynamic') return { ok: false, reason: 'live' };
  const periods = kids(mpd, 'Period');
  if (periods.length !== 1) return { ok: false, reason: periods.length ? 'multiPeriod' : 'unreadable' };
  const period = periods[0]!;
  const duration = isoDuration(period.attrs.duration ?? mpd.attrs.mediaPresentationDuration);

  const video: Track[] = [];
  const audio: Track[] = [];
  let drm = protectedBy(mpd);
  let webm = false;
  // Why the audio, if there is some, could not be taken.
  let audioSeen = false;
  let audioDrm = false;
  let audioWebm = false;
  for (const set of kids(period, 'AdaptationSet')) {
    const setType = set.attrs.contentType ?? set.attrs.mimeType?.split('/')[0] ?? '';
    for (const rep of kids(set, 'Representation')) {
      const mime = rep.attrs.mimeType ?? set.attrs.mimeType ?? '';
      const type = setType || mime.split('/')[0];
      if (type !== 'video' && type !== 'audio') continue;
      if (type === 'audio') audioSeen = true;
      if (protectedBy(set) || protectedBy(rep)) {
        drm = true;
        if (type === 'audio') audioDrm = true;
        continue;
      }
      if (/webm/i.test(mime)) {
        webm = true;
        if (type === 'audio') audioWebm = true;
        continue;
      }
      const t = track(rep, set, period, mpd, url, duration);
      if (!t) continue;
      const codec = t.codecs.split(',')[0]?.trim() ?? '';
      if (type === 'video' && (!codec || VIDEO_CODECS.test(codec))) video.push(t);
      if (type === 'audio' && (!codec || AUDIO_CODECS.test(codec))) audio.push(t);
    }
  }
  const v = best(video, (t) => t.height * 1e9 + t.bandwidth);
  if (!v) return { ok: false, reason: drm ? 'drm' : webm ? 'webm' : video.length ? 'codec' : 'unreadable' };
  const a = best(audio, (t) => t.bandwidth);
  // A video whose sound cannot be taken is refused, not saved silent.
  if (audioSeen && !a) return { ok: false, reason: audioDrm ? 'drm' : audioWebm ? 'webm' : 'codec' };
  return { ok: true, video: v, audio: a, duration };
}
