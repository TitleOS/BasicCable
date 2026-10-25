import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DateTime } from 'luxon';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'st-sched-'));
process.env.TZ = 'America/New_York';
const { store } = await import('../src/db.js');
const { buildChannel, slotOccurrences, extendItem, replaceItem, markUnplayable, isUnplayable } = await import('../src/scheduler.js');
const { globToRegExp, parseRuntime, playableEpisodes } = await import('../src/metadata.js');

const ZONE = 'America/New_York';
store.saveSettings({ timezone: ZONE });

// Seed the metadata cache so no network is needed.
function seedSeries(id, name, runtime, seasons, perSeason) {
  const videos = [];
  for (let se = 1; se <= seasons; se++) {
    for (let ep = 1; ep <= perSeason; ep++) videos.push({ id: `${id}:${se}:${ep}`, season: se, episode: ep, title: `${name} ${se}x${ep}`, released: '2010-01-01T00:00:00Z' });
  }
  videos.push({ id: `${id}:0:1`, season: 0, episode: 1, title: 'Special', released: '2010-01-01T00:00:00Z' });
  videos.push({ id: `${id}:9:1`, season: 9, episode: 1, title: 'Future', released: '2099-01-01T00:00:00Z' });
  store.cacheSet(`meta:series:${id}`, { id, type: 'series', name, poster: '', background: '', description: '', runtime, videos });
}
seedSeries('tt001', 'Sitcom', 21, 2, 10);
seedSeries('tt002', 'Drama', 44, 3, 8);

const HOUR = 3600e3;

function assertContiguous(rows) {
  for (let i = 1; i < rows.length; i++) {
    assert.equal(rows[i].start, rows[i - 1].end, `gap/overlap before ${rows[i].video_id}`);
  }
}

test('helpers', () => {
  assert.equal(parseRuntime('21 min'), 21);
  assert.equal(parseRuntime('1h 30min'), 90);
  assert.equal(parseRuntime('2 h'), 120);
  const re = globToRegExp('Star Trek*');
  assert.ok(re.test('Star Trek: Voyager'));
  assert.ok(re.test('star trek'));
  assert.ok(!re.test('The Star Trek Story'));
  const eps = playableEpisodes({ videos: [
    { id: 'a:1:2', season: 1, episode: 2 }, { id: 'a:1:1', season: 1, episode: 1 }, { id: 'a:0:1', season: 0, episode: 1 },
  ] });
  assert.deepEqual(eps.map((e) => e.id), ['a:1:1', 'a:1:2']);
});

test('slot occurrences follow the configured timezone', () => {
  const from = DateTime.fromISO('2026-10-12T00:00', { zone: ZONE }).toMillis(); // a Monday
  const occ = slotOccurrences([{ id: 1, days: '1,3', start: '20:00', minutes: 60 }], from, from + 7 * 24 * HOUR, ZONE);
  assert.deepEqual(occ.map((o) => DateTime.fromMillis(o.start, { zone: ZONE }).toFormat('ccc HH:mm')), ['Mon 20:00', 'Wed 20:00']);
});

test('auto-fill plus a nightly slot builds a contiguous, ordered guide', async () => {
  const ch = store.createChannel({ name: 'Test', round_minutes: 5 });
  store.addSource(ch.id, { kind: 'series', ref: 'tt001', name: 'Sitcom' });
  store.addSlot(ch.id, { days: '1,2,3,4,5,6,7', start: '20:00', minutes: 90, content: { kind: 'series', ref: 'tt002', name: 'Drama' } });

  const now = DateTime.fromISO('2026-10-14T18:07', { zone: ZONE }).toMillis();
  await buildChannel(ch.id, { now });
  const rows = store.epgRange(ch.id, 0, Infinity);
  assert.ok(rows.length > 20);
  assertContiguous(rows);

  // Guide starts on the half hour before "now".
  assert.equal(DateTime.fromMillis(rows[0].start, { zone: ZONE }).toFormat('HH:mm'), '18:00');
  // Sitcom: 21 min rounded to 25, episodes in order, no specials or unreleased episodes.
  const sitcom = rows.filter((r) => r.meta_id === 'tt001');
  assert.equal(sitcom[0].video_id, 'tt001:1:1');
  assert.equal(sitcom[1].video_id, 'tt001:1:2');
  assert.ok(sitcom.every((r) => r.season >= 1 && r.season <= 2));
  assert.equal(sitcom[0].end - sitcom[0].start, 25 * 60e3);

  // Every 20:00 starts the Drama slot, which fits two 45-minute episodes exactly.
  const slotStarts = rows.filter((r) => DateTime.fromMillis(r.start, { zone: ZONE }).toFormat('HH:mm') === '20:00');
  assert.ok(slotStarts.length >= 2);
  for (const r of slotStarts) assert.equal(r.meta_id, 'tt002');
  const drama = rows.filter((r) => r.meta_id === 'tt002');
  assert.deepEqual(drama.slice(0, 4).map((r) => r.video_id), ['tt002:1:1', 'tt002:1:2', 'tt002:1:3', 'tt002:1:4']);
  // The fill block before 20:00 never runs into the slot.
  for (const r of rows) {
    const s = DateTime.fromMillis(r.start, { zone: ZONE });
    if (r.meta_id === 'tt001' && s.hour === 19) assert.ok(r.end <= s.set({ hour: 20, minute: 0 }).toMillis());
  }
});

