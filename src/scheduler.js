import { DateTime } from 'luxon';
import { store } from './db.js';
import { config, log } from './config.js';
import { getMeta, playableEpisodes, expandWildcard } from './metadata.js';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
// A gap shorter than this at the end of a block is absorbed by letting the previous item run on,
// instead of starting something that would be cut off.
const ABSORB_GAP = 10 * MIN;
const DEFAULT_RUNTIME = { series: 30, movie: 120 };

// ---------------------------------------------------------------------------
// Content resolution: sources/slot content -> playable "shows" with episode lists

/** A wildcard source caches its expansion for a day; `excluded` lets the user untick matches. */
export async function resolveWildcard(source, { force = false } = {}) {
  const o = source.options || {};
  const fresh = o.resolvedAt && Date.now() - o.resolvedAt < 24 * HOUR;
  if (fresh && !force && Array.isArray(o.resolved)) return o.resolved.filter((m) => !(o.excluded || []).includes(m.id));
  try {
    const resolved = await expandWildcard(source.ref, o.types || ['series']);
    if (source.id) store.updateSourceOptions(source.id, { ...o, resolved, resolvedAt: Date.now() });
    return resolved.filter((m) => !(o.excluded || []).includes(m.id));
  } catch (e) {
    log.warn(`wildcard "${source.ref}" failed: ${e.message}`);
    return (o.resolved || []).filter((m) => !(o.excluded || []).includes(m.id));
  }
}

/** Turn a content spec ({kind, ref}) into a list of titles ({id, type, name}). */
async function titlesFor(spec) {
  if (spec.kind === 'wildcard') return resolveWildcard(spec);
  return [{ id: spec.ref, type: spec.kind, name: spec.name, poster: spec.poster }];
}

/** Load episode lists/runtimes for every title the channel can play. */
async function loadLibrary(titles, channel) {
  const lib = new Map();
  await Promise.all(titles.map(async (t) => {
    if (lib.has(t.id)) return;
    try {
      const meta = await getMeta(t.type, t.id);
      const runtime = meta.runtime || DEFAULT_RUNTIME[t.type] || 30;
      const entry = { id: t.id, type: t.type, name: meta.name || t.name, poster: meta.poster, background: meta.background, description: meta.description, runtime };
      if (t.type === 'movie' && meta.released && Date.parse(meta.released) > Date.now()) return; // not out yet
      if (t.type === 'series') {
        entry.episodes = playableEpisodes(meta, { includeSpecials: !!channel.options?.includeSpecials });
        if (!entry.episodes.length) return;
      }
      lib.set(t.id, entry);
    } catch (e) {
      log.warn(`metadata for ${t.type} ${t.id} unavailable: ${e.message}`);
    }
  }));
  return lib;
}

// ---------------------------------------------------------------------------
// Slot occurrences

