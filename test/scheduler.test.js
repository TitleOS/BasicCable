import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DateTime } from 'luxon';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'st-sched-'));
process.env.TZ = 'America/New_York';
const { store } = await import('../src/db.js');
const { buildChannel, slotOccurrences } = await import('../src/scheduler.js');
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
