import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'st-playout-'));
process.env.HLS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'st-hls-'));
const hasFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

test('a copied video with keyframes too far apart stops at the long segment, which is never published', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const { ChannelRunner } = await import('../src/playout.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-gop-'));
  const src = path.join(dir, 'long-gop.mkv');
  // Keyframes every 4s for the first 20s, then none for 30s.
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25:duration=50',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '10000', '-sc_threshold', '0', '-force_key_frames', '0,4,8,12,16,20', src]);
  // A runner without its playout loop: just the segment bookkeeping runFfmpeg needs.
  const r = Object.create(ChannelRunner.prototype);
  Object.assign(r, { channelId: 0, dir, segments: [], programs: new Map(), cancelled: new Set(), program: 0, nextSeq: 0,
    contentTotal: 0, maxTarget: 6, visible: 0, timeBase: Date.now(), waiters: [], stopped: false });
  r.pruneFiles = () => {};
  const out = await r.runFfmpeg(['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', src, '-map', '0:v:0', '-c:v', 'copy'], { maxSegment: 12 });
  assert.ok(out.longSegment > 12, `found the long segment (${out.longSegment})`);
  assert.ok(Math.abs(out.seconds - 20) < 0.5, `kept the 20s before it (${out.seconds})`);
  assert.ok(r.segments.every((s) => s.duration <= 12));
  assert.ok(r.maxTarget <= 12, `the target duration was not stretched (${r.maxTarget})`);
  await new Promise((res) => setTimeout(res, 200));
  const left = fs.readdirSync(dir).filter((f) => f.endsWith('.ts'));
  assert.deepEqual(left.sort(), r.segments.map((s) => s.name).sort(), 'the long segment and anything after it were deleted');
});

test('the timeline starts with the first segment, and 30s of video is published straight away', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const { ChannelRunner } = await import('../src/playout.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-tune-'));
  const r = Object.create(ChannelRunner.prototype);
  // As on tune-in: the channel's clock was read 10s ago, before finding and opening its stream.
  Object.assign(r, { channelId: 0, dir, segments: [], programs: new Map(), cancelled: new Set(), program: 0, nextSeq: 0,
    contentTotal: 0, maxTarget: 6, visible: 0, timeBase: Date.now() - 10000, waiters: [], stopped: false });
  r.pruneFiles = () => {};
  const before = Date.now();
  await r.runFfmpeg(['-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=25:duration=60',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '50']);
  assert.ok(r.timeBase >= before, 'the time spent getting the stream ready does not count');
  const shown = r.segments.slice(0, r.visibleCount());
  const end = shown.at(-1).contentStart + shown.at(-1).duration;
  assert.ok(end >= 30 && end < 40, `published up to ${end}s of the 60s`);
});

