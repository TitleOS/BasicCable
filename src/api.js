import { store } from './db.js';
import { config, log } from './config.js';
import { send, readJson, baseUrl, HttpError } from './http.js';
import { search, expandWildcard, fetchJson } from './metadata.js';
import { buildChannel, resolveWildcard, itemLabel } from './scheduler.js';
import { findStreams, rankStreams, addonBase, clearStreams, RESOLUTIONS } from './picker.js';
import { clearPrepared } from './prefetch.js';
import { runnerStatus, stopRunner, ffmpegCaps } from './playout.js';

const A = { auth: true };
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function requireChannel(id) {
  const c = store.getChannel(id);
  if (!c) throw new HttpError(404, 'Channel not found');
  return c;
}

function channelInput(b, partial = false) {
  const out = {};
  if (b.name !== undefined) {
    if (!String(b.name).trim()) throw new HttpError(400, 'Channel name is required');
    out.name = String(b.name).trim();
  } else if (!partial) throw new HttpError(400, 'Channel name is required');
  if (b.number !== undefined) out.number = Math.max(1, parseInt(b.number, 10) || 1);
  if (b.logo !== undefined) out.logo = String(b.logo).trim();
  if (b.resolution !== undefined) {
    const r = Number(b.resolution);
    if (!RESOLUTIONS.includes(r)) throw new HttpError(400, `Resolution must be one of ${RESOLUTIONS.join(', ')}`);
    out.resolution = r;
  }
  if (b.fallback !== undefined) out.fallback = b.fallback === 'higher' ? 'higher' : 'lower';
  if (b.fill_mode !== undefined) out.fill_mode = ['shuffle', 'sequential', 'random'].includes(b.fill_mode) ? b.fill_mode : 'shuffle';
  if (b.round_minutes !== undefined) out.round_minutes = Math.min(60, Math.max(0, parseInt(b.round_minutes, 10) || 0));
  if (b.enabled !== undefined) out.enabled = !!b.enabled;
  if (b.options !== undefined) {
    const o = b.options || {};
    out.options = {
      avoidDolbyVision: o.avoidDolbyVision !== false,
      includeSpecials: !!o.includeSpecials,
      audio: o.audio === 'copy' ? 'copy' : 'aac',
      subtitles: ['auto', 'soft', 'off'].includes(o.subtitles) ? o.subtitles : 'auto',
      audioLanguage: String(o.audioLanguage || 'eng').trim().toLowerCase().slice(0, 3),
      excludeKeywords: (Array.isArray(o.excludeKeywords) ? o.excludeKeywords : String(o.excludeKeywords || '').split(','))
        .map((s) => String(s).trim()).filter(Boolean),
    };
  }
  return out;
}

function contentInput(c) {
  if (!c || !c.kind) throw new HttpError(400, 'Pick something to play');
  if (c.kind === 'pool') return { kind: 'pool', ref: '', name: 'Channel auto-fill pool' };
  if (!['series', 'movie', 'wildcard'].includes(c.kind)) throw new HttpError(400, 'Unknown content kind');
  if (!c.ref) throw new HttpError(400, 'Missing title id or pattern');
  const out = { kind: c.kind, ref: String(c.ref), name: String(c.name || c.ref), poster: c.poster || '' };
  if (c.kind === 'wildcard') out.options = { types: normTypes(c.options?.types || c.types) };
  return out;
}

function slotInput(b) {
  const days = (Array.isArray(b.days) ? b.days : String(b.days || '').split(',')).map(Number).filter((d) => d >= 1 && d <= 7);
  if (!days.length) throw new HttpError(400, 'Pick at least one day');
  if (!HHMM.test(b.start || '')) throw new HttpError(400, 'Start time must look like 20:00');
  const minutes = parseInt(b.minutes, 10);
  if (!(minutes >= 5 && minutes <= 24 * 60)) throw new HttpError(400, 'Length must be between 5 minutes and 24 hours');
  return {
    days: [...new Set(days)].sort().join(','),
    start: b.start,
    minutes,
    content: contentInput(b.content),
    play_order: b.play_order === 'random' ? 'random' : 'sequential',
  };
}

