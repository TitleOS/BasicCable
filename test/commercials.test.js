import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'st-ads-'));
const { store } = await import('../src/db.js');
const ads = await import('../src/commercials.js');
const { probe } = await import('../src/probe.js');

const hasFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const seq = (...xs) => { let i = 0; return () => xs[i++ % xs.length]; };

test('pickBreak fills the count without overrunning the gap', () => {
  const clips = [{ id: 1, duration: 30 }, { id: 2, duration: 60 }, { id: 3, duration: 120 }, { id: 4, duration: 15 }];
  for (let i = 0; i < 50; i++) {
    const p = ads.pickBreak(clips, 3, 150);
    assert.ok(p.length >= 1 && p.length <= 3);
    assert.ok(p.reduce((s, c) => s + c.duration, 0) <= 150.5);
    assert.equal(new Set(p.map((c) => c.id)).size, p.length, 'no clip twice in a break');
  }
  assert.deepEqual(ads.pickBreak(clips, 2, 10), [], 'nothing fits a 10 s gap');
  assert.deepEqual(ads.pickBreak([], 3, 300), []);
});

test('pickBreak avoids recently played clips unless nothing else fits', () => {
  const clips = [{ id: 1, duration: 30 }, { id: 2, duration: 30 }, { id: 3, duration: 30 }];
  const rand = seq(0.1, 0.2, 0.3);
  assert.deepEqual(ads.pickBreak(clips, 1, 300, [1, 2], rand).map((c) => c.id), [3]);
  // Everything is recent: the one played longest ago goes first.
  assert.deepEqual(ads.pickBreak(clips, 2, 300, [3, 1, 2], rand).map((c) => c.id), [3, 1]);
});

test('bundle names are checked and channel references follow renames and deletes', () => {
  assert.throws(() => ads.bundleName('../etc'));
  assert.throws(() => ads.bundleName('.hidden'));
  assert.throws(() => ads.bundleName(''));
  assert.equal(ads.bundleName('  2000s   Kids  '), '2000s Kids');
  assert.throws(() => ads.clipFileName('notes.txt'));
  assert.equal(ads.clipFileName('C:\\fakepath\\Gushers 2003.mp4'), 'Gushers 2003.mp4');

  ads.createBundle('2000s Kids');
  ads.createBundle('Adult Swim Bumps');
  assert.throws(() => ads.createBundle('2000s kids'), /already/);
  const ch = store.createChannel({ name: 'Ads', options: { commercialsPerBreak: 2, commercialBundles: ['2000s Kids', 'Adult Swim Bumps'] } });
  ads.renameBundle('2000s Kids', '2000s Kids TV');
  assert.deepEqual(store.getChannel(ch.id).options.commercialBundles, ['2000s Kids TV', 'Adult Swim Bumps']);
  ads.deleteBundle('Adult Swim Bumps');
  assert.deepEqual(store.getChannel(ch.id).options.commercialBundles, ['2000s Kids TV']);
  assert.deepEqual(ads.listBundles().map((b) => b.name), ['2000s Kids TV']);
});

test('perBreak and breakAllowance', () => {
  assert.equal(ads.perBreak({ options: {} }), 0);
  assert.equal(ads.perBreak({ options: { commercialsPerBreak: 7 } }), 3);
  const ch = store.createChannel({ name: 'Allowance', options: { commercialsPerBreak: 2, commercialBundles: ['Allow'] } });
  assert.equal(ads.breakAllowance(ch), 0, 'no clips yet');
  store.run(`INSERT INTO commercials(bundle, file, size, mtime, duration, status, added_at) VALUES ('Allow', 'a.mp4', 1, 1, 30, 'ready', 0), ('Allow', 'b.mp4', 1, 1, 90, 'ready', 0), ('Other', 'c.mp4', 1, 1, 600, 'ready', 0)`);
  ads._test.bump();
  assert.equal(ads.breakAllowance(ch), 120, '2 × average of 30 s and 90 s');
  assert.equal(ads.breakAllowance({ ...ch, options: { commercialsPerBreak: 0 } }), 0);
  store.run(`DELETE FROM commercials WHERE bundle IN ('Allow', 'Other')`);
  ads._test.bump();
});

test('dropped files are converted into copyable H.264/AAC clips', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const dir = path.join(ads.ROOT, 'Retro');
  fs.mkdirSync(dir, { recursive: true });
  // A 4:3 SD clip with non-square pixels and no audio track, like an old TV rip.
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=720x480:rate=30000/1001:duration=5',
    '-vf', 'setsar=8/9', '-c:v', 'mpeg2video', path.join(dir, 'Old Spot.mpg')]);
  const r = ads.scanLibrary();
  assert.equal(r.added, 1);
  for (let i = 0; i < 120 && store.get(`SELECT COUNT(*) AS n FROM commercials WHERE status = 'pending'`).n; i++) await new Promise((res) => setTimeout(res, 250));
  const [clip] = ads.listClips('Retro');
  assert.equal(clip.status, 'ready', clip.error);
  assert.ok(Math.abs(clip.duration - 5) < 0.3, `duration ${clip.duration}`);
  const info = await probe(ads.readyFile(clip));
  assert.equal(info.video.codec_name, 'h264');
  assert.equal(info.audio[0]?.codec_name, 'aac', 'silent audio added');
  assert.equal(info.video.width, 640, 'square pixels: 720 × 8/9');
  // Removing the file from the folder forgets the clip.
  fs.rmSync(path.join(dir, 'Old Spot.mpg'));
  assert.equal(ads.scanLibrary().removed, 1);
  assert.equal(fs.existsSync(ads.readyFile(clip)), false);
});