test('rebuilding keeps the current item and rewinds episode cursors', async () => {
  const ch = store.createChannel({ name: 'Rewind', round_minutes: 5 });
  store.addSource(ch.id, { kind: 'series', ref: 'tt001', name: 'Sitcom' });
  const now = DateTime.fromISO('2026-10-14T10:00', { zone: ZONE }).toMillis();
  await buildChannel(ch.id, { now });
  const before = store.epgRange(ch.id, 0, Infinity);
  const later = now + 10 * 60e3;
  await buildChannel(ch.id, { now: later, rebuild: true });
  const after = store.epgRange(ch.id, 0, Infinity);
  assert.equal(after[0].id, before[0].id, 'on-air item survives');
  assert.deepEqual(after.slice(0, 10).map((r) => r.video_id), before.slice(0, 10).map((r) => r.video_id));
  assertContiguous(after);
});

test('extendItem gives an upcoming item its real length and pushes the rest of the guide back', async () => {
  const ch = store.createChannel({ name: 'Extend', round_minutes: 5 });
  store.addSource(ch.id, { kind: 'series', ref: 'tt001', name: 'Sitcom' });
  await buildChannel(ch.id);
  const now = Date.now();
  const before = store.epgRange(ch.id, now, Infinity);
  const target = before.find((r) => r.start > now);
  const onAir = store.epgAt(ch.id, now);
  // A 31-minute "Superfan" file in a 25-minute slot -> 35 minutes with 5-minute rounding.
  assert.equal(await extendItem(ch.id, target.id, target.start + 35 * 60e3), true);
  const after = store.epgRange(ch.id, 0, Infinity);
  const row = after.find((r) => r.id === target.id);
  assert.equal(row.end - row.start, 35 * 60e3);
  assertContiguous(after);
  // The next item now starts where the longer one ends, and continues the episode order.
  const nextRow = after[after.indexOf(row) + 1];
  assert.equal(nextRow.start, row.end);
  assert.equal(nextRow.video_id, before[before.indexOf(target) + 1].video_id);
  // Items already on air are never changed.
  if (onAir) assert.equal(await extendItem(ch.id, onAir.id, onAir.end + 10 * 60e3), false);
});

test('an unplayable upcoming episode is replaced by the next one in order, and the show carries on', async () => {
  const ch = store.createChannel({ name: 'Skip', round_minutes: 5, fill_mode: 'sequential' });
  store.addSource(ch.id, { kind: 'series', ref: 'tt002', name: 'Drama' });
  await buildChannel(ch.id);
  const now = Date.now();
  const before = store.epgRange(ch.id, now, Infinity);
  const target = before.find((r) => r.start > now);
  markUnplayable(target.video_id);
  assert.equal(await replaceItem(ch.id, target.id), true);
  const after = store.epgRange(ch.id, 0, Infinity);
  assertContiguous(after);
  const swapped = after.find((r) => r.start === target.start);
  assert.notEqual(swapped.video_id, target.video_id);
  // Same slot, now the episode that would have come next, and the order continues from there.
  assert.equal(swapped.video_id, before[before.indexOf(target) + 1].video_id);
  assert.ok(!after.some((r) => r.start >= target.start && r.video_id === target.video_id), 'bad episode not rescheduled');
});

