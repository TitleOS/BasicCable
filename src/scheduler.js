import { DateTime } from 'luxon';
import { store } from './db.js';
import { config, log } from './config.js';
import { getMeta, playableEpisodes, expandWildcard, episodeRuntime } from './metadata.js';
import { lastShown, noRepeatDays } from './history.js';
import { breakAllowance } from './commercials.js';
import { utilityOf, utilityRows } from './utilities.js';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
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
      const runtime = episodeRuntime(meta) || DEFAULT_RUNTIME[t.type] || 30;
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

// Episodes/movies no stream addon could play recently. The planner steps over them; they get another
// chance once the entry expires (debrid caches change).
const UNPLAYABLE_MS = 6 * HOUR;
const unplayable = new Map(); // video id -> expiry

export function markUnplayable(videoId, ms = UNPLAYABLE_MS) {
  unplayable.set(videoId, Date.now() + ms);
}

export function isUnplayable(videoId) {
  const until = unplayable.get(videoId);
  if (until && until < Date.now()) unplayable.delete(videoId);
  return !!until && until >= Date.now();
}

function roundUp(minutes, step) {
  if (!step || step <= 1) return minutes;
  return Math.ceil(minutes / step) * step;
}

/**
 * Builds guide rows. `cursors` maps cursor keys to values and is mutated as items are scheduled;
 * each row records the previous values of cursors it moved so a rebuild can rewind them exactly.
 */
class Planner {
  constructor(channel, lib, cursors, recent, shown = new Map(), noRepeatMs = 0) {
    this.channel = channel;
    this.lib = lib;
    this.cursors = cursors;
    this.recent = recent; // recently scheduled meta ids/video ids, newest first
    this.shown = shown; // video id -> when it last aired (or is planned to) in full
    this.noRepeatMs = noRepeatMs;
    this.rows = [];
  }

  /** Skipped for now as unplayable, unless everything is (then the guide still gets filled; see pickFrom). */
  blocked(videoId) {
    return !this.allowUnplayable && isUnplayable(videoId);
  }

  /** True if this video aired (or is planned) within the channel's no-repeat window of `at`. */
  isRepeat(videoId, at) {
    if (!this.noRepeatMs) return false;
    const last = this.shown.get(videoId);
    return last != null && Math.abs(at - last) < this.noRepeatMs;
  }

  /** The row that ends where planning continues: the last planned row, or the last saved one. */
  previousRow() {
    return this.rows[this.rows.length - 1] || this.prevSaved;
  }

  /** Guide time for a title: its runtime plus room for the commercial break after it, rounded up. */
  durationOf(entry) {
    return roundUp(entry.runtime + breakAllowance(this.channel) / 60, this.channel.round_minutes) * MIN;
  }

  /**
   * Next episode of a show according to its per-channel cursor (wraps around at the end), stepping over
   * episodes with no playable stream and episodes shown within the no-repeat window. When every playable
   * episode is a repeat, the one shown longest ago, flagged `repeat`. Null when nothing can be played now.
   */
  nextEpisode(entry, order, at) {
    const eps = entry.episodes;
    let ok;
    if (order === 'random') {
      ok = eps.filter((e) => !this.blocked(e.id));
      const fresh = ok.filter((e) => !this.isRepeat(e.id, at));
      if (fresh.length) return { ep: fresh[Math.floor(Math.random() * fresh.length)], repeat: false };
    } else {
      const last = this.cursors[`ep:${entry.id}`];
      const idx = last ? eps.findIndex((e) => e.id === last) : -1;
      ok = [];
      for (let i = 1; i <= eps.length; i++) {
        const ep = eps[(idx + i) % eps.length];
        if (this.blocked(ep.id)) continue;
        if (!this.isRepeat(ep.id, at)) return { ep, repeat: false };
        ok.push(ep);
      }
    }
    if (!ok.length) return null;
    const oldest = ok.reduce((a, b) => ((this.shown.get(b.id) ?? 0) < (this.shown.get(a.id) ?? 0) ? b : a));
    return { ep: oldest, repeat: true };
  }

