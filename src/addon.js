import fs from 'node:fs';
import { store } from './db.js';
import { send, baseUrl, clientIp, HttpError } from './http.js';
import { itemLabel } from './scheduler.js';
import { getRunner, peekRunner, tuneIn, mayWatch } from './playout.js';
import { findStreams } from './picker.js';

const PREFIX = 'streamtube:';
const CATALOG_ID = 'streamtube-channels';
const VERSION = '0.1.0';

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

function channelMeta(channel, req, full = false) {
  const base = baseUrl(req);
  const { now, cur, next } = nowNext(channel);
  const lines = [];
  if (cur) lines.push(`Now: ${itemLabel(cur)} (${mmss((now - cur.start) / 1000)} in)`);
  if (next) lines.push(`Next at ${clock(next.start)}: ${itemLabel(next)}`);
  if (!cur && !next) lines.push('Nothing scheduled yet');
  const meta = {
    id: PREFIX + channel.id,
    type: 'tv',
    name: `${channel.number} · ${channel.name}`,
    poster: channel.logo || cur?.poster || `${base}/logo/${channel.id}.svg`,
    posterShape: channel.logo ? 'square' : 'poster',
    logo: channel.logo || undefined,
    background: cur?.background || cur?.poster || undefined,
    description: lines.join('\n'),
    genres: ['StreamTube'],
    runtime: 'LIVE',
    // Without videos, Stremio needs defaultVideoId (also on catalog previews) to know which streams to load.
    behaviorHints: { defaultVideoId: PREFIX + channel.id, isLive: true },
  };
  if (full) meta.releaseInfo = cur ? `${clock(cur.start)} – ${clock(cur.end)}` : '';
  return meta;
}

export function registerAddon(router) {
  router.get('/manifest.json', (req, res) => {
    send(res, 200, {
      id: 'dev.streamtube.livetv',
      version: VERSION,
      name: 'StreamTube',
      description: 'Virtual live TV channels built from your own schedule, streamed through your debrid addons.',
      logo: `${baseUrl(req)}/icon.svg`,
      resources: ['catalog', 'meta', 'stream'],
      types: ['tv'],
      idPrefixes: [PREFIX],
      catalogs: [{ type: 'tv', id: CATALOG_ID, name: 'StreamTube' }],
      behaviorHints: { configurable: true, configurationRequired: false },
    });
  });

  router.get('/configure', (req, res) => send(res, 302, '', { location: `${baseUrl(req)}/` }));

  const catalog = (req, res) => {
    const metas = store.listChannels().filter((c) => c.enabled).map((c) => channelMeta(c, req));
    send(res, 200, { metas, cacheMaxAge: 60 });
  };
  router.get(`/catalog/tv/${CATALOG_ID}.json`, catalog);
  router.get(`/catalog/tv/${CATALOG_ID}/:extra.json`, catalog);

  router.get('/meta/tv/:id.json', (req, res, { id }) => {
    const channel = channelFromId(id);
    if (!channel) return send(res, 200, { meta: null });
    send(res, 200, { meta: channelMeta(channel, req, true), cacheMaxAge: 30 });
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
      name: `StreamTube\nLive ${channel.resolution}p`,
      title: desc,
      url: `${base}/live/${channel.id}/index.m3u8`,
      behaviorHints: { bingeGroup: `streamtube-${channel.id}` },
    }];
    if (cur) {
      streams.push({
        name: 'StreamTube\nStart over',
        title: `${itemLabel(cur)} from the beginning (direct debrid link)`,
        url: `${base}/direct/${channel.id}/${cur.id}`,
        behaviorHints: { notWebReady: true, bingeGroup: `streamtube-direct-${channel.id}` },
      });
    }
    send(res, 200, { streams, cacheMaxAge: 0 });
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
    const subs = (channel.options?.subtitles || 'auto') !== 'off';
    send(res, 200, [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      subs ? '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,FORCED=NO,URI="subs.m3u8"' : null,
      `#EXT-X-STREAM-INF:BANDWIDTH=8000000${subs ? ',SUBTITLES="subs"' : ''}`,
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
    const [best] = await findStreams(item, channel);
    if (!best) throw new HttpError(404, 'No cached debrid stream found');
    send(res, 302, '', { location: best.url });
  });

  // --- IPTV-style outputs for other players (VLC, Kodi, TiviMate, Jellyfin...)
  router.get('/playlist.m3u', (req, res) => {
    const base = baseUrl(req);
    const lines = [`#EXTM3U x-tvg-url="${base}/epg.xml"`];
    for (const c of store.listChannels().filter((x) => x.enabled)) {
      const logo = c.logo || `${base}/logo/${c.id}.svg`;
      lines.push(`#EXTINF:-1 tvg-id="streamtube.${c.id}" tvg-chno="${c.number}" tvg-name="${c.name}" tvg-logo="${logo}" group-title="StreamTube",${c.name}`);
      lines.push(`${base}/live/${c.id}/index.m3u8`);
    }
    send(res, 200, lines.join('\n') + '\n', { 'content-type': 'audio/x-mpegurl; charset=utf-8' });
  });

  router.get('/epg.xml', (req, res) => {
    const base = baseUrl(req);
    const x = (s) => String(s ?? '').replace(/[<>&"']/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[ch]));
    const t = (ms) => new Date(ms).toISOString().replace(/[-:T]/g, '').slice(0, 14) + ' +0000';
    const out = ['<?xml version="1.0" encoding="UTF-8"?>', '<tv generator-info-name="StreamTube">'];
    const channels = store.listChannels().filter((c) => c.enabled);
    for (const c of channels) {
      out.push(`  <channel id="streamtube.${c.id}"><display-name>${x(c.name)}</display-name><display-name>${c.number}</display-name><icon src="${x(c.logo || `${base}/logo/${c.id}.svg`)}"/></channel>`);
    }
    const now = Date.now();
    for (const c of channels) {
      for (const r of store.epgRange(c.id, now - 6 * 3600e3, now + 48 * 3600e3)) {
        out.push(`  <programme start="${t(r.start)}" stop="${t(r.end)}" channel="streamtube.${c.id}">`);
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

  router.get('/logo/:id.svg', (req, res, { id }) => {
    const c = store.getChannel(id);
    if (!c) throw new HttpError(404, 'No such channel');
    const hue = (c.id * 67) % 360;
    const name = c.name.replace(/[<>&]/g, '');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450" viewBox="0 0 300 450">
<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="hsl(${hue},55%,32%)"/><stop offset="1" stop-color="hsl(${(hue + 40) % 360},50%,14%)"/></linearGradient></defs>
<rect width="300" height="450" fill="url(#g)"/>
<text x="150" y="215" font-family="Helvetica,Arial,sans-serif" font-size="120" font-weight="700" fill="#fff" text-anchor="middle">${c.number}</text>
<text x="150" y="290" font-family="Helvetica,Arial,sans-serif" font-size="30" fill="#fff" fill-opacity=".85" text-anchor="middle">${name.length > 16 ? name.slice(0, 15) + '…' : name}</text>
</svg>`;
    send(res, 200, svg, { 'content-type': 'image/svg+xml', 'cache-control': 'max-age=300' });
  });
}