test('an unplayable episode that is already on air is cut off now and replaced immediately', async () => {
  const ch = store.createChannel({ name: 'SkipNow', round_minutes: 5, fill_mode: 'random' });
  store.addSource(ch.id, { kind: 'series', ref: 'tt002', name: 'Drama' });
  await buildChannel(ch.id);
  const now = Date.now();
  const onAir = store.epgAt(ch.id, now);
  markUnplayable(onAir.video_id);
  assert.equal(await replaceItem(ch.id, onAir.id, { now }), true);
  const cut = store.get('SELECT * FROM epg WHERE id = ?', onAir.id);
  assert.equal(cut.end, now);
  const replacement = store.epgAt(ch.id, now);
  assert.equal(replacement.start, now);
  assert.notEqual(replacement.video_id, onAir.video_id);
  // Random mode never picks an unplayable episode again.
  const later = store.epgRange(ch.id, now, Infinity);
  assert.ok(!later.some((r) => r.video_id === onAir.video_id));
  assert.ok(isUnplayable(onAir.video_id));
});

test('maxItemLength allows double-length episodes and extended cuts but not whole seasons', async () => {
  const { maxItemLength } = await import('../src/scheduler.js');
  const ch = { round_minutes: 5 };
  // Sitcom, 21 min: runtime + 90 wins -> 111 -> rounded to 115.
  const sitcom = await maxItemLength({ type: 'series', meta_id: 'tt001' }, ch);
  assert.equal(sitcom, 115 * 60e3);
  assert.ok(71 * 60e3 < sitcom, 'a 71-minute premiere (The Bad Batch "Aftermath") fits');
  assert.ok(10 * 21 * 60e3 > sitcom, 'a whole season in one file does not');
  // Drama, 44 min: runtime + 90 -> 134 -> 135; a two-hour finale fits, an 8-episode season file doesn't.
  const drama = await maxItemLength({ type: 'series', meta_id: 'tt002' }, ch);
  assert.equal(drama, 135 * 60e3);
  assert.ok(8 * 44 * 60e3 > drama);
});

test('repairGuide skips an over-stretched on-air item and replans stretched upcoming ones', async () => {
  const { repairGuide } = await import('../src/repair.js');
  const ch = store.createChannel({ name: 'Repair', round_minutes: 5 });
  store.addSource(ch.id, { kind: 'series', ref: 'tt002', name: 'Drama' });
  await buildChannel(ch.id);
  const now = Date.now();
  const onAir = store.epgAt(ch.id, now);
  const upcoming = store.epgAfter(ch.id, onAir.start);
  // Simulate the old bug: the on-air item holds 9 hours, the next one 4.
  store.run('UPDATE epg SET end = ? WHERE id = ?', onAir.start + 9 * 3600e3, onAir.id);
  store.run('UPDATE epg SET start = ?, end = ? WHERE id = ?', onAir.start + 9 * 3600e3, onAir.start + 13 * 3600e3, upcoming.id);
  store.run('DELETE FROM epg WHERE channel_id = ? AND start > ? AND id != ?', ch.id, onAir.start, upcoming.id);
  const fixed = await repairGuide({ now });
  assert.ok(fixed.some((f) => /skipped/.test(f)), fixed.join('\n'));
  assert.equal(store.get('SELECT end FROM epg WHERE id = ?', onAir.id).end, now, 'on-air item is cut off now');
  const rows = store.epgRange(ch.id, now, Infinity).filter((r) => r.start >= now);
  assert.ok(rows.length > 5);
  for (const r of rows) assert.ok(r.end - r.start <= 135 * 60e3, `${r.video_id} is ${(r.end - r.start) / 60e3} min`);
  assertContiguous(rows);
  assert.deepEqual(await repairGuide(), [], 'second pass finds nothing');
});

test('a series runtime that is really the whole-series total is split per episode', async () => {
  const { episodeRuntime } = await import('../src/metadata.js');
  // Cinemeta lists Planet Earth as "538 min" for its 11 episodes.
  seedSeries('tt003', 'Nature Doc', 538, 1, 11);
  const meta = store.cacheGet('meta:series:tt003', 3600e3);
  // 538 min over the 12 regular-season videos seedSeries makes (11 plus one dated in the future) ≈ 45 per episode.
  assert.equal(episodeRuntime(meta), 45);
  assert.equal(episodeRuntime({ type: 'series', runtime: 44, videos: [] }), 44);
  assert.equal(episodeRuntime({ type: 'movie', runtime: 170 }), 170);
  const ch = store.createChannel({ name: 'Nature', round_minutes: 5 });
  store.addSource(ch.id, { kind: 'series', ref: 'tt003', name: 'Nature Doc' });
  await buildChannel(ch.id);
  const rows = store.epgRange(ch.id, Date.now(), Infinity);
  assert.ok(rows.every((r) => r.end - r.start <= 60 * 60e3), `slots: ${[...new Set(rows.map((r) => (r.end - r.start) / 60e3))]}`);
});

