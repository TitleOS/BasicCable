import { store } from './db.js';
import { log } from './config.js';
import { fetchJson } from './metadata.js';

export const RESOLUTIONS = [2160, 1440, 1080, 720, 576, 480];

const UNCACHED = /\b(download|uncached|not cached)\b|⏳|⬇️|\[(?:rd|ad|pm|tb|dl|ed|oc|pp|pk)\s*download\]/i;
const CACHED = /\+\]|⚡|\bcached\b|\[(?:rd|ad|pm|tb|dl|ed|oc|pp|pk)\+\]/i;
const DOLBY_VISION = /\b(dv|dovi|dolby[ .-]?vision)\b/i;
const JUNK = /\b(cam|camrip|hdcam|telesync|hdts|telecine|screener)\b/i;
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
 * Rank playable debrid streams for a channel. Returns candidates best-first.
 * `prefer` lists words (e.g. "Superfan") that put a release ahead of everything else, resolution included;
 * among preferred releases the usual resolution rules still apply.
 */
export function rankStreams(streams, channel, prefer = []) {
  const order = resolutionOrder(channel.resolution || 1080, channel.fallback);
  const opts = channel.options || {};
  const exclude = (opts.excludeKeywords || []).map((k) => k.trim().toLowerCase()).filter(Boolean);
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
    const isPreferred = preferred.some((k) => lower.includes(k));
    const resolution = parseResolution(text);
    const rank = resolution ? order.indexOf(resolution) : order.length;
    const dv = DOLBY_VISION.test(text) && !/\bhdr10\b/i.test(text);
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
      score: [isPreferred ? 0 : 1, rank, avoidDV && dv ? 1 : 0, CACHED.test(text) ? 0 : 1, i],
    });
  });
  out.sort((a, b) => {
    for (let k = 0; k < a.score.length; k++) if (a.score[k] !== b.score[k]) return a.score[k] - b.score[k];
    return 0;
  });
  return out;
}

async function fetchStreams(addonUrl, type, id) {
  const base = addonBase(addonUrl);
  const data = await fetchJson(`${base}/stream/${type}/${encodeURIComponent(id)}.json`, { timeoutMs: 25000 });
  return (data.streams || []).map((s) => ({ ...s, _addon: base.replace(/^(https?:\/\/[^/]+).*/, '$1') }));
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
  const candidates = rankStreams(streams, channel, store.getSettings().preferKeywords || []);
  log.info(`streams for ${item.video_id}: ${streams.length} found, ${candidates.length} playable` +
    (candidates[0] ? `, best ${candidates[0].resolution || '?'}p` : ''));
  cache.set(key, { at: Date.now(), candidates });
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
