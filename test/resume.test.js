import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'st-resume-'));
process.env.HLS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'st-resume-hls-'));
const { store } = await import('../src/db.js');
const { ChannelRunner } = await import('../src/playout.js');
const { preparedFor } = await import('../src/prefetch.js');

test('a channel saves where it is, and a new runner for the same program picks up that stream', () => {
  const channel = store.createChannel({ name: 'Movies' });
  const item = { id: 1, video_id: 'tt0816692', title: 'Interstellar', type: 'movie' };
  const r = Object.create(ChannelRunner.prototype);
  r.channelId = channel.id;
  const cand = { url: 'https://cdn.example/dl/abc/Interstellar.mkv', label: 'Interstellar 1080p', resolution: 1080, headers: null };
  const info = { duration: 10140, video: { codec_name: 'h264', height: 1080 }, audio: [], subtitles: [] };
  r.saveState(item, cand, info, 1234.5, true);
  const row = store.get('SELECT * FROM playout_state WHERE channel_id = ?', channel.id);
  assert.equal(row.video_id, 'tt0816692');
  assert.equal(row.position, 1234.5);
  assert.equal(row.transcode, 1);
  // A later save replaces the row.
  r.saveState(item, cand, info, 1300, false);
  assert.equal(store.get('SELECT position FROM playout_state WHERE channel_id = ?', channel.id).position, 1300);

  // Another program on the same channel: nothing to restore.
  assert.equal(r.restoreState({ ...item, video_id: 'tt0000001' }, channel), false);
  assert.equal(preparedFor(item, channel), null);
  // The same program: the saved stream is handed to the prefetch cache, so no addon lookup or probe is needed.
  assert.equal(r.restoreState(item, channel), true);
  assert.equal(preparedFor(item, channel)?.cand.url, cand.url);
  assert.equal(preparedFor(item, channel)?.restored, true);

  // Too old to trust (debrid links expire): ignored.
  const other = store.createChannel({ name: 'Old' });
  const r2 = Object.create(ChannelRunner.prototype);
  r2.channelId = other.id;
  r2.saveState(item, cand, info, 10, false);
  store.run('UPDATE playout_state SET updated_at = ? WHERE channel_id = ?', Date.now() - 7 * 3600e3, other.id);
  assert.equal(r2.restoreState(item, other), false);
});
