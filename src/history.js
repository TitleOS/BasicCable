// Recently shown: every episode and movie that aired on a channel, kept for 90 days after the guide itself is
// pruned. The scheduler reads it so a channel doesn't repeat something within its "no repeats" window.

import { store } from './db.js';
import { log } from './config.js';

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
export const KEEP_DAYS = 90;
// An item counts as shown once it has been on air this long (or for all of it, if it's shorter).
const ON_AIR = 5 * MIN;

/**
 * Copy guide items that have gone on air into the history. Re-running is safe: an item already recorded only
 * gets its end and "complete" flag refreshed (an item cut short after it started is no longer complete).
 * Items cut short don't count as shown, so they may air again; that's what the scheduler wants for them.
 */
export function recordAired(now = Date.now()) {
  const r = store.run(
    `INSERT INTO history(channel_id, aired_at, ended_at, type, meta_id, video_id, title, episode_title, season, episode, complete)
     SELECT e.channel_id, e.start, e.end, e.type, e.meta_id, e.video_id, e.title, e.episode_title, e.season, e.episode, 1 - e.truncated
     FROM epg e JOIN channels c ON c.id = e.channel_id
     WHERE c.enabled = 1 AND e.end - e.start >= ? AND e.start + MIN(?, e.end - e.start) <= ?
     ON CONFLICT(channel_id, video_id, aired_at) DO UPDATE SET ended_at = excluded.ended_at, complete = excluded.complete
     WHERE ended_at != excluded.ended_at OR complete != excluded.complete`,
    MIN, ON_AIR, now,
  );
  store.run('DELETE FROM history WHERE aired_at < ?', now - KEEP_DAYS * DAY);
  return Number(r.changes);
}

/** When each video last aired in full on a channel, counting from `since`: video id -> start time. */
export function lastShown(channelId, since) {
  const out = new Map();
  const rows = store.all(
    `SELECT video_id, MAX(at) AS at FROM (
       SELECT video_id, aired_at AS at FROM history WHERE channel_id = ? AND complete = 1 AND aired_at >= ?
       UNION ALL
       SELECT video_id, start AS at FROM epg WHERE channel_id = ? AND truncated = 0 AND start >= ?
     ) GROUP BY video_id`,
    Number(channelId), since, Number(channelId), since,
  );
  for (const r of rows) out.set(r.video_id, r.at);
  return out;
}

/** A channel's history, newest first. */
export function recentlyShown(channelId, { days = 7, limit = 200, now = Date.now() } = {}) {
  return store.all('SELECT * FROM history WHERE channel_id = ? AND aired_at >= ? AND aired_at <= ? ORDER BY aired_at DESC LIMIT ?',
    Number(channelId), now - days * DAY, now, limit);
}

/** The channel's "don't repeat within N days" setting; 3 days unless set (0 turns it off). */
export function noRepeatDays(channel) {
  const d = Number(channel.options?.noRepeatDays);
  return Number.isFinite(d) && d >= 0 ? d : 3;
}

let timer;
export function startHistory() {
  const tick = () => {
    try { recordAired(); } catch (e) { log.error('recording aired items failed:', e); }
  };
  tick();
  timer = setInterval(tick, MIN);
  timer.unref?.();
}
