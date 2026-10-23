import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'st-meta-'));
const { store } = await import('../src/db.js');
const { lookupImdb } = await import('../src/metadata.js');

// A fake Cinemeta with the quirks seen in the real one: a movie request for a show's id answers with an unrelated
// film filed under that id, and the series endpoint 504s now and then.
const hits = new Map();
const series = (name) => ({ meta: { id: 'x', name, type: 'series', videos: [{ id: 'x:1:1', season: 1, episode: 1 }] } });
const movie = (name) => ({ meta: { id: 'x', name, type: 'movie' } });
const routes = {
  '/meta/series/tt0000001.json': () => series('Ed Stafford: Left for Dead'),
  '/meta/movie/tt0000001.json': () => movie('My Friend Pinto'),
  '/catalog/series/top/search=Ed Stafford: Left for Dead.json': () => ({ metas: [{ id: 'tt0000001', name: 'Ed Stafford: Left for Dead' }] }),
  '/catalog/movie/top/search=My Friend Pinto.json': () => ({ metas: [{ id: 'tt1512220', name: 'My Friend Pinto' }] }),
  '/meta/series/tt0000002.json': () => ({}),
  '/meta/movie/tt0000002.json': () => movie('Thunderbolts*'),
  '/catalog/movie/top/search=Thunderbolts.json': () => ({ metas: [{ id: 'tt0000002', name: 'Thunderbolts*' }] }),
  '/meta/series/tt0000003.json': (n) => (n <= 2 ? 504 : series('Cold Water Cowboys')),
  '/catalog/series/top/search=Cold Water Cowboys.json': () => ({ metas: [{ id: 'tt0000003', name: 'Cold Water Cowboys' }] }),
  '/meta/series/tt0000004.json': () => 504,
  '/meta/movie/tt0000004.json': () => movie('Varenyi\'s Last Job'),
  '/catalog/movie/top/search=Varenyi\'s Last Job.json': () => ({ metas: [{ id: 'tt0107000', name: 'Varenyi\'s Last Job' }] }),
  '/meta/series/tt0000005.json': () => ({}),
  '/meta/movie/tt0000005.json': () => movie('Obscure Film'),
  '/catalog/movie/top/search=Obscure Film.json': () => ({ metas: [] }),
};
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url);
  hits.set(url, (hits.get(url) || 0) + 1);
  const route = routes[url];
  const out = route ? route(hits.get(url)) : 404;
  if (typeof out === 'number') { res.writeHead(out); return res.end('error code: ' + out); }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(out));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
store.saveSettings({ metaAddon: `http://127.0.0.1:${server.address().port}` });
test.after(() => server.close());

test('a show id is never taken for the unrelated film the movie catalog files under it', async () => {
  const r = await lookupImdb('tt0000001');
  assert.equal(r.type, 'series');
  assert.equal(r.meta.name, 'Ed Stafford: Left for Dead');
  // Asked for a movie with that id: the junk answer is recognised and refused.
  await assert.rejects(() => lookupImdb('tt0000001', { types: ['movie'] }), /real id is different/);
});

test('movies are confirmed by searching for their name (a literal * in it is fine)', async () => {
  const r = await lookupImdb('tt0000002');
  assert.equal(r.type, 'movie');
  assert.equal(r.meta.name, 'Thunderbolts*');
});

test('a temporary catalog error is retried, not read as "not a show"', async () => {
  const r = await lookupImdb('tt0000003');
  assert.equal(r.type, 'series');
  assert.equal(r.meta.name, 'Cold Water Cowboys');
  assert.equal(hits.get('/meta/movie/tt0000003.json'), undefined, 'never fell back to the movie catalog');
});

test('when the show lookup keeps failing, the junk movie answer still isn\'t accepted', async () => {
  await assert.rejects(() => lookupImdb('tt0000004'), (e) => /didn't answer for shows/.test(e.message) && /real id is different/.test(e.message));
});

test('a movie search can\'t confirm needs "movie:" to be taken on trust', async () => {
  await assert.rejects(() => lookupImdb('tt0000005'), /movie:/);
  const r = await lookupImdb('tt0000005', { types: ['movie'], explicit: true });
  assert.equal(r.meta.name, 'Obscure Film');
});
