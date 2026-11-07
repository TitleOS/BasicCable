// Utility channels: channels Basic Cable generates itself instead of playing files, such as the local weather
// forecast with music. Each is an ordinary channel row whose options.utility says what it is; the scheduler
// fills its guide with hourly blocks and the runner draws it live.

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { DateTime } from 'luxon';
import { store } from './db.js';
import { config, log } from './config.js';
import { geocode, fetchForecast, UNITS, MIN_DAYS, MAX_DAYS } from './weather.js';
import { weatherCard } from './weathercard.js';
import { ensureSet, setStatus, knownSet } from './music.js';
import { DEFAULT_SOURCES, MAX_FEEDS, checkFeed, feedUrl, activeSources, fetchHeadlines, sourceStatus, bingImages, keptBingImages } from './news.js';
import { newsCard, newsLayout, tickerStrip } from './newscard.js';

const HOUR = 3600e3;
const FORECAST_TTL = 15 * 60 * 1000;

export const UTILITY_KINDS = {
  weather: {
    name: 'Weather',
    channelName: 'Weather',
    description: 'Current conditions and the forecast for your area, with classical music. Highs with the sunrise time, lows with tonight\'s moon, and how the humidity will feel.',
    defaults: { place: '', days: 5, units: 'F', music: 'classical' },
  },
  news: {
    name: 'News',
    channelName: 'News',
    description: 'Headlines from AP, NPR and PBS, and any RSS feeds you add, scrolling over Bing\'s picture of the day, with jazz played quietly.',
    defaults: { sources: { ap: true, npr: true, pbs: true }, feeds: [], music: 'jazz' },
    musicGainDb: -9, // the user asked for the music low
  },
};

export const utilityOf = (channel) => channel?.options?.utility || null;
export const isUtilityItem = (item) => item?.type === 'utility';

/** The channel a utility kind runs on, if it's enabled. */
export function utilityChannel(kind) {
  return store.listChannels().find((c) => c.options?.utility?.kind === kind) || null;
}

/**
 * Validate a utility's settings; resolves the place (a network lookup) when it changed. For the news
 * channel, feeds that are new are fetched and checked: ones that aren't RSS or Atom are left out and listed
 * in `notes.rejected` ([{ url, reason }]) so the UI can say so, as the user asked.
 */
