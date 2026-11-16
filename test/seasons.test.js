import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'st-seasons-'));
const { store } = await import('../src/db.js');
const { matchEpisode, broadcastId, isYearSeason } = await import('../src/seasons.js');
const { findStreams } = await import('../src/picker.js');

// American Pickers as Cinemeta numbers it (by year) and as TVmaze does (broadcast seasons). Cinemeta's dates
// run a day after TVmaze's.
const PICKERS = 'tt1596786';
store.cacheSet(`meta:series:${PICKERS}`, {
  id: PICKERS, name: 'American Pickers', videos: [
    { id: `${PICKERS}:2019:1`, season: 2019, episode: 1, title: 'Pick Your Battle', released: '2019-01-22T05:00:00.000Z' },
    { id: `${PICKERS}:2019:28`, season: 2019, episode: 28, title: 'Double Barn Bonanza', released: '2019-11-12T05:00:00.000Z' },
    { id: `${PICKERS}:2020:3`, season: 2020, episode: 3, title: 'Untitled', released: '2020-02-04T05:00:00.000Z' },
    { id: `${PICKERS}:2013:12`, season: 2013, episode: 12, title: 'Deuce Digging', released: '2013-06-11T05:00:00.000Z' },
  ],
});
store.cacheSet(`tvmaze:${PICKERS}`, [
  { s: 20, n: 1, d: '2019-01-21', t: 'Pick Your Battle' },
  { s: 21, n: 4, d: '2019-11-11', t: 'Double Barn Bonanza' },
  { s: 21, n: 9, d: '2020-02-03', t: 'Hogs and Kisses' }, // retitled on TVmaze: matched by air date
  { s: 9, n: 3, d: '2013-06-10', t: 'Deuce Digging' },
]);

test('year seasons are matched to broadcast seasons by title, or by an air date a day apart', async () => {
  assert.equal(isYearSeason(2019), true);
  assert.equal(isYearSeason(21), false);
  assert.equal(await broadcastId({ type: 'series', video_id: `${PICKERS}:2019:28` }), `${PICKERS}:21:4`);
  assert.equal(await broadcastId({ type: 'series', video_id: `${PICKERS}:2019:1` }), `${PICKERS}:20:1`);
  assert.equal(await broadcastId({ type: 'series', video_id: `${PICKERS}:2020:3` }), `${PICKERS}:21:9`);
  assert.equal(await broadcastId({ type: 'series', video_id: `${PICKERS}:5:3` }), null, 'ordinary seasons are left alone');
  assert.equal(await broadcastId({ type: 'movie', video_id: 'tt0111161' }), null);
  // Two candidates aired on nearby days and no title: no guess.
  assert.equal(matchEpisode({ title: '', released: '2019-01-22T05:00:00.000Z' }, [{ s: 1, n: 1, d: '2019-01-21', t: 'a' }, { s: 1, n: 2, d: '2019-01-22', t: 'b' }]), null);
});

test('the stream addons are asked under the broadcast numbering, and under the year when that finds nothing', async () => {
  const asked = [];
  const server = http.createServer((req, res) => {
    const id = decodeURIComponent(req.url.match(/\/stream\/series\/(.+)\.json/)?.[1] || '');
    asked.push(id);
    const streams = id === `${PICKERS}:21:4` ? [{ name: '[TB+] Torrentio\n1080p', title: 'American.Pickers.S21E04.1080p.WEB.h264', url: 'https://cdn.example/s21e04.mkv' }]
      : id === `${PICKERS}:2013:12` ? [{ name: '[TB+] Torrentio\n720p', title: 'American.Pickers.2013.06.11.720p.HDTV', url: 'https://cdn.example/2013.mkv' }] : [];
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ streams }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  store.saveSettings({ streamAddons: [`http://127.0.0.1:${server.address().port}/manifest.json`] });
  const channel = { id: 950, resolution: 1080, options: {} };
  try {
    const found = await findStreams({ type: 'series', meta_id: PICKERS, video_id: `${PICKERS}:2019:28`, title: 'American Pickers' }, channel);
    assert.deepEqual(found.map((c) => c.url), ['https://cdn.example/s21e04.mkv']);
    assert.deepEqual(asked, [`${PICKERS}:21:4`], 'asked once, as S21E04');
    asked.length = 0;
    const old = await findStreams({ type: 'series', meta_id: PICKERS, video_id: `${PICKERS}:2013:12`, title: 'American Pickers' }, channel);
    assert.deepEqual(old.map((c) => c.url), ['https://cdn.example/2013.mkv']);
    assert.deepEqual(asked, [`${PICKERS}:9:3`, `${PICKERS}:2013:12`], 'nothing as S09E03, so asked by the year too');
  } finally {
    server.close();
    store.saveSettings({ streamAddons: [] });
  }
});