function normTypes(t) {
  const arr = (Array.isArray(t) ? t : String(t || 'series').split(',')).filter((x) => x === 'series' || x === 'movie');
  return arr.length ? arr : ['series'];
}

// Keeps what's on air now; a running channel simply picks up the new guide at the next item.
async function rebuild(channelId) {
  await buildChannel(channelId, { rebuild: true });
}

/** Validate and save a settings patch (from the Settings page or a restored backup). */
async function applySettings(b) {
  const patch = {};
  if (b.streamAddons !== undefined) {
    patch.streamAddons = (Array.isArray(b.streamAddons) ? b.streamAddons : String(b.streamAddons).split('\n'))
      .map((s) => String(s).trim()).filter(Boolean)
      .map((u) => u.replace(/^stremio:\/\//i, 'https://'));
  }
  if (b.metaAddon !== undefined) patch.metaAddon = addonBase(String(b.metaAddon || 'https://v3-cinemeta.strem.io'));
  if (b.timezone !== undefined) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: b.timezone });
    } catch {
      throw new HttpError(400, `Unknown timezone "${b.timezone}"`);
    }
    patch.timezone = b.timezone;
  }
  if (b.publicUrl !== undefined) patch.publicUrl = String(b.publicUrl).trim().replace(/\/+$/, '');
  if (b.defaultResolution !== undefined) patch.defaultResolution = Number(b.defaultResolution) || 1080;
  if (b.oneStreamPerIp !== undefined) patch.oneStreamPerIp = !!b.oneStreamPerIp;
  if (b.preferKeywords !== undefined) {
    patch.preferKeywords = (Array.isArray(b.preferKeywords) ? b.preferKeywords : String(b.preferKeywords).split(','))
      .map((k) => String(k).trim()).filter(Boolean);
  }
  if (b.prefetchMinutes !== undefined) patch.prefetchMinutes = Math.min(60, Math.max(0, parseInt(b.prefetchMinutes, 10) || 0));
  const before = store.getSettings();
  const after = store.saveSettings(patch);
  if (patch.timezone && patch.timezone !== before.timezone) {
    for (const c of store.listChannels()) await rebuild(c.id);
  }
  if (patch.preferKeywords || patch.streamAddons) {
    // Different addons or preferences can change which file wins.
    clearStreams();
    clearPrepared();
  }
  return after;
}

function channelDetail(c) {
  return { ...c, sources: store.listSources(c.id), slots: store.listSlots(c.id) };
}

// ---------------------------------------------------------------------------
// Backup / restore

const BACKUP_VERSION = 1;
const SETTINGS_KEYS = ['streamAddons', 'metaAddon', 'timezone', 'publicUrl', 'defaultResolution', 'oneStreamPerIp', 'preferKeywords', 'prefetchMinutes'];

/**
 * Where each show is right now, so episodes continue in order on the new install. The stored cursors already
 * include the guide planned ahead, so rewind them past future rows the same way a guide rebuild does.
 */
function progressNow(channelId) {
  const cursors = store.getCursors(channelId);
  const seen = new Set();
  for (const r of store.all('SELECT cursor_prev FROM epg WHERE channel_id = ? AND start > ? ORDER BY start', channelId, Date.now())) {
    for (const [k, v] of Object.entries(r.cursor_prev)) {
      if (seen.has(k)) continue;
      seen.add(k);
      if (v === null) delete cursors[k];
      else cursors[k] = v;
    }
  }
  return Object.fromEntries(Object.entries(cursors).filter(([k]) => k.startsWith('ep:')));
}