export async function utilityConfig(kind, body, previous = null, notes = {}) {
  const def = UTILITY_KINDS[kind];
  if (!def) throw Object.assign(new Error(`No utility channel called "${kind}"`), { status: 404 });
  const cfg = { ...def.defaults, ...(previous || {}), kind };
  if (kind === 'news') {
    if (body.music !== undefined) {
      if (!knownSet(String(body.music))) throw Object.assign(new Error('Unknown music set'), { status: 400 });
      cfg.music = String(body.music);
    }
    if (body.sources !== undefined) {
      if (!body.sources || typeof body.sources !== 'object') throw Object.assign(new Error('sources must be an object of source: true/false'), { status: 400 });
      cfg.sources = {};
      for (const key of Object.keys(DEFAULT_SOURCES)) cfg.sources[key] = body.sources[key] !== false && body.sources[key] !== 'false' && body.sources[key] !== 0;
    }
    if (body.feeds !== undefined) {
      const list = Array.isArray(body.feeds) ? body.feeds : String(body.feeds).split(/[\n,]+/);
      const known = new Map((previous?.feeds || []).map((f) => [f.url, f]));
      const feeds = [];
      const rejected = [];
      for (const raw of list.map((s) => (typeof s === 'string' ? s : s?.url)).map((s) => String(s || '').trim()).filter(Boolean)) {
        if (feeds.length >= MAX_FEEDS) { rejected.push({ url: raw, reason: `at most ${MAX_FEEDS} feeds` }); continue; }
        let url;
        try { url = feedUrl(raw); } catch (e) { rejected.push({ url: raw, reason: e.message }); continue; }
        if (feeds.some((f) => f.url === url)) continue;
        if (known.has(url)) { feeds.push(known.get(url)); continue; } // accepted before: no second check
        try {
          feeds.push(await checkFeed(url, { fetchImpl: notes.fetchImpl }));
        } catch (e) {
          rejected.push({ url: raw, reason: e.message });
        }
      }
      cfg.feeds = feeds;
      notes.rejected = rejected;
    }
    if (!activeSources(cfg).length) throw Object.assign(new Error('Turn on at least one source or add a feed'), { status: 400 });
  }
  if (kind === 'weather') {
    if (body.days !== undefined) {
      const d = parseInt(body.days, 10);
      if (!(d >= MIN_DAYS && d <= MAX_DAYS)) throw Object.assign(new Error(`Forecast length must be ${MIN_DAYS} to ${MAX_DAYS} days`), { status: 400 });
      cfg.days = d;
    }
    if (body.units !== undefined) {
      const u = String(body.units).trim().toUpperCase().replace(/^°/, '');
      if (!UNITS.includes(u)) throw Object.assign(new Error('Units must be F, C or K'), { status: 400 });
      cfg.units = u;
    }
    if (body.music !== undefined) {
      if (!knownSet(String(body.music))) throw Object.assign(new Error('Unknown music set'), { status: 400 });
      cfg.music = String(body.music);
    }
    if (body.place !== undefined) {
      const place = String(body.place).trim();
      if (place !== cfg.place || !cfg.resolved) {
        if (!place) throw Object.assign(new Error('Enter a zip or postal code'), { status: 400 });
        try {
          cfg.resolved = await geocode(place);
        } catch (e) {
          throw Object.assign(new Error(e.message), { status: 400 });
        }
        cfg.place = place;
      }
    }
    if (!cfg.place || !cfg.resolved) throw Object.assign(new Error('Enter a zip or postal code'), { status: 400 });
  }
  return cfg;
}

/** What the web UI shows: every utility kind with its channel (if enabled), settings and music status. */
export function listUtilities() {
  return Object.entries(UTILITY_KINDS).map(([kind, def]) => {
    const channel = utilityChannel(kind);
    const cfg = channel ? { ...def.defaults, ...channel.options.utility } : { ...def.defaults, kind };
    return {
      kind, name: def.name, description: def.description, enabled: !!channel,
      channel: channel ? { id: channel.id, number: channel.number, name: channel.name, enabled: !!channel.enabled, resolution: channel.resolution } : null,
      config: { ...cfg, resolved: cfg.resolved || null },
      music: cfg.music ? setStatus(cfg.music) : null,
      sources: kind === 'news' ? sourceStatus(cfg) : undefined,
      defaultSources: kind === 'news' ? Object.fromEntries(Object.entries(DEFAULT_SOURCES).map(([k, d]) => [k, { name: d.name, url: d.url }])) : undefined,
    };
  });
}