test('no-repeat window: nothing airs twice within the channel\'s window while something fresh is available', async () => {
  seedSeries('tt010', 'Tiny', 30, 1, 4); // 4 episodes
  seedSeries('tt011', 'Long', 30, 5, 10); // 50 episodes
  const ch = store.createChannel({ name: 'NoRepeat', round_minutes: 0, fill_mode: 'random', options: { noRepeatDays: 1 } });
  store.addSource(ch.id, { kind: 'series', ref: 'tt010', name: 'Tiny' });
  store.addSource(ch.id, { kind: 'series', ref: 'tt011', name: 'Long' });
  const now = DateTime.fromISO('2026-10-14T06:00', { zone: ZONE }).toMillis();
  await buildChannel(ch.id, { now });
  const rows = store.epgRange(ch.id, 0, Infinity);
  assert.ok(rows.length >= 90);
  const last = new Map();
  for (const r of rows) {
    if (last.has(r.video_id)) assert.ok(r.start - last.get(r.video_id) >= 24 * HOUR, `${r.video_id} repeated after ${(r.start - last.get(r.video_id)) / HOUR}h`);
    last.set(r.video_id, r.start);
  }
});

test('recently shown: aired items are recorded and block repeats on the next plan', async () => {
  const { recordAired, recentlyShown } = await import('../src/history.js');
  seedSeries('tt012', 'Trio', 30, 1, 3);
  const ch = store.createChannel({ name: 'History', round_minutes: 0, fill_mode: 'sequential' });
  store.addSource(ch.id, { kind: 'series', ref: 'tt012', name: 'Trio' });
  const day = DateTime.fromISO('2026-10-12T10:00', { zone: ZONE }).toMillis(); // Monday 10am
  // Monday 10am: S01E01 aired in full; 10:30 S01E02 was cut short after 10 minutes.
  const row = (video, start, end, truncated = 0) => store.run(
    `INSERT INTO epg(channel_id, start, end, type, meta_id, video_id, title, episode_title, season, episode, origin, truncated)
     VALUES (?, ?, ?, 'series', 'tt012', ?, 'Trio', '', 1, ?, 'fill', ?)`, ch.id, start, end, video, Number(video.split(':')[2]), truncated);
  row('tt012:1:1', day, day + 30 * 60e3);
  row('tt012:1:2', day + 30 * 60e3, day + 40 * 60e3, 1);
  recordAired(day + 60 * 60e3);
  const hist = recentlyShown(ch.id, { now: day + 60 * 60e3 });
  assert.deepEqual(hist.map((h) => [h.video_id, h.complete]), [['tt012:1:2', 0], ['tt012:1:1', 1]]);
  // Recording again changes nothing.
  assert.equal(recordAired(day + 60 * 60e3), 0);

  // Wednesday: the guide is gone (pruned), but the history remembers Monday. Default window: 3 days.
  store.run('DELETE FROM epg WHERE channel_id = ?', ch.id);
  const wed = day + 2 * 24 * HOUR;
  await buildChannel(ch.id, { now: wed });
  let rows = store.epgRange(ch.id, wed, wed + 6 * HOUR);
  assert.notEqual(rows[0].video_id, 'tt012:1:1', 'Monday\'s episode is not shown again on Wednesday');
  assert.ok(rows.some((r) => r.video_id === 'tt012:1:2'), 'the cut-short episode may air again');
  // With only three episodes something has to repeat eventually; it's whatever aired longest ago.
  assert.ok(rows.length > 3);

  // Thursday 10am onwards, Monday's episode is fair game again; with the window off it is right away.
  store.updateChannel(ch.id, { options: { noRepeatDays: 0 } });
  store.run('DELETE FROM epg WHERE channel_id = ?', ch.id);
  store.run('DELETE FROM cursors WHERE channel_id = ?', ch.id);
  await buildChannel(ch.id, { now: wed });
  rows = store.epgRange(ch.id, wed, wed + 6 * HOUR);
  assert.equal(rows[0].video_id, 'tt012:1:1');
});