/** Channels with their pool, slots and per-show episode progress. Settings only on request (they hold debrid keys). */
function exportBackup({ includeSettings = false } = {}) {
  const channels = store.listChannels().map((c) => ({
    number: c.number, name: c.name, logo: c.logo, resolution: c.resolution, fallback: c.fallback,
    fill_mode: c.fill_mode, round_minutes: c.round_minutes, enabled: !!c.enabled, options: c.options,
    sources: store.listSources(c.id).map((s) => ({
      kind: s.kind, ref: s.ref, name: s.name, poster: s.poster,
      // Wildcard matches are re-resolved on import; only the user's choices travel.
      options: s.kind === 'wildcard' ? { types: s.options.types, excluded: s.options.excluded || [] } : {},
    })),
    slots: store.listSlots(c.id).map((s) => ({ days: s.days, start: s.start, minutes: s.minutes, content: s.content, play_order: s.play_order })),
    progress: progressNow(c.id),
  }));
  const out = { app: 'streamtube', version: BACKUP_VERSION, exportedAt: new Date().toISOString(), channels };
  if (includeSettings) {
    const s = store.getSettings();
    out.settings = Object.fromEntries(SETTINGS_KEYS.map((k) => [k, s[k]]));
  }
  return out;
}

/** Validate a whole backup before touching the database, then create everything in one transaction. */
async function importBackup(data, { replace = false, includeSettings = false } = {}) {
  if (!data || data.app !== 'streamtube' || !Array.isArray(data.channels)) throw new HttpError(400, "That file isn't a StreamTube backup");
  if (data.version > BACKUP_VERSION) throw new HttpError(400, 'This backup comes from a newer StreamTube version');

  const planned = data.channels.map((c, i) => {
    try {
      const sources = (c.sources || []).map((s) => {
        const src = contentInput(s);
        if (src.kind === 'pool') throw new HttpError(400, 'pool is not a valid pool entry');
        if (src.kind === 'wildcard') src.options = { ...src.options, excluded: (s.options?.excluded || []).map(String) };
        return src;
      });
      const progress = Object.entries(c.progress || {}).filter(([k, v]) => /^ep:[\w:.-]+$/.test(k) && typeof v === 'string');
      return { channel: channelInput({ options: {}, ...c }), sources, slots: (c.slots || []).map(slotInput), progress };
    } catch (e) {
      throw new HttpError(400, `Channel ${i + 1} (${c?.name || 'unnamed'}): ${e.message}`);
    }
  });

  if (replace) for (const c of store.listChannels()) stopRunner(c.id);
  const created = store.tx(() => {
    if (replace) store.run('DELETE FROM channels');
    const taken = new Set(store.listChannels().map((c) => c.number));
    return planned.map(({ channel, sources, slots, progress }) => {
      // Keep the backed-up channel number unless it's already in use here.
      let number = channel.number || 1;
      while (taken.has(number)) number++;
      taken.add(number);
      const ch = store.createChannel({ ...channel, number });
      for (const s of sources) store.addSource(ch.id, s);
      for (const s of slots) store.addSlot(ch.id, s);
      for (const [k, v] of progress) store.run('INSERT INTO cursors(channel_id, key, value) VALUES (?, ?, ?)', ch.id, k, v);
      return ch;
    });
  });

  if (includeSettings && data.settings) await applySettings(data.settings);
  // Guides need metadata lookups; build them in the background.
  (async () => {
    for (const ch of created) await buildChannel(ch.id).catch((e) => log.error(`guide build after import failed for ${ch.name}:`, e));
  })();
  return { imported: created.length, replaced: replace, settings: !!(includeSettings && data.settings) };
}

// ---------------------------------------------------------------------------
// Operations shared by the REST API (web UI) and the MCP tools

async function createChannelOp(b) {
  return store.createChannel(channelInput({ resolution: store.getSettings().defaultResolution, options: {}, ...b }));
}

/** Apply a settings patch to a channel, then rebuild its guide or restart playback as needed. */
async function updateChannelOp(cur, b) {
  const c = store.updateChannel(cur.id, channelInput(b, true));
  const scheduleChanged = ['fill_mode', 'round_minutes'].some((k) => b[k] !== undefined && b[k] !== cur[k]) ||
    (b.options && !!b.options.includeSpecials !== !!cur.options.includeSpecials);
  if (b.resolution !== undefined || b.options || b.fallback !== undefined) {
    clearStreams(c.id);
    clearPrepared(c.id);
  }
  if (scheduleChanged) await rebuild(c.id);
  else if (b.resolution !== undefined || b.options || b.fallback !== undefined || b.enabled !== undefined) stopRunner(c.id);
  return store.getChannel(c.id);
}