/** "AP, NPR and PBS" or "NPR, PBS and 2 feeds of your own": the sources a news config reads, for descriptions. */
export function sourcesLabel(cfg) {
  const names = activeSources(cfg).map((s) => s.tag);
  if (!names.length) return 'no sources';
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

// ---------------------------------------------------------------------------
// guide

/** The place as shown in the guide: "Saint Paul, MN". */
export function placeLabel(cfg) {
  const r = cfg?.resolved;
  return r ? [r.name, r.region].filter(Boolean).join(', ') : cfg?.place || '';
}

/** Hourly guide rows for a utility channel from `from` to `to`, aligned to the hour in `zone`. */
export function utilityRows(channel, from, to, zone) {
  const u = utilityOf(channel);
  if (!u) return [];
  const rows = [];
  let t = from;
  const { title, subtitle, description } = utilityText(u);
  while (t < to) {
    const end = Math.min(to, DateTime.fromMillis(t, { zone }).plus({ hours: 1 }).startOf('hour').toMillis());
    if (end <= t) break;
    rows.push({
      start: t, end, type: 'utility', meta_id: `utility:${u.kind}`, video_id: `utility:${u.kind}:${t}`,
      title, episode_title: subtitle, season: null, episode: null, poster: '', background: '',
      description, origin: 'utility', truncated: 0, cursor_prev: {},
    });
    t = end;
  }
  return rows;
}

/** How a utility's programs read in the guide and in Stremio: { title, subtitle, description }. */
export function utilityText(u) {
  if (u?.kind === 'weather') {
    const where = placeLabel(u);
    return { title: 'Local Forecast', subtitle: where, description: `Current conditions and the ${u.days}-day forecast for ${where || 'your area'}, with classical music.` };
  }
  if (u?.kind === 'news') {
    const srcs = sourcesLabel(u);
    return { title: 'Headlines', subtitle: activeSources(u).map((s) => s.tag).join(' · '), description: `The latest headlines from ${srcs}, over Bing's picture of the day, with jazz.` };
  }
  const def = UTILITY_KINDS[u?.kind];
  return { title: def?.name || u?.kind || 'Utility', subtitle: '', description: def?.description || '' };
}

// ---------------------------------------------------------------------------
// weather data and the picture

const forecasts = new Map(); // channel id -> { at, forecast }

/** The channel's forecast, refreshed every 15 minutes; the last good one when the service is down. */
export async function utilityForecast(channel) {
  const u = utilityOf(channel);
  const hit = forecasts.get(channel.id);
  const key = `${u.resolved?.lat}|${u.resolved?.lon}|${u.days}`;
  if (hit && hit.key === key && Date.now() - hit.at < FORECAST_TTL) return hit.forecast;
  try {
    const forecast = await fetchForecast(u.resolved, { days: u.days });
    forecasts.set(channel.id, { at: Date.now(), key, forecast });
    return forecast;
  } catch (e) {
    if (hit && hit.key === key) {
      log.warn(`channel ${channel.number}: weather refresh failed (${e.message}); showing the forecast from ${Math.round((Date.now() - hit.at) / 60000)} min ago`);
      hit.at = Date.now() - FORECAST_TTL + 60000; // try again in a minute
      return hit.forecast;
    }
    throw new Error(`Weather service unavailable: ${e.message}`);
  }
}

/** Frame size for a channel: its target resolution, 16:9. */
export function frameSize(channel) {
  const h = [2160, 1440, 1080, 720, 576, 480].includes(channel.resolution) ? Math.min(1080, channel.resolution) : 1080;
  return { width: Math.round((h * 16) / 9 / 2) * 2, height: h };
}

const ffmpeg = (args, what) => new Promise((resolve, reject) => execFile(config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args],
  { timeout: 60000 }, (err, _o, stderr) => (err ? reject(new Error(`Could not draw ${what}: ${(stderr || err.message).trim().split('\n').pop()}`)) : resolve())));

/**
 * Draw the channel's current picture into `dir` (via an SVG, rendered by ffmpeg's librsvg). The picture is
 * written as an uncompressed BMP: the playout loops it 25 times a second, and a BMP costs nothing to decode
 * where a PNG would take a good part of a core. Resolves to { png, clockBox, width, height } (`png` is the
 * picture's path, whatever its format), plus `ticker` for a channel with a scrolling strip (see the news
 * branch) and `audioGainDb` when the music is to play quieter.
 */
