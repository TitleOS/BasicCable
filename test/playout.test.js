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
