import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'st-util-'));
process.env.TZ = 'America/Chicago';
const { store } = await import('../src/db.js');
const { buildChannel } = await import('../src/scheduler.js');
const { utilityRows, utilityConfig, listUtilities, placeLabel, frameSize } = await import('../src/utilities.js');
const { ensureSet, setStatus, pickTrack, trackLabel, scanOwn, ownDir, pauseDownloads } = await import('../src/music.js');
const { MUSIC_SETS } = await import('../src/musicsets.js');
pauseDownloads(true); // never fetch the real recordings in a test

const ZONE = 'America/Chicago';
store.saveSettings({ timezone: ZONE });
const resolved = { lat: 44.95, lon: -93.09, name: 'Saint Paul', region: 'MN', country: 'US' };
const HOUR = 3600e3;

test('a weather channel gets an hourly guide out to the horizon, aligned to the hour', async () => {
  const ch = store.createChannel({ name: 'Weather', options: { utility: { kind: 'weather', place: '55101', days: 5, units: 'F', music: 'classical', resolved } } });
  const now = Date.UTC(2026, 10, 7, 15, 20); // 9:20 AM Chicago
  await buildChannel(ch.id, { now });
  const rows = store.epgRange(ch.id, 0, Infinity);
  assert.ok(rows.length >= 47, `rows: ${rows.length}`);
  assert.equal(rows[0].start, Date.UTC(2026, 10, 7, 15), 'starts on the hour before now');
  assert.equal(rows[0].end, Date.UTC(2026, 10, 7, 16));
  assert.equal(rows[0].type, 'utility');
  assert.equal(rows[0].title, 'Local Forecast');
  assert.equal(rows[0].episode_title, 'Saint Paul, MN');
  assert.match(rows[0].description, /5-day forecast for Saint Paul, MN/);
  for (let i = 1; i < rows.length; i++) assert.equal(rows[i].start, rows[i - 1].end);
  assert.equal(new Set(rows.map((r) => r.video_id)).size, rows.length, 'every block has its own id');
  // A rebuild keeps what is on air and continues from its end.
  await buildChannel(ch.id, { now: now + 25 * 60000, rebuild: true });
  const again = store.epgRange(ch.id, 0, Infinity);
  assert.equal(again[0].id, rows[0].id);
  assert.equal(again[1].start, rows[0].end);
  assert.equal(listUtilities()[0].channel.id, ch.id);
  store.deleteChannel(ch.id);
});

test('utilityRows splits a span at hour boundaries', () => {
  const ch = { options: { utility: { kind: 'weather', days: 3, resolved } } };
  const from = Date.UTC(2026, 10, 7, 15, 40);
  const rows = utilityRows(ch, from, from + 2 * HOUR, ZONE);
  assert.deepEqual(rows.map((r) => [r.start - from, r.end - from]), [[0, 20 * 60000], [20 * 60000, 80 * 60000], [80 * 60000, 120 * 60000]]);
  assert.equal(placeLabel(ch.options.utility), 'Saint Paul, MN');
  assert.deepEqual(frameSize({ resolution: 720 }), { width: 1280, height: 720 });
  assert.deepEqual(frameSize({ resolution: 2160 }), { width: 1920, height: 1080 });
});

test('utility settings are checked', async () => {
  await assert.rejects(utilityConfig('weather', { days: 9, place: '55101' }), /3 to 7 days/);
  await assert.rejects(utilityConfig('weather', { units: 'R', place: '55101' }), /F, C or K/);
  await assert.rejects(utilityConfig('weather', { days: 5 }), /zip or postal code/);
  await assert.rejects(utilityConfig('news', {}), /No utility channel/);
  // A place that was resolved before is kept without another lookup.
  const prev = { kind: 'weather', place: '55101', days: 5, units: 'F', music: 'classical', resolved };
  const cfg = await utilityConfig('weather', { place: '55101', days: 3, units: 'c' }, prev);
  assert.equal(cfg.days, 3);
  assert.equal(cfg.units, 'C');
  assert.equal(cfg.resolved, resolved);
});

test('the bundled music set registers its tracks; own files are picked up and labelled', () => {
  assert.ok(MUSIC_SETS.classical.tracks.length >= 40);
  for (const t of MUSIC_SETS.classical.tracks) {
    assert.match(t.url, /^https:\/\/upload\.wikimedia\.org\//);
    assert.ok(['CC0', 'Public domain'].includes(t.licence), t.licence);
    assert.ok(t.composer && t.work && t.seconds > 60);
  }
  const before = setStatus('classical');
  assert.equal(before.total, 0);
  const st = ensureSet('classical');
  assert.equal(st.total, MUSIC_SETS.classical.tracks.length);
  assert.equal(st.bundled, MUSIC_SETS.classical.tracks.length);
  fs.writeFileSync(path.join(ownDir('classical'), 'My Favourite_Nocturne.mp3'), 'not really audio');
  assert.equal(scanOwn('classical'), 1);
  const own = store.get(`SELECT * FROM music_tracks WHERE source = 'own'`);
  assert.equal(trackLabel(own), 'My Favourite Nocturne');
  assert.equal(trackLabel(store.get(`SELECT * FROM music_tracks WHERE source = 'bundled' AND work LIKE 'Serenade No. 10%'`)), 'W. A. Mozart — Serenade No. 10 in B-flat "Gran Partita", K. 361 - I. Largo - Molto allegro · United States Marine Band');
  // Nothing is ready yet, so nothing can be picked; mark two ready and the picker avoids the recent one.
  assert.equal(pickTrack('classical'), null);
  const ids = store.all('SELECT id FROM music_tracks ORDER BY id LIMIT 2').map((r) => r.id);
  store.run(`UPDATE music_tracks SET status = 'ready', duration = 300 WHERE id IN (?, ?)`, ids[0], ids[1]);
  for (let i = 0; i < 10; i++) assert.equal(pickTrack('classical', [ids[0]]).id, ids[1]);
  assert.ok(pickTrack('classical', ids), 'falls back to a recent one when nothing else is ready');
  fs.rmSync(path.join(ownDir('classical'), 'My Favourite_Nocturne.mp3'));
  assert.equal(scanOwn('classical'), 0);
  assert.equal(store.get(`SELECT COUNT(*) AS n FROM music_tracks WHERE source = 'own'`).n, 0, 'removed files are forgotten');
});
