// Getting a stream ready before anyone tunes in: ask the stream addons, rank the results and probe the
// winner ahead of time, so tuning in only has to start ffmpeg.

import { store } from './db.js';
import { log } from './config.js';
import { findStreams, forgetStream } from './picker.js';
import { probe } from './probe.js';
import { extendItem, replaceItem, retimeFrom, markUnplayable, maxItemLength, itemLabel } from './scheduler.js';
import { breakAllowance } from './commercials.js';

const READY_MS = 2 * 3600 * 1000; // debrid links stay valid for hours; re-check after this
const RETRY_MS = 5 * 60 * 1000; // after finding nothing playable, wait before asking the addons again
const FIT_TOLERANCE_MS = 5000; // guide slots within this of the real length are left alone

const ready = new Map(); // `${channelId}|${video_id}` -> { at, cand, info } or { at, failed: true }
const inflight = new Map(); // same key -> Promise while a lookup is running

const keyOf = (item, channel) => `${channel.id}|${item.video_id}`;

function fresh(entry) {
  return entry && Date.now() - entry.at < (entry.failed ? RETRY_MS : READY_MS);
}

/**
 * The stream to play for a guide item: the best-ranked candidate that actually probes, with its probe
 * result. Cached, and shared between the background prefetcher and a viewer tuning in at the same moment.
 * Resolves to null when nothing playable was found.
 */
