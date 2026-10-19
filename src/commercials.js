// Commercial breaks: a library of short clips (old commercials, bumpers, promos) grouped into bundles, played
// between programs on channels that ask for them.
//
// A bundle is a folder under DATA_DIR/commercials. Clips get there by upload from the web UI or by dropping
// files into the folder (then "Scan for new files"). Each clip is converted once, at ingest, to H.264/AAC with
// a keyframe every 2 s and evened-out loudness, so playout can copy it straight into the channel's stream.

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import yazl from 'yazl';
import yauzl from 'yauzl';
import { config, log } from './config.js';
import { store } from './db.js';
import { probe } from './probe.js';

export const ROOT = path.join(config.dataDir, 'commercials');
export const MAX_PER_BREAK = 3;
const MAX_CLIP_SECONDS = 5 * 60; // longer files aren't commercials; refuse them rather than air a movie
const MAX_UPLOAD_BYTES = Number(process.env.COMMERCIAL_MAX_MB || 1024) * 1048576;
// A whole bundle as one zip: videos barely compress, so the zip is about as big as its clips.
const MAX_ZIP_BYTES = Number(process.env.COMMERCIAL_ZIP_MAX_MB || 20480) * 1048576;
const MEDIA = /\.(mp4|m4v|mkv|webm|mov|avi|ts|m2ts|mpg|mpeg|vob|flv|wmv|3gp|ogv)$/i;
const READY_DIR = '.ready';

// ---------------------------------------------------------------------------
// names and paths

