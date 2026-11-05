import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

const DEFAULT_SETTINGS = {
  // Stremio stream addons configured with your debrid service.
  // Paste the manifest URL you installed in Stremio; the debrid key is part of that URL.
  streamAddons: [],
  // Stremio metadata addon used for search, episode lists and runtimes.
  metaAddon: 'https://v3-cinemeta.strem.io',
  timezone: config.timezone,
  publicUrl: config.baseUrl,
  defaultResolution: 1080,
  // Each viewer IP watches one channel at a time; tuning in elsewhere releases the previous one.
  oneStreamPerIp: true,
  // Releases whose name contains one of these words win over everything else (e.g. The Office "Superfan" cuts).
  preferKeywords: ['Superfan'],
  // Releases whose name contains one of these words (whole words) are never used, on any channel.
  blockKeywords: ['YIFY', 'YTS'],
  // Find, rank and probe each item's stream this many minutes before it airs (0 turns it off).
  prefetchMinutes: 10,
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number INTEGER NOT NULL,
  name TEXT NOT NULL,
  logo TEXT NOT NULL DEFAULT '',
  resolution INTEGER NOT NULL DEFAULT 1080,
  fallback TEXT NOT NULL DEFAULT 'lower',
  fill_mode TEXT NOT NULL DEFAULT 'shuffle',
  round_minutes INTEGER NOT NULL DEFAULT 5,
  options TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  name TEXT NOT NULL,
  poster TEXT NOT NULL DEFAULT '',
  options TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS slots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  days TEXT NOT NULL,
  start TEXT NOT NULL,
  minutes INTEGER NOT NULL,
  content TEXT NOT NULL,
  play_order TEXT NOT NULL DEFAULT 'sequential'
);
CREATE TABLE IF NOT EXISTS epg (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  start INTEGER NOT NULL,
  end INTEGER NOT NULL,
  type TEXT NOT NULL,
  meta_id TEXT NOT NULL,
  video_id TEXT NOT NULL,
  title TEXT NOT NULL,
  episode_title TEXT NOT NULL DEFAULT '',
  season INTEGER,
  episode INTEGER,
  poster TEXT NOT NULL DEFAULT '',
  background TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  origin TEXT NOT NULL,
  truncated INTEGER NOT NULL DEFAULT 0,
  cursor_prev TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS epg_channel_start ON epg(channel_id, start);
CREATE TABLE IF NOT EXISTS cursors (
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (channel_id, key)
);
-- Commercial clips: source files in DATA_DIR/commercials/<bundle>/, converted copies in <bundle>/.ready/<id>.mp4.
CREATE TABLE IF NOT EXISTS commercials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bundle TEXT NOT NULL,
  file TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime INTEGER NOT NULL,
  duration REAL,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT NOT NULL DEFAULT '',
  added_at INTEGER NOT NULL,
  UNIQUE (bundle, file)
);
-- Recently shown: everything that aired on a channel, kept after the guide itself is pruned.
CREATE TABLE IF NOT EXISTS history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  aired_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  type TEXT NOT NULL,
  meta_id TEXT NOT NULL,
  video_id TEXT NOT NULL,
  title TEXT NOT NULL,
  episode_title TEXT NOT NULL DEFAULT '',
  season INTEGER,
  episode INTEGER,
  complete INTEGER NOT NULL DEFAULT 1,
  UNIQUE (channel_id, video_id, aired_at)
);
CREATE INDEX IF NOT EXISTS history_channel_aired ON history(channel_id, aired_at);
CREATE TABLE IF NOT EXISTS meta_cache (key TEXT PRIMARY KEY, json TEXT NOT NULL, fetched_at INTEGER NOT NULL);
`;

const JSON_COLS = new Set(['options', 'content', 'cursor_prev']);

function hydrate(row) {
  if (!row) return row;
  const out = { ...row };
  for (const k of Object.keys(out)) if (JSON_COLS.has(k)) out[k] = JSON.parse(out[k]);
  return out;
}

class Store {
  constructor(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
  }

  all(sql, ...params) { return this.db.prepare(sql).all(...params).map(hydrate); }
  get(sql, ...params) { return hydrate(this.db.prepare(sql).get(...params)); }
  run(sql, ...params) { return this.db.prepare(sql).run(...params); }

  tx(fn) {
    this.db.exec('BEGIN');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // --- settings
  getSettings() {
    const rows = this.db.prepare('SELECT key, value FROM settings').all();
    const s = { ...DEFAULT_SETTINGS };
    for (const r of rows) s[r.key] = JSON.parse(r.value);
    return s;
  }
  saveSettings(patch) {
    const stmt = this.db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    this.tx(() => {
      for (const [k, v] of Object.entries(patch)) if (k in DEFAULT_SETTINGS) stmt.run(k, JSON.stringify(v));
    });
    return this.getSettings();
  }

  // --- channels
  listChannels() { return this.all('SELECT * FROM channels ORDER BY number, id'); }
  getChannel(id) { return this.get('SELECT * FROM channels WHERE id = ?', Number(id)); }
  createChannel(c) {
    const number = c.number ?? ((this.get('SELECT MAX(number) AS n FROM channels')?.n || 0) + 1);
    const r = this.run(
      `INSERT INTO channels(number, name, logo, resolution, fallback, fill_mode, round_minutes, options, enabled, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      number, c.name, c.logo || '', c.resolution || 1080, c.fallback || 'lower', c.fill_mode || 'shuffle',
      c.round_minutes ?? 5, JSON.stringify(c.options || {}), c.enabled === false ? 0 : 1, Date.now(),
    );
    return this.getChannel(r.lastInsertRowid);
  }
  updateChannel(id, c) {
    const cur = this.getChannel(id);
    if (!cur) return null;
    const m = { ...cur, ...c, options: { ...cur.options, ...(c.options || {}) } };
    this.run(
      `UPDATE channels SET number=?, name=?, logo=?, resolution=?, fallback=?, fill_mode=?, round_minutes=?, options=?, enabled=? WHERE id=?`,
      m.number, m.name, m.logo, m.resolution, m.fallback, m.fill_mode, m.round_minutes, JSON.stringify(m.options),
      m.enabled ? 1 : 0, cur.id,
    );
    return this.getChannel(id);
  }
  deleteChannel(id) { this.run('DELETE FROM channels WHERE id = ?', Number(id)); }

  // --- sources (auto-fill pool)
  listSources(channelId) { return this.all('SELECT * FROM sources WHERE channel_id = ? ORDER BY id', Number(channelId)); }
  getSource(id) { return this.get('SELECT * FROM sources WHERE id = ?', Number(id)); }
  addSource(channelId, s) {
    const r = this.run('INSERT INTO sources(channel_id, kind, ref, name, poster, options) VALUES (?, ?, ?, ?, ?, ?)',
      Number(channelId), s.kind, s.ref, s.name, s.poster || '', JSON.stringify(s.options || {}));
    return this.getSource(r.lastInsertRowid);
  }
  updateSourceOptions(id, options) {
    this.run('UPDATE sources SET options = ? WHERE id = ?', JSON.stringify(options), Number(id));
    return this.getSource(id);
  }
  deleteSource(id) { this.run('DELETE FROM sources WHERE id = ?', Number(id)); }

  // --- slots
  listSlots(channelId) { return this.all('SELECT * FROM slots WHERE channel_id = ? ORDER BY start, id', Number(channelId)); }
  getSlot(id) { return this.get('SELECT * FROM slots WHERE id = ?', Number(id)); }
  addSlot(channelId, s) {
    const r = this.run('INSERT INTO slots(channel_id, days, start, minutes, content, play_order) VALUES (?, ?, ?, ?, ?, ?)',
      Number(channelId), s.days, s.start, s.minutes, JSON.stringify(s.content), s.play_order || 'sequential');
    return this.getSlot(r.lastInsertRowid);
  }
  updateSlot(id, s) {
    const cur = this.getSlot(id);
    if (!cur) return null;
    const m = { ...cur, ...s };
    this.run('UPDATE slots SET days=?, start=?, minutes=?, content=?, play_order=? WHERE id=?',
      m.days, m.start, m.minutes, JSON.stringify(m.content), m.play_order, cur.id);
    return this.getSlot(id);
  }
  deleteSlot(id) { this.run('DELETE FROM slots WHERE id = ?', Number(id)); }

  // --- epg
  epgAt(channelId, t) {
    return this.get('SELECT * FROM epg WHERE channel_id = ? AND start <= ? AND end > ? ORDER BY start DESC LIMIT 1', Number(channelId), t, t);
  }
  epgAfter(channelId, start) {
    return this.get('SELECT * FROM epg WHERE channel_id = ? AND start > ? ORDER BY start LIMIT 1', Number(channelId), start);
  }
  epgRange(channelId, from, to) {
    return this.all('SELECT * FROM epg WHERE channel_id = ? AND end > ? AND start < ? ORDER BY start', Number(channelId), from, to);
  }
  epgLast(channelId) { return this.get('SELECT * FROM epg WHERE channel_id = ? ORDER BY start DESC LIMIT 1', Number(channelId)); }
  recentEpg(channelId, limit) {
    return this.all('SELECT * FROM epg WHERE channel_id = ? ORDER BY start DESC LIMIT ?', Number(channelId), limit);
  }

  // --- cursors
  getCursors(channelId) {
    const out = {};
    for (const r of this.db.prepare('SELECT key, value FROM cursors WHERE channel_id = ?').all(Number(channelId))) out[r.key] = r.value;
    return out;
  }

  // --- metadata cache
  cacheGet(key, maxAgeMs) {
    const r = this.db.prepare('SELECT json, fetched_at FROM meta_cache WHERE key = ?').get(key);
    if (!r || Date.now() - r.fetched_at > maxAgeMs) return null;
    return JSON.parse(r.json);
  }
  cacheSet(key, value) {
    this.run('INSERT INTO meta_cache(key, json, fetched_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json, fetched_at = excluded.fetched_at',
      key, JSON.stringify(value), Date.now());
  }
}

// Basic Cable was called StreamTube before its public release: an install from then keeps its database.
const dbFile = path.join(config.dataDir, 'basiccable.db');
const oldDbFile = path.join(config.dataDir, 'streamtube.db');
if (!fs.existsSync(dbFile) && fs.existsSync(oldDbFile)) {
  for (const ext of ['', '-wal', '-shm']) if (fs.existsSync(oldDbFile + ext)) fs.renameSync(oldDbFile + ext, dbFile + ext);
}

export const store = new Store(dbFile);
