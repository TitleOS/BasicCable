import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'st-prefetch-'));
const { pickPlayable } = await import('../src/prefetch.js');

const item = { video_id: 'tt1:1:1', title: 'Show', season: 1, episode: 1, start: 0, end: 30 * 60000 };
const channel = { id: 1, number: 1, resolution: 1080, options: {} };
// Ranked candidates: score [preferred, resolution rank, hdr, dv, uncached, order], as rankStreams makes them.
const cand = (name, score) => ({ url: name, label: name, score });
const english = [{ codec_name: 'subrip', tags: { language: 'eng' } }];
const probes = (files) => {
  const asked = [];
  const fn = async (url) => {
    asked.push(url);
    return files[url] === undefined ? null : { duration: 1700, subtitles: files[url] };
  };
  return { fn, asked };
};

test('a release without subtitles gives way to an equally ranked one that has them', async () => {
  const p = probes({ a: [], b: [], c: english });
  const got = await pickPlayable([cand('a', [1, 0, 0, 0, 0, 0]), cand('b', [1, 0, 0, 0, 0, 1]), cand('c', [1, 0, 0, 0, 0, 2])], item, channel, p.fn);
  assert.equal(got.cand.url, 'c');
});

test('only two more releases are tried, and the first plays when none has subtitles', async () => {
  const p = probes({ a: [], b: [], c: [], d: english });
  const list = ['a', 'b', 'c', 'd'].map((n, i) => cand(n, [1, 0, 0, 0, 0, i]));
  const got = await pickPlayable(list, item, channel, p.fn);
  assert.equal(got.cand.url, 'a');
  assert.deepEqual(p.asked, ['a', 'b', 'c']);
});

test('a lower resolution or uncached release is never picked just for its subtitles', async () => {
  for (const score of [[1, 1, 0, 0, 0, 1], [1, 0, 0, 0, 1, 1]]) {
    const p = probes({ a: [], b: english });
    const got = await pickPlayable([cand('a', [1, 0, 0, 0, 0, 0]), cand('b', score)], item, channel, p.fn);
    assert.equal(got.cand.url, 'a');
    assert.deepEqual(p.asked, ['a'], 'the other release was not probed');
  }
});

test('with subtitles off, the first release that plays is used', async () => {
  const p = probes({ a: [], b: english });
  const got = await pickPlayable([cand('a', [1, 0, 0, 0, 0, 0]), cand('b', [1, 0, 0, 0, 0, 1])], item, { ...channel, options: { subtitles: 'off' } }, p.fn);
  assert.equal(got.cand.url, 'a');
  assert.deepEqual(p.asked, ['a']);
});

test('releases that fail to probe are skipped as before', async () => {
  const p = probes({ b: english });
  const got = await pickPlayable([cand('a', [1, 0, 0, 0, 0, 0]), cand('b', [1, 1, 0, 0, 0, 1])], item, channel, p.fn);
  assert.equal(got.cand.url, 'b');
  assert.equal(await pickPlayable([cand('x', [1, 0, 0, 0, 0, 0])], item, channel, p.fn), null);
});