/** Bundle names become folder names: printable, no path tricks, at most 60 characters. */
export function bundleName(name) {
  const n = String(name ?? '').trim().replace(/\s+/g, ' ');
  if (!n || n.length > 60 || /[\\/:*?"<>|\x00-\x1f]/.test(n) || n.startsWith('.')) {
    throw new Error('Bundle names need 1-60 characters and can\'t contain \\ / : * ? " < > | or start with a dot');
  }
  return n;
}

/** Uploaded file names: keep the name people recognise, minus anything unsafe for a file system. */
export function clipFileName(name) {
  // Both separators, whatever this server runs on: a Windows path from a client must lose its folders on Linux too.
  const base = String(name ?? '').split(/[\\/]/).pop().replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim();
  if (!base || base.startsWith('.') || !MEDIA.test(base)) throw new Error('Upload a video file (mp4, mkv, webm, mov, avi, ts, mpg…)');
  return base.slice(-120);
}

const bundleDir = (bundle) => path.join(ROOT, bundle);
export const readyFile = (clip) => path.join(ROOT, clip.bundle, READY_DIR, `${clip.id}.mp4`);

// ---------------------------------------------------------------------------
// library

/** Every bundle with its clip counts and total length; folders without clips count too. */
export function listBundles() {
  fs.mkdirSync(ROOT, { recursive: true });
  const folders = fs.readdirSync(ROOT, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name);
  const rows = store.all(`SELECT bundle, COUNT(*) AS clips, SUM(status = 'ready') AS ready, SUM(status = 'pending') AS pending,
    SUM(status = 'failed') AS failed, SUM(CASE WHEN status = 'ready' THEN duration ELSE 0 END) AS seconds FROM commercials GROUP BY bundle`);
  const byName = new Map(rows.map((r) => [r.bundle, r]));
  return [...new Set([...folders, ...byName.keys()])].sort((a, b) => a.localeCompare(b)).map((name) => {
    const r = byName.get(name) || {};
    return { name, clips: r.clips || 0, ready: r.ready || 0, pending: r.pending || 0, failed: r.failed || 0, seconds: Math.round(r.seconds || 0) };
  });
}

export function listClips(bundle) {
  return store.all('SELECT * FROM commercials WHERE bundle = ? ORDER BY file COLLATE NOCASE', bundle);
}

export function getClip(id) {
  return store.get('SELECT * FROM commercials WHERE id = ?', Number(id));
}

export function createBundle(name) {
  const n = bundleName(name);
  if (listBundles().some((b) => b.name.toLowerCase() === n.toLowerCase())) throw new Error(`There's already a bundle called "${n}"`);
  fs.mkdirSync(bundleDir(n), { recursive: true });
  return n;
}

/** Rename a bundle, its folder and every channel's reference to it. */
export function renameBundle(from, to) {
  const a = bundleName(from);
  const b = bundleName(to);
  if (a === b) return b;
  if (listBundles().some((x) => x.name.toLowerCase() === b.toLowerCase() && x.name !== a)) throw new Error(`There's already a bundle called "${b}"`);
  if (fs.existsSync(bundleDir(a))) fs.renameSync(bundleDir(a), bundleDir(b));
  else fs.mkdirSync(bundleDir(b), { recursive: true });
  store.tx(() => {
    store.run('UPDATE commercials SET bundle = ? WHERE bundle = ?', b, a);
    for (const c of store.listChannels()) {
      const list = c.options?.commercialBundles;
      if (Array.isArray(list) && list.includes(a)) store.updateChannel(c.id, { options: { commercialBundles: list.map((x) => (x === a ? b : x)) } });
    }
  });
  bump();
  return b;
}

/** Delete a bundle with all its files, and drop it from channels that used it. */
export function deleteBundle(name) {
  const n = bundleName(name);
  fs.rmSync(bundleDir(n), { recursive: true, force: true });
  store.tx(() => {
    store.run('DELETE FROM commercials WHERE bundle = ?', n);
    for (const c of store.listChannels()) {
      const list = c.options?.commercialBundles;
      if (Array.isArray(list) && list.includes(n)) store.updateChannel(c.id, { options: { commercialBundles: list.filter((x) => x !== n) } });
    }
  });
  bump();
}

export function deleteClip(id) {
  const clip = getClip(id);
  if (!clip) return false;
  fs.rmSync(path.join(bundleDir(clip.bundle), clip.file), { force: true });
  fs.rmSync(readyFile(clip), { force: true });
  store.run('DELETE FROM commercials WHERE id = ?', clip.id);
  bump();
  return true;
}

/** Stream an upload (the raw request body) into a bundle, then queue it for conversion. */
export async function saveUpload(bundle, fileName, req) {
  const b = bundleName(bundle);
  const name = clipFileName(fileName);
  const len = Number(req.headers['content-length'] || 0);
  if (len > MAX_UPLOAD_BYTES) throw Object.assign(new Error(`That file is over ${MAX_UPLOAD_BYTES / 1048576} MB`), { status: 413 });
  fs.mkdirSync(bundleDir(b), { recursive: true });
  const dest = path.join(bundleDir(b), name);
  const tmp = path.join(bundleDir(b), `.upload-${process.pid}-${Date.now()}`);
  let size = 0;
  try {
    await pipeline(req, async function* limit(source) {
      for await (const chunk of source) {
        size += chunk.length;
        if (size > MAX_UPLOAD_BYTES) throw Object.assign(new Error(`That file is over ${MAX_UPLOAD_BYTES / 1048576} MB`), { status: 413 });
        yield chunk;
      }
    }, fs.createWriteStream(tmp));
    if (!size) throw Object.assign(new Error('The upload was empty'), { status: 400 });
    fs.renameSync(tmp, dest);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  const clip = upsertClip(b, name, fs.statSync(dest));
  ingestSoon();
  return clip;
}

/** Record a source file, marking it for (re)conversion when it's new or changed. */
function upsertClip(bundle, file, st) {
  const cur = store.get('SELECT * FROM commercials WHERE bundle = ? AND file = ?', bundle, file);
  if (cur && cur.size === st.size && cur.mtime === Math.round(st.mtimeMs)) return cur;
  if (cur) {
    fs.rmSync(readyFile(cur), { force: true });
    store.run(`UPDATE commercials SET size = ?, mtime = ?, status = 'pending', error = '', duration = NULL WHERE id = ?`, st.size, Math.round(st.mtimeMs), cur.id);
    return getClip(cur.id);
  }
  const r = store.run(`INSERT INTO commercials(bundle, file, size, mtime, status, added_at) VALUES (?, ?, ?, ?, 'pending', ?)`,
    bundle, file, st.size, Math.round(st.mtimeMs), Date.now());
  return getClip(r.lastInsertRowid);
}

/** Pick up files dropped straight into bundle folders, and forget ones that were removed. */
export function scanLibrary() {
  fs.mkdirSync(ROOT, { recursive: true });
  let added = 0;
  let removed = 0;
  const seen = new Set();
  for (const b of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (!b.isDirectory() || b.name.startsWith('.')) continue;
    for (const f of fs.readdirSync(bundleDir(b.name), { withFileTypes: true })) {
      if (!f.isFile() || f.name.startsWith('.') || !MEDIA.test(f.name)) continue;
      const known = store.get('SELECT id FROM commercials WHERE bundle = ? AND file = ?', b.name, f.name);
      const clip = upsertClip(b.name, f.name, fs.statSync(path.join(bundleDir(b.name), f.name)));
      if (!known) added++;
      seen.add(clip.id);
    }
  }
  for (const c of store.all('SELECT * FROM commercials')) {
    if (seen.has(c.id)) continue;
    fs.rmSync(readyFile(c), { force: true });
    store.run('DELETE FROM commercials WHERE id = ?', c.id);
    removed++;
  }
  if (added || removed) bump();
  ingestSoon();
  return { added, removed, pending: store.get(`SELECT COUNT(*) AS n FROM commercials WHERE status = 'pending'`).n };
}

// ---------------------------------------------------------------------------
// bundles as zip files

/** A bundle's original files as a zip stream (stored, not compressed: video doesn't shrink). */
export function bundleZip(bundle) {
  const b = bundleName(bundle);
  if (!fs.existsSync(bundleDir(b))) throw Object.assign(new Error(`No bundle called "${b}"`), { status: 404 });
  const zip = new yazl.ZipFile();
  for (const c of listClips(b)) {
    const file = path.join(bundleDir(b), c.file);
    if (fs.existsSync(file)) zip.addFile(file, c.file, { compress: false });
  }
  zip.end();
  return zip.outputStream;
}

/** "Name.mp4", "Name (2).mp4", "Name (3).mp4"… for as long as they exist, plus the first free one (last). */
function nameVariants(dir, name) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  const out = [name];
  for (let i = 2; fs.existsSync(path.join(dir, out[out.length - 1])); i++) out.push(`${stem} (${i})${ext}`);
  return out;
}
const freeName = (dir, name) => nameVariants(dir, name).pop();

const openZip = (file) => new Promise((resolve, reject) => {
  yauzl.open(file, { lazyEntries: true, autoClose: true, strictFileNames: false, validateEntrySizes: true }, (e, z) => (e ? reject(e) : resolve(z)));
});
const entryStream = (zip, entry) => new Promise((resolve, reject) => {
  zip.openReadStream(entry, (e, s) => (e ? reject(e) : resolve(s)));
});

/**
 * Add every video in a zip to a bundle (created if needed). Folders inside the zip are flattened, so zipping a
 * folder of clips works; non-video files, macOS metadata and clips too big to be commercials are skipped and
 * reported. A file already in the bundle with the same name and size isn't added twice.
 */
export async function extractZip(zipPath, bundle) {
  const b = bundleName(bundle);
  const dir = bundleDir(b);
  let zip;
  try {
    zip = await openZip(zipPath);
  } catch (e) {
    throw Object.assign(new Error(`That doesn't look like a zip file (${e.message})`), { status: 400 });
  }
  fs.mkdirSync(dir, { recursive: true }); // only once we know it's a zip, so a bad upload leaves no empty bundle
  const added = [];
  const skipped = [];
  let total = 0;

  /** The name to save an entry under, or null to pass it over (reasons for skipping go in `skipped`). */
  const nameFor = (entry) => {
    const skip = (reason) => { skipped.push({ file: entry.fileName, reason }); return null; };
    const parts = entry.fileName.split(/[\\/]/);
    const base = parts.pop();
    // Folders, and the clutter macOS and Windows add to zips, are passed over silently.
    if (!base || base.startsWith('.') || parts.includes('__MACOSX') || /^(thumbs\.db|desktop\.ini)$/i.test(base)) return null;
    let name;
    try { name = clipFileName(base); } catch { return skip('not a video file'); }
    if (entry.uncompressedSize > MAX_UPLOAD_BYTES) return skip(`over ${MAX_UPLOAD_BYTES / 1048576} MB`);
    if ((total += entry.uncompressedSize) > MAX_ZIP_BYTES) return skip('the zip unpacks to more than the import limit');
    // Already here under this name or a "(2)" copy of it: same file, as far as a re-import is concerned.
    if (nameVariants(dir, name).slice(0, -1).some((n) => fs.statSync(path.join(dir, n)).size === entry.uncompressedSize)) return skip('already in this bundle');
    return name;
  };

  const save = async (entry, name) => {
    const tmp = path.join(dir, `.import-${process.pid}-${added.length}-${Date.now()}`);
    try {
      await pipeline(await entryStream(zip, entry), fs.createWriteStream(tmp));
      const final = freeName(dir, name);
      fs.renameSync(tmp, path.join(dir, final));
      upsertClip(b, final, fs.statSync(path.join(dir, final)));
      added.push(final);
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      skipped.push({ file: entry.fileName, reason: /encrypt/i.test(e.message) ? 'password-protected' : e.message });
    }
  };

  await new Promise((resolve, reject) => {
    zip.on('error', reject);
    zip.on('end', resolve);
    zip.on('entry', (entry) => {
      const name = nameFor(entry);
      (name ? save(entry, name) : Promise.resolve())
        .then(() => zip.readEntry())
        .catch((e) => { zip.close(); reject(e); });
    });
    zip.readEntry();
  });
  if (added.length) { bump(); ingestSoon(); }
  log.info(`commercials: imported ${added.length} clip(s) into ${b}${skipped.length ? `, skipped ${skipped.length}` : ''}`);
  return { bundle: b, added: added.length, files: added, skipped };
}

/** Import a zip sent as the raw request body. */
export async function importZip(bundle, req) {
  const b = bundleName(bundle);
  const len = Number(req.headers['content-length'] || 0);
  const tooBig = () => Object.assign(new Error(`That zip is over ${MAX_ZIP_BYTES / 1048576} MB`), { status: 413 });
  if (len > MAX_ZIP_BYTES) throw tooBig();
  const incoming = path.join(ROOT, '.incoming');
  fs.mkdirSync(incoming, { recursive: true });
  const tmp = path.join(incoming, `${process.pid}-${Date.now()}.zip`);
  let size = 0;
  try {
    await pipeline(req, async function* limit(source) {
      for await (const chunk of source) {
        if ((size += chunk.length) > MAX_ZIP_BYTES) throw tooBig();
        yield chunk;
      }
    }, fs.createWriteStream(tmp));
    return await extractZip(tmp, b);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// ---------------------------------------------------------------------------
// conversion

const run = (bin, args, timeout) => new Promise((resolve, reject) => {
  execFile(bin, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, _o, stderr) => (err ? reject(new Error((stderr || err.message).trim().split('\n').slice(-2).join(' '))) : resolve()));
});

/** ffmpeg arguments that turn any clip into one the channel stream can copy as-is. */
export function normalizeArgs(src, out, info) {
  const v = info.video || {};
  const interlaced = v.field_order && !['progressive', 'unknown'].includes(v.field_order);
  // Square pixels, at most 1080p, even dimensions; deinterlace old TV rips.
  const vf = [interlaced ? 'yadif' : null, "scale='trunc(iw*sar/2)*2':'trunc(ih/2)*2'", 'setsar=1',
    "scale='min(1920,iw)':'min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2", 'format=yuv420p'].filter(Boolean).join(',');
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', src];
  const hasAudio = info.audio?.length > 0;
  if (!hasAudio) args.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo');
  args.push('-map', '0:v:0', '-map', hasAudio ? '0:a:0' : '1:a:0', '-t', String(Math.min(info.duration || MAX_CLIP_SECONDS, MAX_CLIP_SECONDS)),
    '-vf', vf, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-profile:v', 'high',
    '-force_key_frames', 'expr:gte(t,n_forced*2)', '-sc_threshold', '0',
    // Commercials were always louder than the show; level them to the same loudness.
    '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000', '-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-ar', '48000',
    '-sn', '-dn', '-map_metadata', '-1', '-movflags', '+faststart', out);
  return args;
}

async function ingestOne(clip) {
  const src = path.join(bundleDir(clip.bundle), clip.file);
  const info = await probe(src);
  if (!info) throw new Error('No video found in this file');
  if (info.duration && info.duration > MAX_CLIP_SECONDS + 1) throw new Error(`It runs ${Math.round(info.duration / 60)} min; commercials can be at most ${MAX_CLIP_SECONDS / 60} min`);
  const out = readyFile(clip);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const tmp = `${out}.part.mp4`;
  try {
    await run(config.ffmpeg, normalizeArgs(src, tmp, info), 10 * 60 * 1000);
    const done = await probe(tmp);
    if (!done?.duration) throw new Error('The converted clip has no length');
    fs.renameSync(tmp, out);
    return done.duration;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

let ingesting = false;
let again = false;

/** Convert pending clips one at a time in the background. */
export function ingestSoon() {
  if (ingesting) { again = true; return; }
  ingesting = true;
  (async () => {
    do {
      again = false;
      for (;;) {
        const clip = store.get(`SELECT * FROM commercials WHERE status = 'pending' ORDER BY id LIMIT 1`);
        if (!clip) break;
        try {
          const duration = await ingestOne(clip);
          // The row may have been deleted or replaced while we worked.
          const cur = getClip(clip.id);
          if (!cur || cur.mtime !== clip.mtime) { if (!cur) fs.rmSync(readyFile(clip), { force: true }); continue; }
          store.run(`UPDATE commercials SET status = 'ready', duration = ?, error = '' WHERE id = ?`, duration, clip.id);
          log.info(`commercials: ready ${clip.bundle}/${clip.file} (${duration.toFixed(1)}s)`);
        } catch (e) {
          store.run(`UPDATE commercials SET status = 'failed', error = ? WHERE id = ?`, e.message.slice(0, 300), clip.id);
          log.warn(`commercials: couldn't convert ${clip.bundle}/${clip.file}: ${e.message}`);
        }
        bump();
      }
    } while (again);
  })().catch((e) => log.error('commercial conversion failed:', e)).finally(() => { ingesting = false; });
}

export function startCommercials() {
  try { scanLibrary(); } catch (e) { log.error('commercial library scan failed:', e); }
}

// ---------------------------------------------------------------------------
// breaks

let version = 0;
const bump = () => { version++; };

/** How many commercials a channel plays per break (0 = none). */
export function perBreak(channel) {
  const n = Math.round(Number(channel?.options?.commercialsPerBreak) || 0);
  return Math.max(0, Math.min(MAX_PER_BREAK, n));
}

/** Ready clips a channel may use: its chosen bundles, or every bundle when it hasn't picked any. */
export function clipsFor(channel) {
  const chosen = channel?.options?.commercialBundles;
  const rows = store.all(`SELECT id, bundle, file, duration FROM commercials WHERE status = 'ready' AND duration > 0`);
  return Array.isArray(chosen) && chosen.length ? rows.filter((r) => chosen.includes(r.bundle)) : rows;
}

const allowanceCache = new Map(); // channel id -> { key, seconds }

/**
 * Time the guide sets aside after each program for its break: commercials per break times the average clip
 * length (each counted as 15 s to 3 min). Zero when breaks are off or there are no clips yet.
 */
export function breakAllowance(channel) {
  const n = perBreak(channel);
  if (!n) return 0;
  const key = `${version}|${n}|${JSON.stringify(channel.options?.commercialBundles || [])}`;
  const hit = allowanceCache.get(channel.id);
  if (hit?.key === key) return hit.seconds;
  const clips = clipsFor(channel);
  const avg = clips.length ? clips.reduce((s, c) => s + Math.min(180, Math.max(15, c.duration)), 0) / clips.length : 0;
  const seconds = Math.round(n * avg);
  allowanceCache.set(channel.id, { key, seconds });
  return seconds;
}

/**
 * Choose up to `count` clips that fit in `seconds`, at random, avoiding the recently played ones (`recent`,
 * newest last) unless nothing else fits.
 */
export function pickBreak(clips, count, seconds, recent = [], rand = Math.random) {
  const shuffled = clips.map((c) => ({ c, r: rand() })).sort((a, b) => a.r - b.r).map((x) => x.c);
  const recentSet = new Set(recent);
  const ordered = [...shuffled.filter((c) => !recentSet.has(c.id)), ...shuffled.filter((c) => recentSet.has(c.id))
    .sort((a, b) => recent.indexOf(a.id) - recent.indexOf(b.id))];
  const out = [];
  let left = seconds;
  for (const c of ordered) {
    if (out.length >= count) break;
    if (c.duration <= left + 0.5) {
      out.push(c);
      left -= c.duration;
    }
  }
  return out;
}

export const _test = { bump };