function deleteChannelOp(c) {
  stopRunner(c.id);
  store.deleteChannel(c.id);
}

/** Add a show, movie or wildcard to a channel's auto-fill pool. `rebuildGuide: false` lets callers batch. */
async function addSourceOp(c, spec, { rebuildGuide = true } = {}) {
  const s = contentInput(spec);
  if (s.kind === 'pool') throw new HttpError(400, 'Pick a show, movie or wildcard');
  if (s.kind === 'wildcard' && spec.options?.excluded) s.options.excluded = spec.options.excluded.map(String);
  const dup = store.listSources(c.id).find((x) => x.kind === s.kind && x.ref.toLowerCase() === s.ref.toLowerCase());
  if (dup) throw new HttpError(409, `${s.name} is already in this channel`);
  const created = store.addSource(c.id, s);
  if (created.kind === 'wildcard') await resolveWildcard(created, { force: true });
  if (rebuildGuide) await rebuild(c.id);
  return store.getSource(created.id);
}

async function updateSourceOp(c, s, b, { rebuildGuide = true } = {}) {
  const options = { ...s.options };
  if (Array.isArray(b.excluded)) options.excluded = b.excluded.map(String);
  store.updateSourceOptions(s.id, options);
  if (b.refresh) await resolveWildcard(store.getSource(s.id), { force: true });
  if (rebuildGuide) await rebuild(c.id);
  return store.getSource(s.id);
}

async function deleteSourceOp(c, sourceId, { rebuildGuide = true } = {}) {
  store.deleteSource(sourceId);
  if (rebuildGuide) await rebuild(c.id);
}

async function addSlotOp(c, b, { rebuildGuide = true } = {}) {
  const slot = store.addSlot(c.id, slotInput(b));
  if (rebuildGuide) await rebuild(c.id);
  return slot;
}

async function updateSlotOp(c, s, b, { rebuildGuide = true } = {}) {
  const slot = store.updateSlot(s.id, slotInput(b));
  if (rebuildGuide) await rebuild(c.id);
  return slot;
}

async function deleteSlotOp(c, slotId, { rebuildGuide = true } = {}) {
  store.deleteSlot(slotId);
  if (rebuildGuide) await rebuild(c.id);
}

/** Try a stream addon against a well-known episode and report what the picker would accept. */
async function testAddonOp(url) {
  const base = addonBase(url);
  const out = { base: base.replace(/^(https?:\/\/[^/]+).*/, '$1/…') };
  try {
    const m = await fetchJson(`${base}/manifest.json`);
    out.name = m.name;
    out.resources = (m.resources || []).map((r) => (typeof r === 'string' ? r : r.name));
  } catch (e) {
    throw new HttpError(400, `Could not load the manifest: ${e.message}`);
  }
  const data = await fetchJson(`${base}/stream/series/tt1442437:1:1.json`, { timeoutMs: 30000 }).catch((e) => ({ error: e.message }));
  const streams = data.streams || [];
  const ranked = rankStreams(streams, { resolution: 1080, fallback: 'lower', options: {} }, store.getSettings().preferKeywords || []);
  out.total = streams.length;
  out.withUrl = streams.filter((s) => s.url).length;
  out.playable = ranked.length;
  out.sample = ranked.slice(0, 3).map((c) => ({ resolution: c.resolution, cached: c.cached, label: c.label.slice(0, 140) }));
  out.error = data.error;
  if (!out.withUrl && out.total) out.hint = 'This addon only returns torrents. Configure it with your debrid service (the debrid key goes into the addon URL) so it returns direct links.';
  else if (out.withUrl && !out.playable) out.hint = 'This addon returns direct links, but none looked cached or usable. If its labels mark cached results differently, StreamTube may need to learn that format.';
  return out;
}