export async function renderUtilityFrame(channel, { nowPlaying = '', dir, name = 'frame' }) {
  const u = utilityOf(channel);
  const { width, height } = frameSize(channel);
  fs.mkdirSync(dir, { recursive: true });
  const svgFile = path.join(dir, `${name}.svg`);
  const png = path.join(dir, `${name}.bmp`);
  if (u.kind === 'weather') {
    const forecast = await utilityForecast(channel);
    const { svg, clockBox } = weatherCard(forecast, { unit: u.units, width, height, nowPlaying });
    fs.writeFileSync(svgFile, svg);
    await ffmpeg(['-i', svgFile, '-frames:v', '1', '-pix_fmt', 'bgr24', '-update', '1', png], 'the forecast');
    fs.rmSync(svgFile, { force: true });
    return { png, clockBox, width, height };
  }
  if (u.kind === 'news') {
    // Headlines and the picture are fetched together; neither failing stops the channel.
    const [headlines, picture] = await Promise.all([
      fetchHeadlines(u).catch((e) => { log.warn(`channel ${channel.number}: headlines: ${e.message}`); return []; }),
      nextBingPicture(channel.id),
    ]);
    const L = newsLayout(width, height);
    const tags = [...new Set(activeSources(u).map((s) => s.tag))];
    const card = newsCard({ width, height, credit: picture?.credit || '', nowPlaying, sources: tags, opaque: !picture });
    fs.writeFileSync(svgFile, card);
    if (picture) {
      await ffmpeg(['-i', picture.file, '-i', svgFile, '-filter_complex', `[0]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}[bg];[bg][1]overlay=0:0,format=bgr24`, '-frames:v', '1', '-update', '1', png], 'the news picture');
    } else {
      await ffmpeg(['-i', svgFile, '-frames:v', '1', '-pix_fmt', 'bgr24', '-update', '1', png], 'the news picture');
    }
    // The strip: one long row of headlines, kept with alpha so it blends onto the bar.
    let strip = tickerStrip(headlines, { height: L.ticker.h, windowWidth: L.ticker.w, scale: L.S });
    const stripSvg = path.join(dir, `${name}-strip.svg`);
    const stripFile = path.join(dir, `${name}-strip.bmp`);
    fs.writeFileSync(stripSvg, strip.svg);
    try {
      await ffmpeg(['-i', stripSvg, '-frames:v', '1', '-pix_fmt', 'bgra', '-update', '1', stripFile], 'the headlines');
    } catch (e) {
      // A headline the renderer chokes on must not take the channel down: run the bar empty this track.
      log.warn(`channel ${channel.number}: ${e.message}`);
      strip = tickerStrip([], { height: L.ticker.h, windowWidth: L.ticker.w, scale: L.S });
      fs.writeFileSync(stripSvg, strip.svg);
      await ffmpeg(['-i', stripSvg, '-frames:v', '1', '-pix_fmt', 'bgra', '-update', '1', stripFile], 'the headlines');
    }
    fs.rmSync(svgFile, { force: true });
    fs.rmSync(stripSvg, { force: true });
    return {
      png, clockBox: L.clockBox, width, height, audioGainDb: UTILITY_KINDS.news.musicGainDb,
      ticker: { file: stripFile, width: strip.width, contentWidth: strip.contentWidth, x: L.ticker.x, y: L.ticker.y, w: L.ticker.w, h: L.ticker.h, speed: L.speed },
      headlines: headlines.length,
    };
  }
  throw new Error(`Unknown utility ${u.kind}`);
}

const pictureTurn = new Map(); // channel id -> index into Bing's list, so each track gets the next picture

/** The next Bing picture for a channel, or null when none is available (the card paints its own background). */
async function nextBingPicture(channelId) {
  let images = await bingImages();
  if (!images.length) images = keptBingImages();
  if (!images.length) return null;
  const i = (pictureTurn.get(channelId) || 0) % images.length;
  pictureTurn.set(channelId, i + 1);
  return images[i];
}

/** Make sure the music a utility channel needs is on its way (and, for the news, the pictures of the day). */
export function warmUtility(channel) {
  const u = utilityOf(channel);
  if (u?.music && knownSet(u.music)) ensureSet(u.music);
  if (u?.kind === 'news') bingImages().catch(() => {});
}

export const _test = { HOUR };