  /** Candidate item for a title, without committing cursors. Null if nothing of it is playable. */
  candidate(entry, order, at) {
    if (entry.type === 'series') {
      const next = this.nextEpisode(entry, order, at);
      return next ? { entry, video: next.ep, duration: this.durationOf(entry), repeat: next.repeat, lastShown: this.shown.get(next.ep.id) ?? 0 } : null;
    }
    if (this.blocked(entry.id)) return null;
    return { entry, video: null, duration: this.durationOf(entry), repeat: this.isRepeat(entry.id, at), lastShown: this.shown.get(entry.id) ?? 0 };
  }

  /** Choose from several titles to start at `at`. mode: shuffle | sequential | random */
  pickFrom(titles, mode, remaining, poolKey, at) {
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
    let cands = ordered.map((e) => this.candidate(e, order, at)).filter(Boolean);
    if (!cands.length) {
      // Everything failed recently (usually an addon outage): schedule anyway rather than leave the channel
      // with nothing on. The runner keeps retrying, and plays it once streams come back.
      this.allowUnplayable = true;
      cands = ordered.map((e) => this.candidate(e, order, at)).filter(Boolean);
      this.allowUnplayable = false;
    }
    if (!cands.length) return null;
    // Repeats only when everything is one, and then whatever was shown longest ago.
    const fresh = cands.filter((c) => !c.repeat);
    cands = fresh.length ? fresh : cands.sort((a, b) => a.lastShown - b.lastShown);
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
    if (!truncated) this.shown.set(row.video_id, start);
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
      const cand = this.pickFrom(titles, mode, remaining, poolKey, t);
      if (!cand) return t;
      const alt = cand.duration > remaining && remaining > ABSORB_GAP && filler?.titles.length
        ? this.pickFrom(filler.titles, filler.mode, remaining, 'pool', t) : null;
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

/** Minutes of programs a channel can play (its pool and slots, every episode once), from cached metadata. */
export async function contentMinutes(channelId) {
  const channel = store.getChannel(channelId);
  if (!channel) return 0;
  const titles = [];
  for (const s of store.listSources(channelId)) titles.push(...await titlesFor(s));
  for (const slot of store.listSlots(channelId)) if (slot.content.kind !== 'pool') titles.push(...await titlesFor(slot.content));
  const lib = await loadLibrary(titles, channel);
  let minutes = 0;
  for (const e of lib.values()) minutes += (e.type === 'series' ? e.episodes.length : 1) * e.runtime;
  return minutes;
}

/** Extend (or rebuild, with `rebuild: true`) a channel's guide out to the horizon. */
export function buildChannel(channelId, opts = {}) {
  const key = Number(channelId);
  const prev = building.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(() => (opts.retime ? doRetime(key, opts.retime) : doBuild(key, opts)));
  building.set(key, next);
  return next.finally(() => { if (building.get(key) === next) building.delete(key); });
}

/**
 * Make the guide follow the stream: move guide row `itemId` to start at `start` (an earlier file ran short, a
 * break was shorter than planned, a file is longer than its slot...). Everything after it moves by the same
 * amount and the program before it now ends at `start`; what plays, and in what order, doesn't change.
 * Weekly time slots stay put: rows from the next slot start on don't move, and the last row before it runs on
 * to the slot. Resolves to true when the guide moved, false when there was nothing to do, or 'conflict' when a
 * later start would push programs into a time slot (callers then replan instead).
 */
export function retimeFrom(channelId, itemId, start) {
  return buildChannel(channelId, { retime: { id: Number(itemId), start: Math.round(start) } });
}

function doRetime(channelId, { id, start }) {
  const row = store.get('SELECT * FROM epg WHERE id = ? AND channel_id = ?', id, channelId);
  if (!row) return false;
  const delta = start - row.start; // negative: earlier
  if (Math.abs(delta) < 1000) return false;
  const prev = store.get('SELECT * FROM epg WHERE channel_id = ? AND end = ? AND start < ? ORDER BY start DESC LIMIT 1', channelId, row.start, row.start);
  if (prev && start <= prev.start) return false; // would swallow the program before it
  const zone = store.getSettings().timezone || config.timezone;
  const last = store.epgLast(channelId);
  const pin = slotOccurrences(store.listSlots(channelId), row.start + 1, (last?.end ?? row.end) + DAY, zone)
    .map((o) => o.start).find((s) => s > row.start) ?? Infinity;
  const moving = store.all('SELECT id, start, end FROM epg WHERE channel_id = ? AND start >= ? AND start < ? ORDER BY start', channelId, row.start, pin);
  const lastMoving = moving[moving.length - 1];
  if (delta > 0 && pin !== Infinity && lastMoving && lastMoving.end + delta > pin) return 'conflict';
  store.tx(() => {
    if (prev) store.run('UPDATE epg SET end = ? WHERE id = ?', start, prev.id);
    store.run('UPDATE epg SET start = start + ?, end = end + ? WHERE channel_id = ? AND start >= ? AND start < ?', delta, delta, channelId, row.start, pin);
    // Pulled away from a time slot: the program before the slot runs on to it, as the planner would have done.
    if (delta < 0 && pin !== Infinity && lastMoving) store.run('UPDATE epg SET end = ? WHERE id = ?', pin, lastMoving.id);
  });
  return true;
}

/**
 * Stretch an item that hasn't started yet to the real length of the file picked for it (e.g. an extended
 * "Superfan" cut), then replan everything after it. Returns false if the item is gone or already on air.
 */
export function extendItem(channelId, itemId, newEnd) {
  return buildChannel(channelId, { rebuild: true, extend: { id: Number(itemId), end: newEnd } });
}

/**
 * Swap a guide item for something else, chosen by the channel's usual rules (mark its video unplayable
 * first so it isn't picked again). An upcoming item is replaced outright; one already on air is cut off now
 * and the replacement starts immediately. Returns false if the item is gone or already over.
 */
export function replaceItem(channelId, itemId, { now = Date.now() } = {}) {
  return buildChannel(channelId, { rebuild: true, now, replace: { id: Number(itemId) } });
}

async function doBuild(channelId, { rebuild = false, now = Date.now(), extend = null, replace = null } = {}) {
  const channel = store.getChannel(channelId);
  if (!channel) return;
  const zone = store.getSettings().timezone || config.timezone;
  const horizon = now + config.horizonHours * HOUR;

  // Generated channels (the weather...) have no titles: their guide is hourly blocks out to the horizon.
  if (utilityOf(channel)) {
    return store.tx(() => {
      if (rebuild) store.run('DELETE FROM epg WHERE channel_id = ? AND start > ?', channelId, now);
      store.run('DELETE FROM epg WHERE channel_id = ? AND end < ?', channelId, now - 48 * HOUR);
      const last = store.epgLast(channelId);
      const t = last && last.end > now ? last.end : Math.max(DateTime.fromMillis(now, { zone }).startOf('hour').toMillis(), last?.end ?? 0);
      if (t >= horizon) return true;
      const ins = store.db.prepare(`INSERT INTO epg(channel_id, start, end, type, meta_id, video_id, title, episode_title, season, episode, poster, background, description, origin, truncated, cursor_prev)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const r of utilityRows(channel, t, horizon, zone)) {
        ins.run(channelId, r.start, r.end, r.type, r.meta_id, r.video_id, r.title, r.episode_title, r.season, r.episode, r.poster, r.background, r.description, r.origin, r.truncated, '{}');
      }
      return true;
    });
  }

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

  return store.tx(() => {
    // Normally everything after "now" is replanned; when extending an item, everything after that item.
    let cutoff = now;
    if (extend) {
      const row = store.get('SELECT * FROM epg WHERE id = ? AND channel_id = ?', extend.id, channelId);
      if (!row || row.start <= now || extend.end <= row.end) return false;
      cutoff = row.start;
      store.run('UPDATE epg SET end = ?, truncated = 0 WHERE id = ?', extend.end, row.id);
    }
    let resumeAt = null;
    if (replace) {
      const row = store.get('SELECT * FROM epg WHERE id = ? AND channel_id = ?', replace.id, channelId);
      if (!row || row.end <= now) return false;
      if (row.start > now) {
        cutoff = row.start - 1; // drop the item itself and plan again from its start
        resumeAt = row.start;
      } else {
        store.run('UPDATE epg SET end = ?, truncated = 1 WHERE id = ?', now, row.id);
        cutoff = row.start;
        resumeAt = now;
      }
    }
    if (rebuild) {
      // Keep whatever is on air right now; rewind cursors moved by the rows we drop.
      const dropped = store.all('SELECT * FROM epg WHERE channel_id = ? AND start > ? ORDER BY start', channelId, cutoff);
      const restore = {};
      for (const r of dropped) for (const [k, v] of Object.entries(r.cursor_prev)) if (!(k in restore)) restore[k] = v;
      for (const [k, v] of Object.entries(restore)) {
        if (v === null) store.run('DELETE FROM cursors WHERE channel_id = ? AND key = ?', channelId, k);
        else store.run('INSERT INTO cursors(channel_id, key, value) VALUES (?, ?, ?) ON CONFLICT(channel_id, key) DO UPDATE SET value = excluded.value', channelId, k, v);
      }
      store.run('DELETE FROM epg WHERE channel_id = ? AND start > ?', channelId, cutoff);
    }
    // Prune old history.
    store.run('DELETE FROM epg WHERE channel_id = ? AND end < ?', channelId, now - 48 * HOUR);

    const last = store.epgLast(channelId);
    let t;
    if (resumeAt != null) t = resumeAt;
    else if (last && last.end > now) t = last.end;
    else {
      // Start on the half hour before now, but never before the last row ends (an on-air item that was cut short
      // with nothing to replace it), or the new rows would overlap it.
      const halfHour = DateTime.fromMillis(now, { zone }).startOf('hour').plus({ minutes: DateTime.fromMillis(now, { zone }).minute >= 30 ? 30 : 0 }).toMillis();
      t = Math.max(halfHour, last?.end ?? 0);
    }
    if (t >= horizon) return true;

    const recent = store.recentEpg(channelId, 20).map((r) => r.meta_id);
    const noRepeatMs = noRepeatDays(channel) * DAY;
    const shown = noRepeatMs ? lastShown(channelId, t - noRepeatMs) : new Map();
    const planner = new Planner(channel, lib, store.getCursors(channelId), recent, shown, noRepeatMs);
    const lastSaved = store.epgLast(channelId);
    if (lastSaved && lastSaved.end === t && !isUnplayable(lastSaved.video_id)) planner.prevSaved = { ...lastSaved };
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
    return true;
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
/**
 * The longest a guide item may be stretched to fit its file: three times the title's usual runtime or the
 * runtime plus 90 minutes, whichever is more. Cinemeta gives one runtime per series, so this has to leave room
 * for double-length premieres and finales (The Bad Batch's 71-minute first episode in a "25 min" show) and
 * extended cuts, while still catching what isn't one episode: whole-season files and broken length headers.
 * Measured from the runtime rather than the current slot, so repeated checks can't keep stretching it.
 */
export async function maxItemLength(item, channel) {
  let runtime = null;
  try {
    runtime = episodeRuntime(await getMeta(item.type, item.meta_id));
  } catch {
    return Infinity; // can't tell what's normal right now, so don't judge
  }
  runtime = runtime || DEFAULT_RUNTIME[item.type] || 30;
  const step = Math.max(1, channel.round_minutes || 1);
  return roundUp(Math.max(runtime * 3, runtime + 90) + breakAllowance(channel) / 60, step) * MIN;
}

export function itemLabel(r) {
  if (!r) return '';
  if (r.type === 'series' && r.season != null) {
    const se = `S${String(r.season).padStart(2, '0')}E${String(r.episode).padStart(2, '0')}`;
    return `${r.title} ${se}${r.episode_title ? ` · ${r.episode_title}` : ''}`;
  }
  return r.title;
}
