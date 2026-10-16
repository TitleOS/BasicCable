import { store } from './db.js';
import { config } from './config.js';
import { send, readJson, baseUrl, HttpError } from './http.js';
import { search, expandWildcard, fetchJson } from './metadata.js';
import { buildChannel, resolveWildcard, itemLabel } from './scheduler.js';
import { findStreams, rankStreams, addonBase, RESOLUTIONS } from './picker.js';
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

function channelDetail(c) {
  return { ...c, sources: store.listSources(c.id), slots: store.listSlots(c.id) };
}

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
    const b = await readJson(req);
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
    const before = store.getSettings();
    const after = store.saveSettings(patch);
    if (patch.timezone && patch.timezone !== before.timezone) {
      for (const c of store.listChannels()) await rebuild(c.id);
    }
    send(res, 200, after);
  }, A);

  // Try a stream addon against a well-known episode and report what the picker would accept.
  router.post('/api/test-addon', async (req, res) => {
    const { url } = await readJson(req);
    if (!url) throw new HttpError(400, 'Paste an addon URL');
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
    const ranked = rankStreams(streams, { resolution: 1080, fallback: 'lower', options: {} });
    out.total = streams.length;
    out.withUrl = streams.filter((s) => s.url).length;
    out.playable = ranked.length;
    out.sample = ranked.slice(0, 3).map((c) => ({ resolution: c.resolution, cached: c.cached, label: c.label.slice(0, 140) }));
    out.error = data.error;
    if (!out.withUrl && out.total) out.hint = 'This addon only returns torrents. Configure it with your debrid service (the debrid key goes into the addon URL) so it returns direct links.';
    else if (out.withUrl && !out.playable) out.hint = 'This addon returns direct links, but none looked cached or usable. If its labels mark cached results differently, StreamTube may need to learn that format.';
    send(res, 200, out);
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
    const b = await readJson(req);
    const input = channelInput({ resolution: store.getSettings().defaultResolution, options: {}, ...b });
    const c = store.createChannel(input);
    send(res, 201, channelDetail(c));
  }, A);
  router.get('/api/channels/:id', (req, res, { id }) => send(res, 200, channelDetail(requireChannel(id))), A);
  router.put('/api/channels/:id', async (req, res, { id }) => {
    const cur = requireChannel(id);
    const b = await readJson(req);
    const c = store.updateChannel(cur.id, channelInput(b, true));
    const scheduleChanged = ['fill_mode', 'round_minutes'].some((k) => b[k] !== undefined && b[k] !== cur[k]) ||
      (b.options && !!b.options.includeSpecials !== !!cur.options.includeSpecials);
    if (scheduleChanged) await rebuild(c.id);
    else if (b.resolution !== undefined || b.options || b.fallback !== undefined || b.enabled !== undefined) stopRunner(c.id);
    send(res, 200, channelDetail(c));
  }, A);
  router.delete('/api/channels/:id', (req, res, { id }) => {
    stopRunner(id);
    store.deleteChannel(id);
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
    const s = contentInput(await readJson(req));
    if (s.kind === 'pool') throw new HttpError(400, 'Pick a show, movie or wildcard');
    const dup = store.listSources(c.id).find((x) => x.kind === s.kind && x.ref.toLowerCase() === s.ref.toLowerCase());
    if (dup) throw new HttpError(409, `${s.name} is already in this channel`);
    const created = store.addSource(c.id, s);
    if (created.kind === 'wildcard') await resolveWildcard(created, { force: true });
    await rebuild(c.id);
    send(res, 201, store.getSource(created.id));
  }, A);
  router.put('/api/channels/:id/sources/:sid', async (req, res, { id, sid }) => {
    const c = requireChannel(id);
    const s = store.getSource(sid);
    if (!s || s.channel_id !== c.id) throw new HttpError(404, 'Not found');
    const b = await readJson(req);
    const options = { ...s.options };
    if (Array.isArray(b.excluded)) options.excluded = b.excluded.map(String);
    store.updateSourceOptions(s.id, options);
    if (b.refresh) await resolveWildcard(store.getSource(s.id), { force: true });
    await rebuild(c.id);
    send(res, 200, store.getSource(s.id));
  }, A);
  router.delete('/api/channels/:id/sources/:sid', async (req, res, { id, sid }) => {
    const c = requireChannel(id);
    store.deleteSource(sid);
    await rebuild(c.id);
    send(res, 200, { ok: true });
  }, A);

  // --- time slots
  router.post('/api/channels/:id/slots', async (req, res, { id }) => {
    const c = requireChannel(id);
    const slot = store.addSlot(c.id, slotInput(await readJson(req)));
    await rebuild(c.id);
    send(res, 201, slot);
  }, A);
  router.put('/api/channels/:id/slots/:sid', async (req, res, { id, sid }) => {
    const c = requireChannel(id);
    const s = store.getSlot(sid);
    if (!s || s.channel_id !== c.id) throw new HttpError(404, 'Not found');
    const slot = store.updateSlot(s.id, slotInput(await readJson(req)));
    await rebuild(c.id);
    send(res, 200, slot);
  }, A);
  router.delete('/api/channels/:id/slots/:sid', async (req, res, { id, sid }) => {
    const c = requireChannel(id);
    store.deleteSlot(sid);
    await rebuild(c.id);
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
    let candidates = [];
    let error = null;
    try {
      candidates = await findStreams(item, c, { fresh: u.searchParams.get('fresh') === '1' });
    } catch (e) {
      error = e.message;
    }
    send(res, 200, {
      item: { ...item, label: itemLabel(item) },
      target: c.resolution,
      fallback: c.fallback,
      error,
      candidates: candidates.slice(0, 20).map((x) => ({ resolution: x.resolution, cached: x.cached, size: x.size, addon: x.addon, label: x.label })),
    });
  }, A);

  router.get('/api/status', (req, res) => send(res, 200, { runners: runnerStatus() }), A);
}
