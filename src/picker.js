import { store } from './db.js';
import { log } from './config.js';
import { fetchJson } from './metadata.js';

export const RESOLUTIONS = [2160, 1440, 1080, 720, 576, 480];

const UNCACHED = /\b(download|uncached|not cached)\b|⏳|⬇️|\[(?:rd|ad|pm|tb|dl|ed|oc|pp|pk)\s*download\]/i;
const CACHED = /\+\]|⚡|\bcached\b|\[(?:rd|ad|pm|tb|dl|ed|oc|pp|pk)\+\]/i;
const DOLBY_VISION = /\b(dv|dovi|dolby[ .-]?vision)\b/i;
// HDR10 and HDR10+ (a plain "HDR" tag is HDR10 in practice, and so is a Dolby Vision file with an HDR10 base layer).
const HDR10 = /\bhdr(?:10(?:\+|plus)?)?(?![a-z0-9])/i;
const HLG = /\bhlg\b/i;
// Theatre recordings and TV-synced audio: never worth airing.
const JUNK = /\b(cam|camrip|cam[ .-]rip|hdcam|hqcam|telesync|hdts|tsrip|hdtc|telecine|screener|dvdscr|pdvd|predvd|tv[ .-]?sync)\b/i;
const JUNK_CASED = /\b(TS|TC|SCR)\b/;

export function addonBase(url) {
  return url.trim().replace(/^stremio:\/\//i, 'https://').replace(/\/manifest\.json.*$/i, '').replace(/\/+$/, '');
}

function streamText(s) {
  return [s.name, s.title, s.description, s.behaviorHints?.filename].filter(Boolean).join(' ');
}

/** Best-effort resolution detection from Stremio stream labels. */
export function parseResolution(text) {
  const t = text.toLowerCase();
  if (/\b(2160p?|4k|uhd)\b/.test(t)) return 2160;
  if (/\b1440p?\b|\b2k\b/.test(t)) return 1440;
  if (/\b1080[pi]?\b|\bfhd\b/.test(t)) return 1080;
  if (/\b720p?\b|\bhdrip\b/.test(t)) return 720;
  if (/\b576p?\b/.test(t)) return 576;
  if (/\b480p?\b|\bsd\b|\bdvdrip\b/.test(t)) return 480;
  return null;
}

/** Whole-word match for a blacklist entry, so "YTS" catches "[YTS.MX]" but not "nights". */
function wordMatcher(k) {
  const esc = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '[\\s._-]+');
  return new RegExp(`(?:^|[^a-z0-9])${esc}(?![a-z0-9])`, 'i');
}

/** "hdr10" (HDR10/HDR10+/HDR), "dv" (Dolby Vision only), "hlg" or null (SDR or unlabelled). */
export function parseHdr(text) {
  if (HDR10.test(text)) return 'hdr10';
  if (DOLBY_VISION.test(text)) return 'dv';
  if (HLG.test(text)) return 'hlg';
  return null;
}

function parseSize(text) {
  const m = text.match(/(\d+(?:[.,]\d+)?)\s*(tb|gb|mb)\b/i);
  if (!m) return null;
  const n = parseFloat(m[1].replace(',', '.'));
  return n * { tb: 1024 ** 4, gb: 1024 ** 3, mb: 1024 ** 2 }[m[2].toLowerCase()];
}

/**
 * Resolution preference order for a channel: exact target first, then the next best.
 * fallback "lower": 1080 -> 720 -> 576 -> 480 -> 1440 -> 2160
 * fallback "higher": 1080 -> 1440 -> 2160 -> 720 -> 576 -> 480
 */
export function resolutionOrder(target, fallback = 'lower') {
  const lower = RESOLUTIONS.filter((r) => r < target);
  const higher = RESOLUTIONS.filter((r) => r > target).reverse();
  return fallback === 'higher' ? [target, ...higher, ...lower] : [target, ...lower, ...higher];
}

/**
 * How much a channel wants this HDR format, lower is better. "Prefer HDR" puts any HDR ahead of SDR (Dolby
 * Vision-only files don't count while the channel avoids them); "Prefer HDR10" puts HDR10/HDR10+ ahead of both.
 */
function hdrRank(hdr, opts, avoidDV) {
  const anyHdr = hdr === 'hdr10' || hdr === 'hlg' || (hdr === 'dv' && !avoidDV);
  if (opts.preferHdr10) return hdr === 'hdr10' ? 0 : opts.preferHdr && anyHdr ? 1 : 2;
  if (opts.preferHdr) return anyHdr ? 0 : 1;
  return 0;
}

/**
 * Rank playable debrid streams for a channel. Returns candidates best-first.
 * `prefer` lists words (e.g. "Superfan") that put a release ahead of everything else, resolution included;
 * among preferred releases the usual resolution rules still apply. `block` lists release words (e.g. "YIFY")
 * that are never used, on any channel. HDR preferences only reorder releases of the same resolution.
 */