export function prepareStream(item, channel) {
  const key = keyOf(item, channel);
  const hit = ready.get(key);
  if (fresh(hit)) return Promise.resolve(hit.failed ? null : hit);
  if (inflight.has(key)) return inflight.get(key);
  const job = (async () => {
    const candidates = await findStreams(item, channel);
    for (const cand of candidates.slice(0, 5)) {
      const info = await probe(cand.url, cand.headers);
      if (!info) {
        log.info(`channel ${channel.number}: stream did not probe, trying next (${cand.label.slice(0, 80)})`);
        forgetStream(item, channel, cand.url);
        continue;
      }
      if (info.duration && info.duration < 90 && item.end - item.start > 5 * 60000) {
        // Debrid "downloading" placeholder clips are short; skip them.
        forgetStream(item, channel, cand.url);
        continue;
      }
      const prepared = { at: Date.now(), cand, info };
      ready.set(key, prepared);
      return prepared;
    }
    ready.set(key, { at: Date.now(), failed: true });
    return null;
  })().finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

/** A prepared stream failed to play: forget it so the next call picks another candidate. */
export function dropPrepared(item, channel, url) {
  const key = keyOf(item, channel);
  if (ready.get(key)?.cand?.url === url) ready.delete(key);
  forgetStream(item, channel, url);
}

/** Channel settings changed: what was picked before may no longer be what would be picked now. */
export function clearPrepared(channelId = null) {
  for (const key of ready.keys()) if (channelId == null || key.startsWith(`${channelId}|`)) ready.delete(key);
}

export function preparedFor(item, channel) {
  const hit = ready.get(keyOf(item, channel));
  return fresh(hit) && !hit.failed ? hit : null;
}

/**
 * The guide uses the title's typical runtime. When the picked file is clearly longer (extended cuts such as
 * The Office "Superfan" episodes), give the item its real length so it isn't cut off, and push the rest of
 * the guide back. Only for items that haven't started yet.
 */
async function fitGuideToFile(item, channel, info) {
  if (!info.duration || item.start <= Date.now()) return;
  const scheduled = item.end - item.start;
  // The file plus the commercial break that follows it, to the second: the guide shows what will really air.
  const actual = Math.ceil(info.duration + breakAllowance(channel)) * 1000;
  if (Math.abs(actual - scheduled) < FIT_TOLERANCE_MS) return;
  if (actual > scheduled && actual > await maxItemLength(item, channel)) {
    log.info(`channel ${channel.number}: ${itemLabel(item)} reports ${Math.round(actual / 60000)} min, far past its usual runtime; ` +
      'keeping its guide slot');
    return;
  }
  if (actual < scheduled / 2) return; // a length header that can't be right; don't cut the program off
  const newEnd = item.start + actual;
  const next = store.epgAfter(channel.id, item.start);
  let moved = next && next.start === item.end ? await retimeFrom(channel.id, next.id, newEnd) : false;
  // Longer, and the shift would run into a time slot (or nothing follows yet): replan after it instead.
  if (moved !== true && actual > scheduled) moved = await extendItem(channel.id, item.id, newEnd);
  if (moved === true) {
    log.info(`channel ${channel.number}: ${itemLabel(item)} runs ${(actual / 60000).toFixed(1)} min, ` +
      `${actual > scheduled ? 'lengthened' : 'shortened'} its guide slot from ${(scheduled / 60000).toFixed(1)} min`);
  }
}

// Space addon lookups out by a random 3-30 s so a batch of channels doesn't trip addon rate limits.
// Applies across ticks; a viewer tuning in never waits for it.
const STAGGER_MIN_MS = 3000;
const STAGGER_MAX_MS = 30000;
export const staggerDelay = (rand = Math.random()) => Math.round(STAGGER_MIN_MS + rand * (STAGGER_MAX_MS - STAGGER_MIN_MS));
let nextLookupAt = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * No addon has a playable stream for this item: put something else in its place, picked by the channel's
 * usual rules (next episode in order, a random one, another title...). Returns the replacement or null.
 */
export async function skipUnplayable(item, channel, { at = Date.now() } = {}) {
  markUnplayable(item.video_id);
  const now = at; // the channel's own position (its stream can run ahead of the wall clock)
  if (!(await replaceItem(channel.id, item.id, { now }))) return null;
  const replacement = item.start > now
    ? store.get('SELECT * FROM epg WHERE channel_id = ? AND start = ?', channel.id, item.start)
    : store.epgAt(channel.id, now);
  log.info(`channel ${channel.number}: no playable stream for ${itemLabel(item)}, ` +
    (replacement ? `${item.start > now ? 'scheduled' : 'switched to'} ${itemLabel(replacement)} instead` : 'and nothing else to put in its place'));
  return replacement;
}

let busy = false;

/** Every minute, prepare whatever is on now or starts within the lead time, on every enabled channel. */
async function tick() {
  if (busy) return;
  busy = true;
  try {
    const lead = Number(store.getSettings().prefetchMinutes ?? 10) * 60000;
    if (lead <= 0) return;
    const now = Date.now();
    for (const channel of store.listChannels().filter((c) => c.enabled)) {
      const items = store.all('SELECT * FROM epg WHERE channel_id = ? AND end > ? AND start <= ? ORDER BY start', channel.id, now, now + lead);
      for (const listed of items) {
        // Follow replacements: when an item has nothing playable, check what took its place right away
        // (after the usual spacing), so a run of bad episodes is skipped in one pass.
        let id = listed.id;
        for (let tries = 0; id && tries < 6; tries++) {
          if (fresh(ready.get(keyOf(listed, channel))) && tries === 0) break;
          const wait = nextLookupAt - Date.now();
          if (wait > 0) await sleep(wait);
          // While we waited, a viewer may have prepared it, or the guide may have been replanned.
          const item = store.get('SELECT * FROM epg WHERE id = ?', id);
          if (!item || item.end <= Date.now() || fresh(ready.get(keyOf(item, channel)))) break;
          const t0 = Date.now();
          let prep = null;
          try {
            prep = await prepareStream(item, channel);
          } catch (e) {
            log.warn(`prefetch: channel ${channel.number}: ${e.message}`);
            break;
          } finally {
            nextLookupAt = Date.now() + staggerDelay();
          }
          if (!prep) {
            id = (await skipUnplayable(item, channel))?.id;
            continue;
          }
          log.info(`prefetch: channel ${channel.number}: ${itemLabel(item)} ready in ${((Date.now() - t0) / 1000).toFixed(1)}s ` +
            `(${prep.info.video?.height || '?'}p, ${prep.info.duration ? Math.round(prep.info.duration / 60) + ' min' : 'unknown length'})`);
          await fitGuideToFile(item, channel, prep.info);
          break;
        }
      }
    }
  } catch (e) {
    log.error('prefetch failed:', e);
  } finally {
    busy = false;
  }
}

export function startPrefetcher() {
  setTimeout(tick, 5000).unref?.();
  setInterval(tick, 60000).unref?.();
}