test('the live playlist lists a minute of video even when segments are 2s, and keeps their files 30s behind it', async () => {
  const { ChannelRunner } = await import('../src/playout.js');
  const r = Object.create(ChannelRunner.prototype);
  // 20 copied 6s segments, then a re-encoded part in 2s segments (as from a long-keyframe fallback or the Up next box).
  const segments = [];
  let t = 0;
  for (let i = 0; i < 60; i++) {
    const duration = i < 20 ? 6 : 2;
    segments.push({ name: `p${i < 20 ? 1 : 2}_${String(i).padStart(5, '0')}.ts`, duration, program: i < 20 ? 1 : 2, index: i, seq: i, disc: i === 20, contentStart: t });
    t += duration;
  }
  // Everything is published: the live position is 30s (the preroll) before the end.
  Object.assign(r, { channelId: 0, dir: fs.mkdtempSync(path.join(os.tmpdir(), 'st-window-')), segments, programs: new Map(), maxTarget: 6, visible: 0, timeBase: Date.now() - (t - 30) * 1000 });
  assert.equal(r.visibleCount(), 60);
  const listed = r.playlist().split('\n').filter((l) => l.startsWith('#EXTINF')).map((l) => Number(l.slice(8, -1)));
  const listedSeconds = listed.reduce((a, b) => a + b, 0);
  assert.ok(listedSeconds >= 60 && listedSeconds < 62, `lists ${listedSeconds}s, not 20s`);
  assert.equal(listed.length, 30);
  assert.match(r.playlist(), /#EXT-X-DISCONTINUITY-SEQUENCE:1\n/, 'the discontinuity before the window is counted');
  r.pruneFiles();
  const kept = segments.filter((s) => !s.deleted);
  const keptSeconds = kept.reduce((a, s) => a + s.duration, 0);
  assert.ok(keptSeconds >= 90 && keptSeconds < 96, `files kept for ${keptSeconds}s`);
  // Long copied segments keep the old floor: 10 listed, 3 more kept.
  const long = Array.from({ length: 30 }, (_, i) => ({ name: `p1_${i}.ts`, duration: 10, program: 1, index: i, seq: i, disc: false, contentStart: i * 10 }));
  Object.assign(r, { segments: long, visible: 0, timeBase: Date.now() - (300 - 30) * 1000 });
  assert.equal(r.playlist().split('\n').filter((l) => l.startsWith('#EXTINF')).length, 10);
  r.pruneFiles();
  assert.equal(long.filter((s) => !s.deleted).length, 13);
});

test('an MP4 reads its text subtitles over their own connection; other files and burned-in tracks do not', async () => {
  const { ChannelRunner } = await import('../src/playout.js');
  const r = Object.create(ChannelRunner.prototype);
  r.capsBurst = true;
  const cand = { url: 'https://debrid.example/file', headers: { Referer: 'https://example.test/' } };
  const audio = [{ codec_name: 'aac', channels: 2, tags: { language: 'eng' } }];
  const channel = { options: {} };
  const inputs = (args) => args.filter((a) => a === '-i').length;
  const vtt = { index: 2, delivery: 'vtt', stream: { codec_name: 'mov_text' } };
  const mp4 = r.mainArgs(cand, { container: 'mov,mp4,m4a,3gp,3g2,mj2', audio, video: {} }, channel, 800, 120, vtt);
  assert.equal(inputs(mp4), 2);
  assert.equal(mp4.filter((a) => a === '-headers').length, 2, 'both connections send the headers');
  assert.equal(mp4.filter((a) => a === '-ss').length, 2, 'both start at the same point');
  assert.equal(mp4.filter((a) => a === '-readrate').length, 2, 'both are paced');
  assert.ok(mp4.indexOf('-t') > mp4.lastIndexOf('-i'), 'the length is an output option');
  assert.equal(mp4[mp4.indexOf('webvtt') - 2], '1:s:2');
  assert.ok(mp4.includes('0:v:0') && mp4.includes('0:a:0'), 'picture and sound stay on the first connection');
  const mkv = r.mainArgs(cand, { container: 'matroska,webm', audio, video: {} }, channel, 800, 120, { ...vtt, stream: { codec_name: 'subrip' } });
  assert.equal(inputs(mkv), 1);
  assert.equal(mkv[mkv.indexOf('webvtt') - 2], '0:s:2');
  const unknown = r.mainArgs(cand, { audio, video: {} }, channel, 800, 120, vtt);
  assert.equal(inputs(unknown), 1, 'a stream saved before the container was recorded');
  const none = r.mainArgs(cand, { container: 'mov,mp4', audio, video: {} }, channel, 800, 120, null);
  assert.equal(inputs(none), 1);
});

test('a channel falling behind real time is logged once a minute, with its speed, until it catches up', async (t) => {
  const { ChannelRunner } = await import('../src/playout.js');
  const { log } = await import('../src/config.js');
  const warned = [], told = [];
  t.mock.method(log, 'warn', (m) => warned.push(m));
  t.mock.method(log, 'info', (m) => told.push(m));
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const r = Object.create(ChannelRunner.prototype);
  Object.assign(r, { channelId: 4, anchored: true, timeBase: 1_000_000, contentTotal: 10 });
  r.noteLag('copying the video'); // 10s ahead
  t.mock.timers.tick(11_000); r.noteLag('copying the video'); // 1s behind: within the margin
  assert.equal(warned.length, 0);
  t.mock.timers.tick(21_000); r.contentTotal = 25; r.noteLag('copying the video'); // 32s in, 25s made
  assert.equal(warned.length, 1);
  assert.match(warned[0], /channel 4: 7s behind real time, making video at 0\.47x \(copying the video\)/);
  t.mock.timers.tick(30_000); r.contentTotal = 50; r.noteLag('copying the video');
  assert.equal(warned.length, 1, 'not again within the minute');
  t.mock.timers.tick(31_000); r.contentTotal = 75; r.noteLag('copying the video');
  assert.equal(warned.length, 2);
  r.contentTotal = 200; r.noteLag('copying the video');
  assert.match(told.at(-1), /channel 4: back ahead of real time after 61s/);
  assert.equal(r.lag, null);
});
