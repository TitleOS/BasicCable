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
      // An empty answer is sometimes just the catalog having a bad moment: ask again next time.
      if (metas.length) store.cacheSet(key, metas);
      return metas;
    } catch (e) {
      log.warn('search failed', type, q, e.message);
      return [];
    }
  }));
  return results.flat();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The catalog's raw meta for a title, or null when it has no such title of that type. Temporary failures
 * (timeouts, 5xx: Cinemeta 504s now and then) are retried, and thrown if they persist; they never read as "no
 * such title".
 */
async function fetchMeta(type, id, attempts = 3) {
  for (let i = 1; ; i++) {
    try {
      const data = await fetchJson(`${metaBase()}/meta/${type}/${encodeURIComponent(id)}.json`);
      return data.meta || null;
    } catch (e) {
      if (/HTTP 404\b/.test(e.message)) return null;
      if (i >= attempts) throw e;
      await sleep(700 * i);
    }
  }
}

/**
 * Does a catalog search for `name` (of `type`) list `id`? 'yes', 'no' (it found titles by that name, none with
 * this id), or 'unknown' (the search came back empty twice).
 */
async function confirmBySearch(id, name, type) {
  const q = String(name || '').replace(/[*?]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!q) return 'unknown';
  for (let i = 0; i < 2; i++) {
    const results = await search(q, [type]);
    if (results.some((r) => r.id === id)) return 'yes';
    if (results.length) return 'no';
  }
  return 'unknown';
}

/**
 * Which title an IMDb id is, and whether it's a show or a movie, trying `types` in order. Cinemeta answers a
 * movie request for a show's id with an unrelated film filed under that id, so a movie only counts once a
 * catalog search by its name finds that same id (or, when search finds nothing, if the caller said it's a movie:
 * `explicit`). Shows come from a clean endpoint and count when they have episodes or search confirms them.
 * Resolves to { type, meta }; throws a readable error otherwise.
 */
export async function lookupImdb(id, { types = ['series', 'movie'], explicit = false } = {}) {
  const problems = [];
  for (const type of types) {
    let raw;
    try {
      raw = await fetchMeta(type, id);
    } catch (e) {
      problems.push(`the catalog didn't answer for ${type === 'series' ? 'shows' : 'movies'} (${e.message.replace(/ for https?:.*/, '')})`);
      continue;
    }
    if (!raw?.name) continue;
    const confirmed = await confirmBySearch(id, raw.name, type);
    const ok = type === 'series'
      ? confirmed === 'yes' || (raw.videos || []).length > 0
      : confirmed === 'yes' || (confirmed === 'unknown' && explicit);
    if (ok) return { type, meta: await getMeta(type, id) };
    problems.push(type === 'movie' && confirmed === 'no'
      ? `the movie catalog files "${raw.name}" under it, but that film's real id is different`
      : `couldn't confirm it's the ${type === 'series' ? 'show' : 'movie'} "${raw.name}"${type === 'movie' ? ' (add "movie:" in front if you\'re sure)' : ''}`);
  }
  throw new Error(`No show or movie with IMDb id ${id}${problems.length ? `: ${problems.join('; ')}` : ''}.`);
}

/** Full meta for a title, cached for a day. */
/** Metadata fetched before (no network): null for a title we haven't looked up. */
export function cachedMeta(type, id) {
  return store.cacheGet(`meta:${type}:${id}`, 30 * DAY);
}

export async function getMeta(type, id) {
  const key = `meta:${type}:${id}`;
  const cached = store.cacheGet(key, DAY);
  if (cached) return cached;
  const m = await fetchMeta(type, id);
  if (!m) throw new Error(`No metadata for ${type} ${id}`);
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
/**
 * Minutes per episode (or the movie's length). Cinemeta sometimes gives a miniseries' total runtime
 * (Planet Earth: "538 min" for 11 episodes); anything over 2.5 hours on a series is treated as a total and
 * divided by its episode count.
 */
export function episodeRuntime(meta) {
  const r = meta.runtime;
  if (!r || meta.type !== 'series' || r <= 150) return r || null;
  const count = playableEpisodes(meta, { now: Infinity }).length;
  return count > 1 && r / count >= 5 ? Math.round(r / count) : r;
}

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