/** Ranked debrid streams for a guide item. */
async function channelStreamsOp(c, item, { fresh = false } = {}) {
  let candidates = [];
  let error = null;
  try {
    candidates = await findStreams(item, c, { fresh });
  } catch (e) {
    error = e.message;
  }
  return {
    item: { ...item, label: itemLabel(item) },
    target: c.resolution,
    fallback: c.fallback,
    error,
    candidates: candidates.slice(0, 20).map((x) => ({ resolution: x.resolution, cached: x.cached, preferred: x.preferred, size: x.size, addon: x.addon, label: x.label })),
  };
}

export const ops = {
  channelInput, slotInput, contentInput, normTypes, rebuild, applySettings, exportBackup, importBackup, channelDetail,
  createChannel: createChannelOp, updateChannel: updateChannelOp, deleteChannel: deleteChannelOp,
  addSource: addSourceOp, updateSource: updateSourceOp, deleteSource: deleteSourceOp,
  addSlot: addSlotOp, updateSlot: updateSlotOp, deleteSlot: deleteSlotOp,
  testAddon: testAddonOp, channelStreams: channelStreamsOp,
};

export function registerApi(router) {
  router.get('/api/info', async (req, res) => {
    const caps = await ffmpegCaps();
    const base = baseUrl(req);
    send(res, 200, {
      serverTime: Date.now(),
      timezone: store.getSettings().timezone,
      baseUrl: base,
      manifestUrl: `${base}/manifest.json`,
      m3uUrl: `${base}/playlist.m3u`,
      epgUrl: `${base}/epg.xml`,
      ffmpeg: caps,
      resolutions: RESOLUTIONS,
      defaultResolution: store.getSettings().defaultResolution,
      authEnabled: !!config.adminPassword,
    });
  }, A);

  // --- settings
  router.get('/api/settings', (req, res) => send(res, 200, store.getSettings()), A);
  router.put('/api/settings', async (req, res) => {
    send(res, 200, await applySettings(await readJson(req)));
  }, A);

  // Try a stream addon against a well-known episode and report what the picker would accept.
  router.post('/api/test-addon', async (req, res) => {
    const { url } = await readJson(req);
    if (!url) throw new HttpError(400, 'Paste an addon URL');
    send(res, 200, await testAddonOp(url));
  }, A);

  // --- metadata search
  router.get('/api/search', async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const q = u.searchParams.get('q') || '';
    const type = u.searchParams.get('type') || 'all';
    const types = type === 'all' ? ['series', 'movie'] : normTypes(type);
    send(res, 200, { results: await search(q, types) });
  }, A);

  router.get('/api/wildcard', async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const pattern = u.searchParams.get('pattern') || '';
    const types = normTypes(u.searchParams.get('types') || 'series');
    try {
      send(res, 200, { pattern, types, results: await expandWildcard(pattern, types) });
    } catch (e) {
      throw new HttpError(400, e.message);
    }
  }, A);

  // --- channels
  router.get('/api/channels', (req, res) => send(res, 200, store.listChannels().map(channelDetail)), A);
  router.post('/api/channels', async (req, res) => {
    send(res, 201, channelDetail(await createChannelOp(await readJson(req))));
  }, A);
  router.get('/api/channels/:id', (req, res, { id }) => send(res, 200, channelDetail(requireChannel(id))), A);
  router.put('/api/channels/:id', async (req, res, { id }) => {
    const cur = requireChannel(id);
    send(res, 200, channelDetail(await updateChannelOp(cur, await readJson(req))));
  }, A);
  router.delete('/api/channels/:id', (req, res, { id }) => {
    deleteChannelOp(requireChannel(id));
    send(res, 200, { ok: true });
  }, A);
  router.post('/api/channels/:id/rebuild', async (req, res, { id }) => {
    requireChannel(id);
    await rebuild(id);
    send(res, 200, { ok: true });
  }, A);

  // --- auto-fill pool
  router.post('/api/channels/:id/sources', async (req, res, { id }) => {
    const c = requireChannel(id);
    send(res, 201, await addSourceOp(c, await readJson(req)));
  }, A);
  router.put('/api/channels/:id/sources/:sid', async (req, res, { id, sid }) => {
    const c = requireChannel(id);
    const s = store.getSource(sid);
    if (!s || s.channel_id !== c.id) throw new HttpError(404, 'Not found');
    send(res, 200, await updateSourceOp(c, s, await readJson(req)));
  }, A);
  router.delete('/api/channels/:id/sources/:sid', async (req, res, { id, sid }) => {
    await deleteSourceOp(requireChannel(id), sid);
    send(res, 200, { ok: true });
  }, A);

  // --- time slots
  router.post('/api/channels/:id/slots', async (req, res, { id }) => {
    send(res, 201, await addSlotOp(requireChannel(id), await readJson(req)));
  }, A);
  router.put('/api/channels/:id/slots/:sid', async (req, res, { id, sid }) => {
    const c = requireChannel(id);
    const s = store.getSlot(sid);
    if (!s || s.channel_id !== c.id) throw new HttpError(404, 'Not found');
    send(res, 200, await updateSlotOp(c, s, await readJson(req)));
  }, A);
  router.delete('/api/channels/:id/slots/:sid', async (req, res, { id, sid }) => {
    await deleteSlotOp(requireChannel(id), sid);
    send(res, 200, { ok: true });
  }, A);

  // --- guide
  router.get('/api/guide', (req, res) => {
    const u = new URL(req.url, 'http://x');
    const now = Date.now();
    const from = Number(u.searchParams.get('from')) || now - 3600e3;
    const to = Number(u.searchParams.get('to')) || now + 6 * 3600e3;
    const live = new Map(runnerStatus().map((r) => [r.channelId, r]));
    const channels = store.listChannels().map((c) => ({
      id: c.id, number: c.number, name: c.name, logo: c.logo, enabled: !!c.enabled, resolution: c.resolution,
      live: live.get(c.id) || null,
      items: store.epgRange(c.id, from, to).map((r) => ({
        id: r.id, start: r.start, end: r.end, type: r.type, title: r.title, label: itemLabel(r), episode_title: r.episode_title,
        season: r.season, episode: r.episode, poster: r.poster, description: r.description, origin: r.origin, truncated: !!r.truncated,
        meta_id: r.meta_id, video_id: r.video_id,
      })),
    }));
    send(res, 200, { serverTime: now, from, to, channels });
  }, A);

  // Which debrid stream would the picker choose for what's on now (or a given guide item)?
  router.get('/api/channels/:id/streams', async (req, res, { id }) => {
    const c = requireChannel(id);
    const u = new URL(req.url, 'http://x');
    const epgId = Number(u.searchParams.get('item'));
    const item = epgId ? store.get('SELECT * FROM epg WHERE id = ? AND channel_id = ?', epgId, c.id) : store.epgAt(c.id, Date.now());
    if (!item) throw new HttpError(404, 'Nothing scheduled');
    send(res, 200, await channelStreamsOp(c, item, { fresh: u.searchParams.get('fresh') === '1' }));
  }, A);

  router.get('/api/status', (req, res) => send(res, 200, { runners: runnerStatus() }), A);

  // --- backup / restore
  router.get('/api/backup', (req, res) => {
    const includeSettings = new URL(req.url, 'http://x').searchParams.get('settings') === '1';
    const date = new Date().toISOString().slice(0, 10);
    send(res, 200, JSON.stringify(exportBackup({ includeSettings }), null, 2), {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="streamtube-backup-${date}.json"`,
    });
  }, A);
  router.post('/api/restore', async (req, res) => {
    const b = await readJson(req, 20 * 1024 * 1024);
    send(res, 200, await importBackup(b.backup, { replace: !!b.replace, includeSettings: !!b.includeSettings }));
  }, A);
}