test('commercial breaks get room in the guide after each program', async () => {
  const ads = await import('../src/commercials.js');
  seedSeries('tt020', 'Half Hour', 24, 1, 6);
  const plain = store.createChannel({ name: 'No Ads', round_minutes: 5 });
  const withAds = store.createChannel({ name: 'With Ads', round_minutes: 5, options: { commercialsPerBreak: 2, commercialBundles: ['Test Spots'] } });
  for (const ch of [plain, withAds]) store.addSource(ch.id, { kind: 'series', ref: 'tt020', name: 'Half Hour' });
  store.run(`INSERT INTO commercials(bundle, file, size, mtime, duration, status, added_at) VALUES ('Test Spots', 'a.mp4', 1, 1, 60, 'ready', 0), ('Test Spots', 'b.mp4', 1, 1, 60, 'ready', 0)`);
  ads._test.bump();
  const now = DateTime.fromISO('2026-10-14T09:00', { zone: ZONE }).toMillis();
  await buildChannel(plain.id, { now });
  await buildChannel(withAds.id, { now });
  const len = (id) => { const r = store.epgRange(id, now, Infinity)[0]; return (r.end - r.start) / 60e3; };
  assert.equal(len(plain.id), 25, '24 min rounded to 25');
  assert.equal(len(withAds.id), 30, '24 min + 2 × 1 min of commercials, rounded to 30');
});

test('a guide restarted after an on-air cut never overlaps the cut item', async () => {
  seedSeries('tt021', 'Cut', 30, 1, 5);
  const ch = store.createChannel({ name: 'Cut', round_minutes: 0 });
  store.addSource(ch.id, { kind: 'series', ref: 'tt021', name: 'Cut' });
  const halfHour = DateTime.fromISO('2026-10-14T13:00', { zone: ZONE }).toMillis();
  // 13:00 item cut at 13:04 with nothing after it; the guide is built again at 13:07.
  store.run(`INSERT INTO epg(channel_id, start, end, type, meta_id, video_id, title, origin, truncated) VALUES (?, ?, ?, 'series', 'tt021', 'tt021:1:1', 'Cut', 'fill', 1)`,
    ch.id, halfHour, halfHour + 4 * 60e3);
  await buildChannel(ch.id, { now: halfHour + 7 * 60e3 });
  const rows = store.epgRange(ch.id, 0, Infinity);
  assertContiguous(rows);
  assert.equal(rows[1].start, halfHour + 4 * 60e3);
});

test('the guide follows the stream: an early start moves everything after it, content unchanged', async () => {
  const { retimeFrom } = await import('../src/scheduler.js');
  seedSeries('tt030', 'Follow', 22, 2, 10);
  const ch = store.createChannel({ name: 'Follow', round_minutes: 5, fill_mode: 'sequential' });
  store.addSource(ch.id, { kind: 'series', ref: 'tt030', name: 'Follow' });
  const now = DateTime.fromISO('2026-10-21T00:00', { zone: ZONE }).toMillis();
  await buildChannel(ch.id, { now });
  const before = store.epgRange(ch.id, now, Infinity);
  const [a, b, c] = before;
  assert.equal(b.end - b.start, 25 * 60e3);
  // The file for "a" ended 3 minutes early: "b" really starts then.
  assert.equal(await retimeFrom(ch.id, b.id, b.start - 3 * 60e3), true);
  const after = store.epgRange(ch.id, now, Infinity);
  assertContiguous(after);
  assert.deepEqual(after.map((r) => r.video_id), before.map((r) => r.video_id), 'same programs, same order');
  assert.equal(after[0].end, a.end - 3 * 60e3, 'the previous program now ends when it really did');
  assert.equal(after[1].start, b.start - 3 * 60e3);
  assert.equal(after[2].start, c.start - 3 * 60e3);
  assert.equal(after.at(-1).end, before.at(-1).end - 3 * 60e3);
  // Nothing to do for a start within a second, or for a row that's gone.
  assert.equal(await retimeFrom(ch.id, after[1].id, after[1].start + 500), false);
  assert.equal(await retimeFrom(ch.id, 999999, now), false);
  // A later start works the same way (a longer file).
  assert.equal(await retimeFrom(ch.id, after[2].id, after[2].start + 90e3), true);
  const later = store.epgRange(ch.id, now, Infinity);
  assertContiguous(later);
  assert.equal(later[1].end - later[1].start, 25 * 60e3 + 90e3);
});