export function rankStreams(streams, channel, prefer = [], block = []) {
  const order = resolutionOrder(channel.resolution || 1080, channel.fallback);
  const opts = channel.options || {};
  const exclude = (opts.excludeKeywords || []).map((k) => k.trim().toLowerCase()).filter(Boolean);
  const blocked = block.map((k) => String(k).trim()).filter(Boolean).map(wordMatcher);
  const avoidDV = opts.avoidDolbyVision !== false;
  const preferred = prefer.map((k) => String(k).trim().toLowerCase()).filter(Boolean);

  const out = [];
  streams.forEach((s, i) => {
    if (!s.url || !/^https?:\/\//i.test(s.url)) return; // torrents/usenet need a debrid-resolved link
    const text = streamText(s);
    if (UNCACHED.test(text)) return;
    if (JUNK.test(text) || JUNK_CASED.test(text)) return;
    const lower = text.toLowerCase();
    if (exclude.some((k) => lower.includes(k))) return;
    if (blocked.some((re) => re.test(text))) return;
    const isPreferred = preferred.some((k) => lower.includes(k));
    const resolution = parseResolution(text);
    const rank = resolution ? order.indexOf(resolution) : order.length;
    const hdr = parseHdr(text);
    const dv = hdr === 'dv';
    out.push({
      stream: s,
      url: s.url,
      headers: s.behaviorHints?.proxyHeaders?.request || null,
      label: text.replace(/\s+/g, ' ').trim(),
      resolution,
      size: parseSize(text),
      cached: CACHED.test(text),
      addon: s._addon,
      preferred: isPreferred,
      hdr,
      score: [isPreferred ? 0 : 1, rank, hdrRank(hdr, opts, avoidDV), avoidDV && dv ? 1 : 0, CACHED.test(text) ? 0 : 1, i],
    });
  });
  out.sort((a, b) => {
    for (let k = 0; k < a.score.length; k++) if (a.score[k] !== b.score[k]) return a.score[k] - b.score[k];
    return 0;
  });
  return out;
}

// Addons report trouble (rate limits, debrid errors) as a lone "stream" with no link, just a message.
const NOTICE = /\b(error|rate.?limit\w*|too many requests|limit (?:reached|exceeded)|unavailable|invalid|expired|failed|try again|blocked)\b|⚠️|❌|🚫/i;

/** True when an addon's answer is only a notice: one or two entries, none of them a usable link. */
export function isNoticeOnly(streams) {
  return streams.length > 0 && streams.length <= 2 && streams.every((s) => !s.url || NOTICE.test(streamText(s)));
}

async function fetchStreams(addonUrl, type, id) {
  const base = addonBase(addonUrl);
  const data = await fetchJson(`${base}/stream/${type}/${encodeURIComponent(id)}.json`, { timeoutMs: 25000 });
  const streams = data.streams || [];
  if (isNoticeOnly(streams)) throw new Error(`answered with a notice: ${streamText(streams[0]).replace(/\s+/g, ' ').slice(0, 120)}`);
  return streams.map((s) => ({ ...s, _addon: base.replace(/^(https?:\/\/[^/]+).*/, '$1') }));
}

const cache = new Map(); // `${channelId}|${video_id}` -> { at, candidates }
const CACHE_MS = 2 * 3600 * 1000;

/** Ask every configured stream addon for this item and return ranked candidates. */
export async function findStreams(item, channel, { fresh = false } = {}) {
  const key = `${channel.id}|${channel.resolution}|${item.video_id}`;
  const hit = cache.get(key);
  if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.candidates;

  const addons = store.getSettings().streamAddons || [];
  if (!addons.length) throw new Error('No stream addons configured. Add your debrid-enabled addon URL in Settings.');
  const results = await Promise.allSettled(addons.map((a) => fetchStreams(a, item.type, item.video_id)));
  // If no addon answered at all, that's an outage, not "nothing available": don't cache it, and let
  // callers retry instead of skipping the episode.
  if (results.every((r) => r.status === 'rejected')) {
    throw new Error(`No stream addon answered for ${item.video_id}: ${results[0].reason?.message || 'unknown error'}`);
  }
  const streams = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') streams.push(...r.value);
    else log.warn(`stream addon #${i + 1} failed for ${item.video_id}: ${r.reason?.message}`);
  });
  const settings = store.getSettings();
  const candidates = rankStreams(streams, channel, settings.preferKeywords || [], settings.blockKeywords || []);
  const failed = results.filter((r) => r.status === 'rejected').length;
  log.info(`streams for ${item.video_id}: ${streams.length} found, ${candidates.length} playable` +
    (candidates[0] ? `, best ${candidates[0].resolution || '?'}p` : '') + (failed ? ` (${failed} addon${failed > 1 ? 's' : ''} failed)` : ''));
  // An addon down and nothing usable from the rest is an outage, not "this title can't be played": retry later
  // rather than skip it. (One rate-limited addon once got a whole 4K movie channel marked unplayable.)
  if (failed && !candidates.length) {
    throw new Error(`${failed} of ${addons.length} stream addons failed for ${item.video_id} and the rest had nothing playable; trying again later`);
  }
  // A partial answer isn't kept for long: the addon that failed may have had the best release.
  if (!failed) cache.set(key, { at: Date.now(), candidates });
  return candidates;
}

/** Channel or ranking settings changed: rank again next time. */
export function clearStreams(channelId = null) {
  for (const key of cache.keys()) if (channelId == null || key.startsWith(`${channelId}|`)) cache.delete(key);
}

export function forgetStream(item, channel, url) {
  const key = `${channel.id}|${channel.resolution}|${item.video_id}`;
  const hit = cache.get(key);
  if (hit) hit.candidates = hit.candidates.filter((c) => c.url !== url);
}
