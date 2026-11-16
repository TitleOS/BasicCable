// Shows whose seasons Cinemeta numbers by year (American Pickers: "2019", episode 28), while releases, and so the
// stream addons, use the broadcast seasons ("S21E04"). Asking an addon for tt1596786:2019:28 finds nothing;
// tt1596786:21:4 finds the release. TVmaze (free, no key) has the broadcast numbering, and an episode is matched
// to it by title, or else by air date (Cinemeta's dates often run a day after TVmaze's).

import { store } from './db.js';
import { log } from './config.js';
import { fetchJson, cachedMeta, getMeta } from './metadata.js';

const DAY = 24 * 3600 * 1000;
const TVMAZE = 'https://api.tvmaze.com';
const KEEP = 7 * DAY;

/** A season numbered by its year. */
export const isYearSeason = (season) => Number(season) >= 1900 && Number(season) <= 2200;

const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '');

/** A show's episodes from TVmaze, [{ s, n, d, t }], kept a week; [] when TVmaze doesn't know it. */
export async function tvmazeEpisodes(imdb) {
  const key = `tvmaze:${imdb}`;
  const hit = store.cacheGet(key, KEEP);
  if (hit) return hit;
  let eps = [];
  try {
    const show = await fetchJson(`${TVMAZE}/lookup/shows?imdb=${encodeURIComponent(imdb)}`);
    const list = await fetchJson(`${TVMAZE}/shows/${show.id}/episodes`);
    eps = list.filter((e) => e.season != null && e.number != null).map((e) => ({ s: e.season, n: e.number, d: e.airdate || '', t: e.name || '' }));
  } catch (e) {
    if (!/HTTP 404/.test(e.message)) throw e; // a network problem: try again next time instead of keeping "unknown"
  }
  store.cacheSet(key, eps);
  return eps;
}

/** Pick the broadcast episode for a Cinemeta episode: same title (nearest air date), else the one aired within a day. */
export function matchEpisode(video, eps) {
  const when = Date.parse(video?.released || '');
  const gap = (e) => (Number.isFinite(when) && e.d ? Math.abs(Date.parse(`${e.d}T12:00:00Z`) - when) : Infinity);
  const title = norm(video?.title);
  if (title) {
    const same = eps.filter((e) => norm(e.t) === title).sort((a, b) => gap(a) - gap(b));
    if (same.length) return same[0];
  }
  const near = eps.filter((e) => gap(e) <= 1.5 * DAY);
  return near.length === 1 ? near[0] : null;
}

const memo = new Map(); // video id -> broadcast id (or null)

/**
 * The broadcast numbering of a year-season episode, as a stream id ("tt1596786:21:4"), or null when the item
 * isn't one or no match is found.
 */
export async function broadcastId(item) {
  if (item?.type !== 'series') return null;
  const [imdb, season] = String(item.video_id).split(':');
  if (!/^tt\d+$/.test(imdb) || !isYearSeason(season)) return null;
  if (memo.has(item.video_id)) return memo.get(item.video_id);
  const meta = cachedMeta('series', imdb) || await getMeta('series', imdb).catch(() => null);
  const video = meta?.videos?.find((v) => v.id === item.video_id) || { title: item.episode_title };
  const eps = await tvmazeEpisodes(imdb);
  const m = matchEpisode(video, eps);
  const id = m ? `${imdb}:${m.s}:${m.n}` : null;
  memo.set(item.video_id, id);
  if (id) log.info(`${item.title || imdb} ${item.video_id.split(':').slice(1).join('x')} "${video.title || ''}" is S${String(m.s).padStart(2, '0')}E${String(m.n).padStart(2, '0')} to the stream addons`);
  return id;
}

export const _test = { memo };
