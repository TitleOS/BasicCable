// Music for the generated channels. Each set (see musicsets.js) lives in DATA_DIR/music/<set>/: the bundled
// recordings are downloaded once and converted to AAC, and anything dropped into <set>/own/ plays too.

import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { config, log, VERSION } from './config.js';
import { store } from './db.js';
import { probe } from './probe.js';
import { MUSIC_SETS, trackId } from './musicsets.js';

export const ROOT = path.join(config.dataDir, 'music');
const AUDIO = /\.(mp3|m4a|aac|ogg|oga|opus|flac|wav|wma|mka)$/i;
const MAX_DOWNLOAD_BYTES = 300 * 1048576;
const UA = `BasicCable/${VERSION} (+https://github.com/TitleOS/BasicCable)`;

export const setDir = (set) => path.join(ROOT, set);
export const ownDir = (set) => path.join(setDir(set), 'own');
export const trackPath = (t) => path.join(setDir(t.set_name), t.file);

export function knownSet(set) {
  return Object.prototype.hasOwnProperty.call(MUSIC_SETS, set);
}

/** "W. A. Mozart - Serenade No. 10 ... · United States Marine Band" (own files: their name). */
export function trackLabel(t) {
  if (!t) return '';
  if (t.source === 'own' || !t.work) return (t.work || path.basename(t.file).replace(/\.[^.]+$/, '')).replace(/[_]+/g, ' ');
  return `${t.composer ? `${t.composer} — ` : ''}${t.work}${t.performer ? ` · ${t.performer}` : ''}`;
}

/** Register the set's bundled tracks (once), look for own files, and start downloading what's missing. */
export function ensureSet(set, { retryFailed = false } = {}) {
  if (!knownSet(set)) throw new Error(`No music set called "${set}"`);
  fs.mkdirSync(ownDir(set), { recursive: true });
  const ins = store.db.prepare(`INSERT OR IGNORE INTO music_tracks(set_name, source, file, composer, work, performer, status) VALUES (?, 'bundled', ?, ?, ?, ?, 'pending')`);
  store.tx(() => {
    for (const t of MUSIC_SETS[set].tracks) ins.run(set, `${trackId(t.url)}.m4a`, t.composer || '', t.work || '', t.performer || '');
    if (retryFailed) store.run(`UPDATE music_tracks SET status = 'pending', error = '' WHERE set_name = ? AND status = 'failed'`, set);
  });
  scanOwn(set);
  ingestSoon();
  return setStatus(set);
}

/** Pick up files the user put in <set>/own/, and forget ones that were removed. */
export function scanOwn(set) {
  let added = 0;
  const dir = ownDir(set);
  fs.mkdirSync(dir, { recursive: true });
  const seen = new Set();
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!f.isFile() || f.name.startsWith('.') || !AUDIO.test(f.name)) continue;
    const rel = `own/${f.name}`;
    seen.add(rel);
    const cur = store.get('SELECT id FROM music_tracks WHERE set_name = ? AND file = ?', set, rel);
    if (cur) continue;
    store.run(`INSERT INTO music_tracks(set_name, source, file, status) VALUES (?, 'own', ?, 'pending')`, set, rel);
    added++;
  }
  for (const r of store.all(`SELECT id, file FROM music_tracks WHERE set_name = ? AND source = 'own'`, set)) {
    if (!seen.has(r.file)) store.run('DELETE FROM music_tracks WHERE id = ?', r.id);
  }
  if (added) ingestSoon();
  return added;
}

export function setStatus(set) {
  const meta = MUSIC_SETS[set] || { name: set, description: '', tracks: [] };
  const r = store.get(`SELECT COUNT(*) AS total, SUM(status = 'ready') AS ready, SUM(status = 'pending') AS pending, SUM(status = 'failed') AS failed,
    SUM(source = 'own') AS own, SUM(CASE WHEN status = 'ready' THEN duration ELSE 0 END) AS seconds FROM music_tracks WHERE set_name = ?`, set) || {};
  return {
    set, name: meta.name, description: meta.description, bundled: meta.tracks.length,
    total: r.total || 0, ready: r.ready || 0, pending: r.pending || 0, failed: r.failed || 0, own: r.own || 0,
    minutes: Math.round((r.seconds || 0) / 60), downloading: busy ? current : null, folder: ownDir(set),
  };
}

export function listTracks(set) {
  return store.all('SELECT * FROM music_tracks WHERE set_name = ? ORDER BY source, composer, work', set);
}

/** A ready track at random, avoiding the ones played lately (`recent`: ids, newest last) when there are others. */
export function pickTrack(set, recent = []) {
  const ready = store.all(`SELECT * FROM music_tracks WHERE set_name = ? AND status = 'ready' AND duration > 0`, set);
  if (!ready.length) return null;
  const fresh = ready.filter((t) => !recent.includes(t.id));
  const pool = fresh.length ? fresh : ready;
  return pool[Math.floor(Math.random() * pool.length)];
}

