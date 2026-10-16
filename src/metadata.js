import { store } from './db.js';
import { log } from './config.js';

const DAY = 24 * 3600 * 1000;

function metaBase() {
  return (store.getSettings().metaAddon || 'https://v3-cinemeta.strem.io').replace(/\/manifest\.json$/, '').replace(/\/+$/, '');
}

export async function fetchJson(url, { timeoutMs = 15000, headers } = {}) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': 'StreamTube/0.1', ...headers } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url.replace(/\/\/[^/]*@/, '//***@')}`);
  return res.json();
}

/** Parse Cinemeta style runtimes ("21 min", "1h 30min", "2 h", "45") into minutes. */
export function parseRuntime(runtime) {
  if (runtime == null) return null;
  if (typeof runtime === 'number') return runtime > 0 ? runtime : null;
  const s = String(runtime).toLowerCase();
  const h = s.match(/(\d+(?:\.\d+)?)\s*h/);
  const m = s.match(/(\d+)\s*m/);
  let total = 0;
  if (h) total += parseFloat(h[1]) * 60;
  if (m) total += parseInt(m[1], 10);
  if (!h && !m) {
    const n = s.match(/\d+/);
    if (n) total = parseInt(n[0], 10);
  }
  return total > 0 ? Math.round(total) : null;
}

function slimMeta(m, type) {
  return {
    id: m.id || m.imdb_id,
    type: m.type || type,
    name: m.name,
    poster: m.poster || '',
    background: m.background || '',
    releaseInfo: m.releaseInfo || m.year || '',
  };
}

export async function search(query, types = ['series', 'movie']) {
  const q = query.trim();
  if (!q) return [];
  const results = await Promise.all(types.map(async (type) => {
    const key = `search:${type}:${q.toLowerCase()}`;
    const cached = store.cacheGet(key, DAY);
    if (cached) return cached;
    try {
      const data = await fetchJson(`${metaBase()}/catalog/${type}/top/search=${encodeURIComponent(q)}.json`);
      const metas = (data.metas || []).filter((m) => m.id || m.imdb_id).map((m) => slimMeta(m, type));
      store.cacheSet(key, metas);
      return metas;
    } catch (e) {
      log.warn('search failed', type, q, e.message);
      return [];
    }
  }));
  return results.flat();
}

/** Full meta for a title, cached for a day. */
export async function getMeta(type, id) {
  const key = `meta:${type}:${id}`;
  const cached = store.cacheGet(key, DAY);
  if (cached) return cached;
  const data = await fetchJson(`${metaBase()}/meta/${type}/${encodeURIComponent(id)}.json`);
  if (!data.meta) throw new Error(`No metadata for ${type} ${id}`);
  const m = data.meta;
  const meta = {
    ...slimMeta(m, type),
    description: m.description || '',
    runtime: parseRuntime(m.runtime),
    released: m.released || null,
    videos: (m.videos || []).map((v) => ({
      id: v.id,
      season: v.season,
      episode: v.episode ?? v.number,
      title: v.name || v.title || '',
      overview: v.overview || v.description || '',
      released: v.released || v.firstAired || null,
      thumbnail: v.thumbnail || '',
    })),
  };
  store.cacheSet(key, meta);
  return meta;
}

/** Episodes in airing order, skipping specials (season 0) and anything not yet released. */
export function playableEpisodes(meta, { includeSpecials = false, now = Date.now() } = {}) {
  const seen = new Set();
  return (meta.videos || [])
    .filter((v) => v.id && Number.isFinite(v.season) && Number.isFinite(v.episode))
    .filter((v) => includeSpecials || v.season > 0)
    .filter((v) => !v.released || Date.parse(v.released) <= now)
    .sort((a, b) => a.season - b.season || a.episode - b.episode)
    .filter((v) => (seen.has(v.id) ? false : seen.add(v.id)));
}

/** Convert a glob ("Star Trek*", "*Batman?") into an anchored, case-insensitive RegExp. */
export function globToRegExp(pattern) {
  const escaped = pattern.trim().replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

/** Normalise titles so "Star Trek: Voyager" and "Star Trek Voyager" both match "star trek voyager*". */
function looseTitle(s) {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[:\-–—_,.!'’]/g, ' ').replace(/\s+/g, ' ').trim();
}

export async function expandWildcard(pattern, types = ['series']) {
  const terms = pattern.split(/[*?]/).map((t) => t.trim()).filter(Boolean);
  if (!terms.length) throw new Error('Wildcard needs at least one word, e.g. "Star Trek*"');
  const query = terms.sort((a, b) => b.length - a.length)[0];
  const strict = globToRegExp(pattern);
  const loose = globToRegExp(looseTitle(pattern));
  const found = await search(query, types);
  const seen = new Set();
  return found
    .filter((m) => m.name && (strict.test(m.name) || loose.test(looseTitle(m.name))))
    .filter((m) => (seen.has(m.id) ? false : seen.add(m.id)));
}