// --- zip import/export
const { default: yazl } = await import('yazl');
const { default: yauzl } = await import('yauzl');
const { Readable } = await import('node:stream');

/** Build a zip on disk from { name: Buffer } and return its path. */
async function makeZip(entries) {
  const zip = new yazl.ZipFile();
  for (const [name, data] of Object.entries(entries)) zip.addBuffer(data, name);
  zip.end();
  const file = path.join(os.tmpdir(), `st-zip-${Date.now()}-${Math.random().toString(36).slice(2)}.zip`);
  await new Promise((res, rej) => zip.outputStream.pipe(fs.createWriteStream(file)).on('close', res).on('error', rej));
  return file;
}
const zipNames = (file) => new Promise((resolve, reject) => {
  yauzl.open(file, { lazyEntries: true }, (e, z) => {
    if (e) return reject(e);
    const names = [];
    z.on('entry', (en) => { names.push(`${en.fileName}:${en.uncompressedSize}`); z.readEntry(); });
    z.on('end', () => resolve(names.sort()));
    z.readEntry();
  });
});
const bytes = (n, fill = 1) => Buffer.alloc(n, fill);

test('a zip of clips becomes a bundle; junk, traversal and clashes are handled', async () => {
  const zip = await makeZip({
    'Saturday Morning/Gushers.mp4': bytes(1000),
    'Saturday Morning/Dunkaroos.mkv': bytes(2000),
    'Saturday Morning/more/Gushers.mp4': bytes(1500), // same name, different file
    '__MACOSX/Saturday Morning/._Gushers.mp4': bytes(10),
    'Saturday Morning/.DS_Store': bytes(10),
    'Saturday Morning/notes.txt': bytes(10),
  });
  const r = await ads.extractZip(zip, 'Saturday Morning');
  assert.equal(r.bundle, 'Saturday Morning');
  assert.deepEqual(r.files.sort(), ['Dunkaroos.mkv', 'Gushers (2).mp4', 'Gushers.mp4']);
  assert.deepEqual(r.skipped, [{ file: 'Saturday Morning/notes.txt', reason: 'not a video file' }]);
  const dir = path.join(ads.ROOT, 'Saturday Morning');
  assert.deepEqual(fs.readdirSync(dir).filter((f) => !f.startsWith('.')).sort(), ['Dunkaroos.mkv', 'Gushers (2).mp4', 'Gushers.mp4']);
  assert.equal(ads.listClips('Saturday Morning').length, 3);

  // Importing the same zip again adds nothing.
  const again = await ads.extractZip(zip, 'Saturday Morning');
  assert.equal(again.added, 0);
  assert.equal(again.skipped.filter((s) => s.reason === 'already in this bundle').length, 3);

  // Export gives back the originals under their bundle names.
  const out = path.join(os.tmpdir(), `st-export-${Date.now()}.zip`);
  await new Promise((res, rej) => ads.bundleZip('Saturday Morning').pipe(fs.createWriteStream(out)).on('close', res).on('error', rej));
  assert.deepEqual(await zipNames(out), ['Dunkaroos.mkv:2000', 'Gushers (2).mp4:1500', 'Gushers.mp4:1000']);
  assert.throws(() => ads.bundleZip('No Such Bundle'), /No bundle/);
  ads.deleteBundle('Saturday Morning');
});

test('importZip takes the zip as a request body and rejects files that are not zips', async () => {
  const zip = await makeZip({ 'Bumps/Toonami.mp4': bytes(800) });
  const req = (file) => Object.assign(Readable.from(fs.readFileSync(file)), { headers: { 'content-length': String(fs.statSync(file).size) } });
  const r = await ads.importZip('Adult Swim Bumps', req(zip));
  assert.deepEqual(r.files, ['Toonami.mp4']);
  const notZip = path.join(os.tmpdir(), `st-notzip-${Date.now()}.zip`);
  fs.writeFileSync(notZip, 'definitely not a zip');
  await assert.rejects(() => ads.importZip('Not A Zip', req(notZip)), (e) => e.status === 400 && /zip/.test(e.message));
  assert.equal(ads.listBundles().some((b) => b.name === 'Not A Zip'), false, 'a failed import leaves no empty bundle');
  assert.deepEqual(fs.readdirSync(path.join(ads.ROOT, '.incoming')), [], 'temporary uploads are cleaned up');
  ads.deleteBundle('Adult Swim Bumps');
});

test('a zip with a path that climbs out of the folder is refused', async () => {
  // yazl won't write "../", so write "zz/" and patch the name in both headers.
  const file = await makeZip({ 'zz/escape.mp4': bytes(500) });
  const buf = fs.readFileSync(file);
  let i = -1;
  while ((i = buf.indexOf('zz/escape.mp4', i + 1)) !== -1) buf.write('../', i);
  fs.writeFileSync(file, buf);
  await assert.rejects(() => ads.extractZip(file, 'Escape Test'), /invalid relative path/);
  assert.equal(fs.existsSync(path.join(ads.ROOT, 'escape.mp4')), false);
  assert.equal(fs.existsSync(path.join(ads.ROOT, '..', 'escape.mp4')), false);
  assert.deepEqual(fs.readdirSync(path.join(ads.ROOT, 'Escape Test')), []);
  ads.deleteBundle('Escape Test');
});