/** Concrete [start, end) occurrences of the channel's weekly slots that overlap [from, to). */
export function slotOccurrences(slots, from, to, zone) {
  const out = [];
  let day = DateTime.fromMillis(from, { zone }).startOf('day').minus({ days: 1 });
  const last = DateTime.fromMillis(to, { zone }).endOf('day');
  while (day <= last) {
    for (const slot of slots) {
      const days = String(slot.days).split(',').map(Number);
      if (!days.includes(day.weekday)) continue;
      const [h, m] = slot.start.split(':').map(Number);
      const start = day.set({ hour: h, minute: m, second: 0, millisecond: 0 }).toMillis();
      const end = start + slot.minutes * MIN;
      if (end > from && start < to) out.push({ slot, start, end });
    }
    day = day.plus({ days: 1 });
  }
  out.sort((a, b) => a.start - b.start || a.slot.id - b.slot.id);
  // Earlier occurrence wins when two slots overlap; the later one is clipped.
  const merged = [];
  for (const o of out) {
    const prev = merged[merged.length - 1];
    if (prev && o.start < prev.end) {
      if (o.end <= prev.end) continue;
      o.start = prev.end;
    }
    merged.push(o);
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Pickers: decide what plays next from a pool of titles

function roundUp(minutes, step) {
  if (!step || step <= 1) return minutes;
  return Math.ceil(minutes / step) * step;
}

/**
 * Builds guide rows. `cursors` maps cursor keys to values and is mutated as items are scheduled;
 * each row records the previous values of cursors it moved so a rebuild can rewind them exactly.
 */
class Planner {
  constructor(channel, lib, cursors, recent) {
    this.channel = channel;
    this.lib = lib;
    this.cursors = cursors;
    this.recent = recent; // recently scheduled meta ids/video ids, newest first
    this.rows = [];
  }

  /** The row that ends where planning continues: the last planned row, or the last saved one. */
  previousRow() {
    return this.rows[this.rows.length - 1] || this.prevSaved;
  }

  durationOf(entry) {
    return roundUp(entry.runtime, this.channel.round_minutes) * MIN;
  }

  /** Next episode of a show according to its per-channel cursor (wraps around at the end). */
  nextEpisode(entry, order) {
    const eps = entry.episodes;
    if (order === 'random') return eps[Math.floor(Math.random() * eps.length)];
    const last = this.cursors[`ep:${entry.id}`];
    const idx = last ? eps.findIndex((e) => e.id === last) : -1;
    return eps[(idx + 1) % eps.length];
  }

  /** Candidate item for a title, without committing cursors. */
  candidate(entry, order) {
    if (entry.type === 'series') {
      const ep = this.nextEpisode(entry, order);
      return { entry, video: ep, duration: this.durationOf(entry) };
    }
    return { entry, video: null, duration: this.durationOf(entry) };
  }

  /** Choose from several titles. mode: shuffle | sequential | random */
  pickFrom(titles, mode, remaining, poolKey) {
    const entries = titles.map((t) => this.lib.get(t.id)).filter(Boolean);
    if (!entries.length) return null;
    let ordered;
    if (mode === 'sequential') {
      const lastId = this.cursors[poolKey];
      const idx = lastId ? entries.findIndex((e) => e.id === lastId) : -1;
      ordered = entries.map((_, i) => entries[(idx + 1 + i) % entries.length]);
    } else {
      // Shuffle, but push recently aired titles to the back so the channel doesn't repeat itself.
      const recentIdx = (id) => {
        const i = this.recent.indexOf(id);
        return i === -1 ? Infinity : i;
      };
      ordered = entries
        .map((e) => ({ e, r: Math.random() }))
        .sort((a, b) => {
          const ra = recentIdx(a.e.id), rb = recentIdx(b.e.id);
          const wa = ra < Math.min(3, entries.length - 1) ? 1 : 0;
          const wb = rb < Math.min(3, entries.length - 1) ? 1 : 0;
          return wa - wb || a.r - b.r;
        })
        .map((x) => x.e);
    }
    const order = mode === 'random' ? 'random' : 'sequential';
    const cands = ordered.map((e) => this.candidate(e, order));
    // Prefer the first title that fits the time left; otherwise the shortest one.
    return cands.find((c) => c.duration <= remaining) || cands.sort((a, b) => a.duration - b.duration)[0];
  }

  commit(cand, start, end, origin, poolKey) {
    const prev = {};
    const set = (k, v) => {
      if (!(k in prev)) prev[k] = this.cursors[k] ?? null;
      this.cursors[k] = v;
    };
    const truncated = end - start < cand.duration - MIN;
    if (poolKey) set(poolKey, cand.entry.id);
    // A cut-off episode airs again next time instead of being skipped.
    if (cand.video && !truncated) set(`ep:${cand.entry.id}`, cand.video.id);
    const { entry, video } = cand;
    const row = {
      start, end, type: entry.type, meta_id: entry.id,
      video_id: video ? video.id : entry.id,
      title: entry.name,
      episode_title: video ? video.title : '',
      season: video ? video.season : null,
      episode: video ? video.episode : null,
      poster: entry.poster || '',
      background: (video && video.thumbnail) || entry.background || '',
      description: (video && video.overview) || entry.description || '',
      origin, truncated: truncated ? 1 : 0, cursor_prev: prev,
    };
    this.rows.push(row);
    this.recent.unshift(entry.id);
    return row;
  }

  /**
   * Fill [from, to) from a pool. `to` may be Infinity (no hard stop) together with a `horizon`.
   * `filler` ({titles, mode}) tops up the end of a block when nothing from `titles` fits any more.
   * Returns the time the block actually ended.
   */
  fill(titles, mode, from, to, origin, poolKey, horizon = to, filler = null) {
    let t = from;
    while (t < to && t < horizon) {
      const remaining = to - t;
      const cand = this.pickFrom(titles, mode, remaining, poolKey);
      if (!cand) return t;
      const alt = cand.duration > remaining && remaining > ABSORB_GAP && filler?.titles.length
        ? this.pickFrom(filler.titles, filler.mode, remaining, 'pool') : null;
      if (cand.duration <= remaining) {
        this.commit(cand, t, t + cand.duration, origin, poolKey);
        t += cand.duration;
      } else if (remaining <= ABSORB_GAP && this.previousRow()?.end === t) {
        this.previousRow().end = to;
        t = to;
      } else if (alt && alt.duration <= remaining) {
        this.commit(alt, t, t + alt.duration, 'fill', 'pool');
        t += alt.duration;
      } else if (alt && alt.duration < cand.duration) {
        // Nothing fits: cutting a short filler episode beats cutting a movie.
        this.commit(alt, t, to, 'fill', 'pool');
        t = to;
      } else {
        this.commit(cand, t, to, origin, poolKey);
        t = to;
      }
    }
    return t;
  }
}

// ---------------------------------------------------------------------------
// Building the guide

const building = new Map();

/** Extend (or rebuild, with `rebuild: true`) a channel's guide out to the horizon. */
export function buildChannel(channelId, opts = {}) {
  const key = Number(channelId);
  const prev = building.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(() => doBuild(key, opts));
  building.set(key, next);
  return next.finally(() => { if (building.get(key) === next) building.delete(key); });
}

async function doBuild(channelId, { rebuild = false, now = Date.now() } = {}) {
  const channel = store.getChannel(channelId);
  if (!channel) return;
  const zone = store.getSettings().timezone || config.timezone;
  const horizon = now + config.horizonHours * HOUR;

  const sources = store.listSources(channelId);
  const slots = store.listSlots(channelId);

  // Gather every title needed by the pool and by slots.
  const poolTitles = [];
  for (const s of sources) poolTitles.push(...await titlesFor(s));
  const slotTitles = new Map();
  for (const slot of slots) {
    const spec = slot.content;
    if (spec.kind === 'pool') continue;
    slotTitles.set(slot.id, await titlesFor(spec));
  }
  const lib = await loadLibrary([...poolTitles, ...[...slotTitles.values()].flat()], channel);

  store.tx(() => {
    if (rebuild) {
      // Keep whatever is on air right now; rewind cursors moved by the rows we drop.
      const dropped = store.all('SELECT * FROM epg WHERE channel_id = ? AND start > ? ORDER BY start', channelId, now);
      const restore = {};
      for (const r of dropped) for (const [k, v] of Object.entries(r.cursor_prev)) if (!(k in restore)) restore[k] = v;
      for (const [k, v] of Object.entries(restore)) {
        if (v === null) store.run('DELETE FROM cursors WHERE channel_id = ? AND key = ?', channelId, k);
        else store.run('INSERT INTO cursors(channel_id, key, value) VALUES (?, ?, ?) ON CONFLICT(channel_id, key) DO UPDATE SET value = excluded.value', channelId, k, v);
      }
      store.run('DELETE FROM epg WHERE channel_id = ? AND start > ?', channelId, now);
    }
    // Prune old history.
    store.run('DELETE FROM epg WHERE channel_id = ? AND end < ?', channelId, now - 48 * HOUR);

    const last = store.epgLast(channelId);
    let t;
    if (last && last.end > now) t = last.end;
    else t = DateTime.fromMillis(now, { zone }).startOf('hour').plus({ minutes: DateTime.fromMillis(now, { zone }).minute >= 30 ? 30 : 0 }).toMillis();
    if (t >= horizon) return;

    const recent = store.recentEpg(channelId, 20).map((r) => r.meta_id);
    const planner = new Planner(channel, lib, store.getCursors(channelId), recent);
    const lastSaved = store.epgLast(channelId);
    if (lastSaved && lastSaved.end === t) planner.prevSaved = { ...lastSaved };
    const occs = slotOccurrences(slots, t, horizon, zone);
    const poolMode = channel.fill_mode;

    let guard = 0;
    while (t < horizon && guard++ < 10000) {
      const occ = occs.find((o) => o.end > t);
      if (occ && occ.start <= t) {
        const spec = occ.slot.content;
        const titles = spec.kind === 'pool' ? poolTitles : slotTitles.get(occ.slot.id) || [];
        const mode = spec.kind === 'pool' ? poolMode : occ.slot.play_order === 'random' ? 'random' : 'sequential';
        const poolKey = spec.kind === 'pool' ? 'pool' : `slot:${occ.slot.id}`;
        const filler = spec.kind === 'pool' ? null : { titles: poolTitles, mode: poolMode };
        const end = planner.fill(titles, mode, t, occ.end, 'slot', poolKey, occ.end, filler);
        t = end < occ.end ? occ.end : end; // empty slot -> dead air for its duration
      } else {
        const hardEnd = occ ? occ.start : Infinity;
        const end = planner.fill(poolTitles, poolMode, t, hardEnd, 'fill', 'pool', horizon);
        if (end === t) {
          // Nothing to play: skip ahead to the next slot (or stop).
          if (!occ) break;
          t = occ.start;
        } else t = end;
      }
    }

    const ins = store.db.prepare(`INSERT INTO epg(channel_id, start, end, type, meta_id, video_id, title, episode_title, season, episode, poster, background, description, origin, truncated, cursor_prev)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const r of planner.rows) {
      ins.run(channelId, r.start, r.end, r.type, r.meta_id, r.video_id, r.title, r.episode_title, r.season, r.episode,
        r.poster, r.background, r.description, r.origin, r.truncated, JSON.stringify(r.cursor_prev));
    }
    if (planner.prevSaved && planner.prevSaved.end !== lastSaved.end) {
      store.run('UPDATE epg SET end = ? WHERE id = ?', planner.prevSaved.end, lastSaved.id);
    }
    const up = store.db.prepare('INSERT INTO cursors(channel_id, key, value) VALUES (?, ?, ?) ON CONFLICT(channel_id, key) DO UPDATE SET value = excluded.value');
    for (const [k, v] of Object.entries(planner.cursors)) if (v != null) up.run(channelId, k, String(v));
    if (planner.rows.length) log.info(`channel ${channel.number} "${channel.name}": scheduled ${planner.rows.length} items`);
  });
}

export async function buildAll(opts) {
  for (const ch of store.listChannels()) {
    try {
      await buildChannel(ch.id, opts);
    } catch (e) {
      log.error(`schedule build failed for channel ${ch.id}:`, e);
    }
  }
}

let timer;
export function startScheduler() {
  buildAll();
  timer = setInterval(() => buildAll(), 15 * MIN);
  timer.unref?.();
}

/** Human label like "Modern Family S01E05 · Coal Digger". */
export function itemLabel(r) {
  if (!r) return '';
  if (r.type === 'series' && r.season != null) {
    const se = `S${String(r.season).padStart(2, '0')}E${String(r.episode).padStart(2, '0')}`;
    return `${r.title} ${se}${r.episode_title ? ` · ${r.episode_title}` : ''}`;
  }
  return r.title;
}
