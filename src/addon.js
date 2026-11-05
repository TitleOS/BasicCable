import fs from 'node:fs';
import { VERSION } from './config.js';
import { store } from './db.js';
import { send, baseUrl, clientIp, HttpError } from './http.js';
import { itemLabel } from './scheduler.js';
import { getRunner, peekRunner, tuneIn, mayWatch } from './playout.js';
import { findStreams } from './picker.js';
import { preparedFor } from './prefetch.js';
import { artUrl, artFile, ensureArt } from './art.js';
import { lineup } from './labels.js';

const PREFIX = 'basiccable:';
const CATALOG_ID = 'basiccable-channels';

function channelFromId(id) {
  if (!id.startsWith(PREFIX)) return null;
  return store.getChannel(Number(id.slice(PREFIX.length)));
}

function clock(ms) {
  const zone = store.getSettings().timezone;
  try {
    return new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: zone });
  } catch {
    return new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }
}

function mmss(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

function nowNext(channel) {
  const now = Date.now();
  const cur = store.epgAt(channel.id, now);
  const next = cur ? store.epgAfter(channel.id, cur.start) : store.epgAfter(channel.id, now);
  return { now, cur, next };
}

/**
 * Stremio keeps catalog rows (and often channel details) for the whole app session, so the tile carries
 * nothing that goes stale: the channel's art and its lineup. What's on now lives in the stream list, which
 * Stremio fetches fresh every time. The details view still gets the current episode's background, which
 * Stremio shows behind the stream list and the loading screen.
 */
function channelMeta(channel, req, full = false) {
  const art = artUrl(baseUrl(req), channel);
  const meta = {
    id: PREFIX + channel.id,
    type: 'tv',
    name: `${channel.number} · ${channel.name}`,
    poster: channel.logo || art,
    posterShape: channel.logo ? 'square' : 'landscape',
    background: art,
    description: lineup(channel.id),
    genres: ['Basic Cable'],
    runtime: 'LIVE',
    // Without videos, Stremio needs defaultVideoId (also on catalog previews) to know which streams to load.
    behaviorHints: { defaultVideoId: PREFIX + channel.id, isLive: true },
  };
  if (full) {
    const cur = store.epgAt(channel.id, Date.now());
    meta.background = cur?.background || cur?.poster || art;
    if (channel.logo) meta.logo = channel.logo;
    meta.releaseInfo = 'Live TV';
  }
  return meta;
}

const NO_CACHE = { 'cache-control': 'no-cache, max-age=0' };

export function registerAddon(router) {
  router.get('/manifest.json', (req, res) => {
    send(res, 200, {
      id: 'community.basiccable.livetv',
      version: VERSION,
      name: 'Basic Cable',
      description: 'Virtual live TV channels built from your own schedule, streamed through your debrid addons.',
      logo: `${baseUrl(req)}/icon.svg`,
      resources: ['catalog', 'meta', 'stream'],
      types: ['tv'],
      idPrefixes: [PREFIX],
      catalogs: [{ type: 'tv', id: CATALOG_ID, name: 'Basic Cable' }],
      behaviorHints: { configurable: true, configurationRequired: false },
    });
  });

  router.get('/configure', (req, res) => send(res, 302, '', { location: `${baseUrl(req)}/` }));

  const catalog = (req, res) => {
    const metas = store.listChannels().filter((c) => c.enabled).map((c) => channelMeta(c, req));
    send(res, 200, { metas }, NO_CACHE);
  };
  router.get(`/catalog/tv/${CATALOG_ID}.json`, catalog);
  router.get(`/catalog/tv/${CATALOG_ID}/:extra.json`, catalog);

  router.get('/meta/tv/:id.json', (req, res, { id }) => {
    const channel = channelFromId(id);
    if (!channel) return send(res, 200, { meta: null });
    send(res, 200, { meta: channelMeta(channel, req, true) }, NO_CACHE);
  });

  router.get('/stream/tv/:id.json', (req, res, { id }) => {
    const channel = channelFromId(id);
    if (!channel) return send(res, 200, { streams: [] });
    const base = baseUrl(req);
    const { now, cur, next } = nowNext(channel);
    const desc = [
      cur ? `▶ ${itemLabel(cur)} · ${mmss((now - cur.start) / 1000)} / ${mmss((cur.end - cur.start) / 1000)}` : 'Nothing on right now',
      next ? `Next ${clock(next.start)}: ${itemLabel(next)}` : '',
    ].filter(Boolean).join('\n');
    // Only `title`: Stremio treats it as an alias of `description`, and sending both makes it reject the stream.
    const streams = [{
      name: `Basic Cable\nLive ${channel.resolution}p`,
      title: desc,
      url: `${base}/live/${channel.id}/index.m3u8`,
      behaviorHints: { bingeGroup: `basiccable-${channel.id}` },
    }];
    if (cur) {
      streams.push({
        name: 'Basic Cable\nStart over',
        title: `${itemLabel(cur)} from the beginning (direct debrid link)`,
        url: `${base}/direct/${channel.id}/${cur.id}`,
        behaviorHints: { notWebReady: true, bingeGroup: `basiccable-direct-${channel.id}` },
      });
    }
    send(res, 200, { streams }, NO_CACHE);
  });

  // --- live HLS
  // index.m3u8 is the one "tune in" request: it is always a master playlist, so players refresh video.m3u8
  // afterwards. Everything else checks that this viewer hasn't since tuned in to another channel.
  const M3U8 = { 'content-type': 'application/vnd.apple.mpegurl', 'cache-control': 'no-cache, no-store' };
  const watching = (req, id) => {
    const ip = clientIp(req);
    if (!mayWatch(ip, id)) throw new HttpError(409, 'This device is now watching another channel');
    return ip;
  };
  const liveRunner = async (id, ip) => {
    const channel = store.getChannel(id);
    if (!channel || !channel.enabled) throw new HttpError(404, 'No such channel');
    const runner = await getRunner(channel.id);
    runner.touch(ip);
    const ok = await runner.waitReady();
    if (!ok) throw new HttpError(503, runner.status.message || 'Channel is still tuning, try again');
    return { channel, runner };
  };

  router.get('/live/:id/index.m3u8', async (req, res, { id }) => {
    const channel = store.getChannel(id);
    if (!channel || !channel.enabled) throw new HttpError(404, 'No such channel');
    const ip = clientIp(req);
    await getRunner(channel.id);
    tuneIn(ip, channel.id);
    await liveRunner(channel.id, ip);
    // With subtitles on, an English caption track (filled whenever the current program has a text subtitle).
    // CLOSED-CAPTIONS=NONE: without it ExoPlayer offers an "Unknown" CEA-608 track that is almost always empty.
    const subs = (channel.options?.subtitles || 'auto') !== 'off';
    send(res, 200, [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      subs ? '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,FORCED=NO,URI="subs.m3u8"' : null,
      `#EXT-X-STREAM-INF:BANDWIDTH=8000000,CLOSED-CAPTIONS=NONE${subs ? ',SUBTITLES="subs"' : ''}`,
      'video.m3u8',
      '',
    ].filter((l) => l !== null).join('\n'), M3U8);
  });
  router.get('/live/:id/video.m3u8', async (req, res, { id }) => {
    const { runner } = await liveRunner(id, watching(req, id));
    send(res, 200, runner.playlist('video'), M3U8);
  });
  router.get('/live/:id/subs.m3u8', async (req, res, { id }) => {
    const { runner } = await liveRunner(id, watching(req, id));
    send(res, 200, runner.playlist('subs'), M3U8);
  });
  router.get('/live/:id/sub/:name', async (req, res, { id, name }) => {
    const ip = watching(req, id);
    const runner = peekRunner(id);
    if (!runner) throw new HttpError(404, 'Channel not running');
    runner.touch(ip);
    send(res, 200, await runner.subtitleSegment(name), { 'content-type': 'text/vtt; charset=utf-8', 'cache-control': 'max-age=60' });
  });

  router.get('/live/:id/:segment', (req, res, { id, segment }) => {
    const ip = watching(req, id);
    const runner = peekRunner(id);
    const file = runner?.segmentPath(segment);
    if (!file) throw new HttpError(404, 'Segment gone');
    runner.touch(ip);
    let stat;
    try { stat = fs.statSync(file); } catch { throw new HttpError(404, 'Segment gone'); }
    res.writeHead(200, { 'content-type': 'video/mp2t', 'content-length': stat.size, 'access-control-allow-origin': '*', 'cache-control': 'max-age=60' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });

  // "Start over": redirect straight to the best debrid link for that guide item.
  router.get('/direct/:id/:epgId', async (req, res, { id, epgId }) => {
    const channel = store.getChannel(id);
    const item = channel && store.get('SELECT * FROM epg WHERE id = ? AND channel_id = ?', Number(epgId), channel.id);
    if (!item) throw new HttpError(404, 'That program is no longer in the guide');
    const best = preparedFor(item, channel)?.cand || (await findStreams(item, channel))[0];
    if (!best) throw new HttpError(404, 'No cached debrid stream found');
    send(res, 302, '', { location: best.url });
  });

  // --- IPTV-style outputs for other players (VLC, Kodi, TiviMate, Jellyfin...)
  router.get('/playlist.m3u', (req, res) => {
    const base = baseUrl(req);
    const lines = [`#EXTM3U x-tvg-url="${base}/epg.xml"`];
    for (const c of store.listChannels().filter((x) => x.enabled)) {
      const logo = c.logo || artUrl(base, c);
      lines.push(`#EXTINF:-1 tvg-id="basiccable.${c.id}" tvg-chno="${c.number}" tvg-name="${c.name}" tvg-logo="${logo}" group-title="Basic Cable",${c.name}`);
      lines.push(`${base}/live/${c.id}/index.m3u8`);
    }
    send(res, 200, lines.join('\n') + '\n', { 'content-type': 'audio/x-mpegurl; charset=utf-8' });
  });

  router.get('/epg.xml', (req, res) => {
    const base = baseUrl(req);
    const x = (s) => String(s ?? '').replace(/[<>&"']/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[ch]));
    const t = (ms) => new Date(ms).toISOString().replace(/[-:T]/g, '').slice(0, 14) + ' +0000';
    const out = ['<?xml version="1.0" encoding="UTF-8"?>', '<tv generator-info-name="Basic Cable">'];
    const channels = store.listChannels().filter((c) => c.enabled);
    for (const c of channels) {
      out.push(`  <channel id="basiccable.${c.id}"><display-name>${x(c.name)}</display-name><display-name>${c.number}</display-name><icon src="${x(c.logo || artUrl(base, c))}"/></channel>`);
    }
    const now = Date.now();
    for (const c of channels) {
      for (const r of store.epgRange(c.id, now - 6 * 3600e3, now + 48 * 3600e3)) {
        out.push(`  <programme start="${t(r.start)}" stop="${t(r.end)}" channel="basiccable.${c.id}">`);
        out.push(`    <title>${x(r.title)}</title>`);
        if (r.episode_title) out.push(`    <sub-title>${x(r.episode_title)}</sub-title>`);
        if (r.description) out.push(`    <desc>${x(r.description)}</desc>`);
        if (r.season != null) out.push(`    <episode-num system="xmltv_ns">${r.season - 1}.${r.episode - 1}.</episode-num>`);
        if (r.poster) out.push(`    <icon src="${x(r.poster)}"/>`);
        out.push(`    <category>${r.type === 'movie' ? 'Movie' : 'Series'}</category>`);
        out.push('  </programme>');
      }
    }
    out.push('</tv>');
    send(res, 200, out.join('\n'), { 'content-type': 'application/xml; charset=utf-8' });
  });

  // Channel art (see art.js). The file name carries a version key, so it can be cached forever.
  router.get('/art/:file', async (req, res, { file }) => {
    const m = file.match(/^(\d+)-([0-9a-f]+)\.png$/);
    const c = m && store.getChannel(Number(m[1]));
    if (!c) throw new HttpError(404, 'No such channel');
    if (file !== artFile(c)) return send(res, 302, '', { location: artUrl(baseUrl(req), c) }); // renamed since
    const path = await ensureArt(c);
    const stat = fs.statSync(path);
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': stat.size, 'cache-control': 'public, max-age=31536000, immutable', 'access-control-allow-origin': '*' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(path).pipe(res);
  });
  // Older playlists linked an SVG logo; send them to the art.
  router.get('/logo/:id.svg', (req, res, { id }) => {
    const c = store.getChannel(id);
    if (!c) throw new HttpError(404, 'No such channel');
    send(res, 302, '', { location: artUrl(baseUrl(req), c) });
  });
}