// ---------------------------------------------------------------------------
// downloading and converting

// Conversions run at a low priority: a channel on air matters more than a download being readied.
const run = (bin, args, timeout) => new Promise((resolve, reject) => {
  const [cmd, argv] = process.platform === 'win32' ? [bin, args] : ['nice', ['-n', '15', bin, ...args]];
  execFile(cmd, argv, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, _o, stderr) => (err ? reject(new Error((stderr || err.message).trim().split('\n').slice(-2).join(' '))) : resolve()));
});

async function download(url, dest) {
  const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(15 * 60 * 1000), redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_DOWNLOAD_BYTES) throw new Error(`file is ${Math.round(len / 1048576)} MB, over the ${MAX_DOWNLOAD_BYTES / 1048576} MB limit`);
  let size = 0;
  await pipeline(Readable.fromWeb(res.body), async function* limit(source) {
    for await (const chunk of source) {
      if ((size += chunk.length) > MAX_DOWNLOAD_BYTES) throw new Error('download too large');
      yield chunk;
    }
  }, fs.createWriteStream(dest));
  if (!size) throw new Error('empty download');
}

async function ingestOne(t) {
  const dest = trackPath(t);
  if (t.source === 'bundled') {
    const src = MUSIC_SETS[t.set_name]?.tracks.find((x) => `${trackId(x.url)}.m4a` === t.file);
    if (!src) throw new Error('no longer in the bundled list');
    if (!fs.existsSync(dest)) {
      const raw = `${dest}.download`;
      const tmp = `${dest}.part.m4a`;
      try {
        await download(src.url, raw);
        // Stereo AAC at a steady level, so every track plays straight into the channel's stream.
        await run(config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', raw, '-vn', '-sn', '-dn', '-map_metadata', '-1',
          '-af', 'loudnorm=I=-18:TP=-1.5:LRA=11,aresample=48000', '-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-ar', '48000', '-movflags', '+faststart', tmp], 10 * 60 * 1000);
        fs.renameSync(tmp, dest);
      } finally {
        fs.rmSync(raw, { force: true });
        fs.rmSync(tmp, { force: true });
      }
    }
  }
  const info = await probeAudio(dest);
  if (!info?.duration) throw new Error('no audio found in this file');
  return info.duration;
}

/** ffprobe for audio-only files (probe() wants a video stream). */
function probeAudio(file) {
  return new Promise((resolve) => {
    execFile(config.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { timeout: 30000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        const j = JSON.parse(stdout);
        if (!(j.streams || []).some((s) => s.codec_type === 'audio')) return resolve(null);
        resolve({ duration: Number(j.format?.duration) || null, tags: j.format?.tags || {} });
      } catch { resolve(null); }
    });
  });
}

let busy = false;
let again = false;
let current = null;
let paused = /^(1|true|yes|off)$/i.test(process.env.MUSIC_DOWNLOADS_OFF || '');

/** Stop (or allow) downloading bundled tracks; own files are still picked up. Used by tests. */
export function pauseDownloads(on = true) { paused = !!on; }

/** Download and convert pending tracks one at a time in the background. */
export function ingestSoon() {
  if (busy) { again = true; return; }
  busy = true;
  (async () => {
    do {
      again = false;
      for (;;) {
        // Own files first: they need no download.
        const t = store.get(`SELECT * FROM music_tracks WHERE status = 'pending' ${paused ? "AND source = 'own'" : ''} ORDER BY source DESC, id LIMIT 1`);
        if (!t) break;
        current = trackLabel(t);
        try {
          const duration = await ingestOne(t);
          if (!store.get('SELECT id FROM music_tracks WHERE id = ?', t.id)) continue; // removed meanwhile
          store.run(`UPDATE music_tracks SET status = 'ready', duration = ?, error = '' WHERE id = ?`, duration, t.id);
          log.info(`music: ready ${t.set_name}: ${trackLabel(t)} (${Math.round(duration)}s)`);
        } catch (e) {
          store.run(`UPDATE music_tracks SET status = 'failed', error = ? WHERE id = ?`, e.message.slice(0, 300), t.id);
          log.warn(`music: ${t.set_name}: ${trackLabel(t)} failed: ${e.message}`);
          fs.rmSync(trackPath(t), { force: true });
        }
      }
    } while (again);
  })().catch((e) => log.error('music download failed:', e)).finally(() => { busy = false; current = null; });
}

/** On start-up: sets in use get their missing tracks; own folders are rescanned. */
export function startMusic(setsInUse) {
  for (const set of new Set(setsInUse)) {
    try { ensureSet(set); } catch (e) { log.error(`music set ${set}:`, e); }
  }
}

export function allSets() {
  return Object.keys(MUSIC_SETS).map(setStatus);
}

export const probeFile = probe; // re-export for callers that already import music