test('the guide follows the stream but weekly time slots stay where they are', async () => {
  const { retimeFrom } = await import('../src/scheduler.js');
  seedSeries('tt031', 'Filler', 22, 2, 10);
  seedSeries('tt032', 'Primetime', 44, 2, 10);
  const ch = store.createChannel({ name: 'Slotted', round_minutes: 5, fill_mode: 'sequential' });
  store.addSource(ch.id, { kind: 'series', ref: 'tt031', name: 'Filler' });
  store.addSlot(ch.id, { days: '1,2,3,4,5,6,7', start: '20:00', minutes: 60, content: { kind: 'series', ref: 'tt032', name: 'Primetime' } });
  const now = DateTime.fromISO('2026-10-21T18:00', { zone: ZONE }).toMillis();
  const eight = DateTime.fromISO('2026-10-21T20:00', { zone: ZONE }).toMillis();
  await buildChannel(ch.id, { now });
  const rows = store.epgRange(ch.id, now, eight + 2 * HOUR);
  const second = rows[1];
  assert.equal(await retimeFrom(ch.id, second.id, second.start - 4 * 60e3), true);
  const after = store.epgRange(ch.id, now, eight + 2 * HOUR);
  assertContiguous(after);
  const slotRow = after.find((r) => r.meta_id === 'tt032');
  assert.equal(slotRow.start, eight, 'the 8 PM slot still starts at 8 PM');
  assert.equal(after[after.indexOf(slotRow) - 1].end, eight, 'the program before it runs on to 8 PM');
  // Pushing programs later into the slot isn't done by shifting; the caller replans instead.
  const last = after[after.indexOf(slotRow) - 1];
  assert.equal(await retimeFrom(ch.id, last.id, last.start + 10 * 60e3), 'conflict');
});

test('a double-length episode already on air gets its full length instead of being cut off', async () => {
  const { fitGuideToFile } = await import('../src/prefetch.js');
  seedSeries('tt040', 'Bad Batch', 25, 1, 16);
  const ch = store.createChannel({ name: 'Premiere', round_minutes: 5, fill_mode: 'sequential' });
  store.addSource(ch.id, { kind: 'series', ref: 'tt040', name: 'Bad Batch' });
  const start = Date.now() - 24 * 60e3; // tuned in 24 minutes into "Aftermath"
  await buildChannel(ch.id, { now: start });
  const [onAir, next] = store.epgRange(ch.id, start, Infinity);
  assert.equal(onAir.end - onAir.start, 25 * 60e3);
  await fitGuideToFile(onAir, store.getChannel(ch.id), { duration: 71 * 60 }, { onAir: true });
  const [a, b] = store.epgRange(ch.id, start, Infinity);
  assert.equal(a.end - a.start, 71 * 60e3, 'the whole 71 minutes');
  assert.equal(b.video_id, next.video_id, 'the same program follows, just later');
  assert.equal(b.start, a.end);
  // On air, a shorter file is left for the next program's start to correct.
  await fitGuideToFile(a, store.getChannel(ch.id), { duration: 20 * 60 }, { onAir: true });
  assert.equal(store.get('SELECT end FROM epg WHERE id = ?', a.id).end, a.end);
});

test('a channel whose titles all failed recently still gets a guide instead of "nothing on"', async () => {
  seedSeries('tt050', 'Outage A', 30, 1, 3);
  seedSeries('tt051', 'Outage B', 30, 1, 3);
  const ch = store.createChannel({ name: 'Outage', round_minutes: 5 });
  store.addSource(ch.id, { kind: 'series', ref: 'tt050', name: 'Outage A' });
  store.addSource(ch.id, { kind: 'series', ref: 'tt051', name: 'Outage B' });
  for (const s of ['tt050', 'tt051']) for (let e = 1; e <= 3; e++) markUnplayable(`${s}:1:${e}`);
  const now = DateTime.fromISO('2026-10-25T05:00', { zone: ZONE }).toMillis();
  await buildChannel(ch.id, { now });
  const rows = store.epgRange(ch.id, now, now + 6 * HOUR);
  assert.ok(rows.length >= 10, `guide has ${rows.length} rows`);
  assertContiguous(rows);
});
