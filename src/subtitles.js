// Picking an embedded subtitle track and deciding how to deliver it.

// Text formats ffmpeg can turn into WebVTT, so players get a selectable caption track.
const TEXT = new Set(['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text', 'text']);
// Image formats (Blu-ray PGS, DVD, DVB) can only be shown by burning them into the picture.
const BITMAP = new Set(['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle']);

const ENGLISH = new Set(['eng', 'en', 'english']);
const UNKNOWN = new Set(['', 'und', 'unk', 'unknown', 'zxx', 'mis']);

const lang = (s) => String(s.tags?.language || s.tags?.LANGUAGE || '').trim().toLowerCase();
const title = (s) => String(s.tags?.title || s.tags?.TITLE || '');
const isSdh = (s) => !!s.disposition?.hearing_impaired || /\b(sdh|cc|hoh|hearing[ -]?impaired|closed[ -]?captions?)\b/i.test(title(s));
const isForced = (s) => !!s.disposition?.forced || /\bforced\b/i.test(title(s));
export const isEnglish = (s) => ENGLISH.has(lang(s));

/**
 * Choose the subtitle track to show, from ffprobe's subtitle streams (in file order):
 * an English SDH track if there is one, otherwise the first English or unlabelled track.
 * Forced-only tracks (just the foreign-language lines) are skipped.
 * Returns { index (among subtitle streams, for -map 0:s:N), kind: 'text' | 'bitmap', stream } or null.
 */
export function pickSubtitle(subs, { textOnly = false } = {}) {
  const usable = subs
    .map((s, index) => ({ s, index, kind: TEXT.has(s.codec_name) ? 'text' : BITMAP.has(s.codec_name) ? 'bitmap' : null }))
    .filter((x) => x.kind && !isForced(x.s) && (!textOnly || x.kind === 'text'));
  const sdh = usable.find((x) => ENGLISH.has(lang(x.s)) && isSdh(x.s));
  const any = usable.find((x) => ENGLISH.has(lang(x.s)) || UNKNOWN.has(lang(x.s)));
  const pick = sdh || any;
  return pick ? { index: pick.index, kind: pick.kind, stream: pick.s, sdh: isSdh(pick.s) } : null;
}

/**
 * How a channel delivers the picked track.
 * mode "auto": text -> selectable WebVTT track, bitmap -> burned in (re-encodes the video).
 * mode "soft": only text tracks are considered (never re-encode).
 * mode "off":  nothing.
 */
export function subtitlePlan(subs, mode = 'auto') {
  if (mode === 'off') return null;
  const pick = pickSubtitle(subs || [], { textOnly: mode === 'soft' });
  if (!pick) return null;
  return { ...pick, delivery: pick.kind === 'text' ? 'vtt' : 'burn' };
}

/**
 * filter_complex that overlays an image subtitle track onto the video. The subtitle canvas is scaled to
 * the video width and bottom-aligned, which keeps captions in place on cropped (e.g. 2.39:1) encodes.
 * Output is capped at 1080p to keep the re-encode affordable.
 */
export function burnFilter(video, sub, subIndex) {
  const vw = video.width || 1920;
  const vh = video.height || 1080;
  const scale = vh > 1080 ? 1080 / vh : 1;
  const ow = Math.round((vw * scale) / 2) * 2;
  const oh = Math.round((vh * scale) / 2) * 2;
  const sw = sub.width || 1920;
  const sh = sub.height || 1080;
  const subH = Math.round((sh * ow) / sw / 2) * 2;
  const v = scale < 1 ? `[0:v:0]scale=${ow}:${oh}[base]` : '[0:v:0]null[base]';
  return `${v};[0:s:${subIndex}]scale=${ow}:${subH}[subs];` +
    `[base][subs]overlay=x=0:y=${oh - subH}:eof_action=pass:format=auto,format=yuv420p[vout]`;
}
