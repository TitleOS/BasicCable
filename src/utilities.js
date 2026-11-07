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

const HOUR = 3600e3;
const FORECAST_TTL = 15 * 60 * 1000;

export const UTILITY_KINDS = {
  weather: {
    name: 'Weather',
    channelName: 'Weather',
    description: 'Current conditions and the forecast for your area, with classical music. Highs with the sunrise time, lows with tonight\'s moon, and how the humidity will feel.',
    defaults: { place: '', days: 5, units: 'F', music: 'classical' },
  },
};

export const utilityOf = (channel) => channel?.options?.utility || null;
export const isUtilityItem = (item) => item?.type === 'utility';

/** The channel a utility kind runs on, if it's enabled. */
export function utilityChannel(kind) {
  return store.listChannels().find((c) => c.options?.utility?.kind === kind) || null;
}

/** Validate a utility's settings; resolves the place (a network lookup) when it changed. */
export async function utilityConfig(kind, body, previous = null) {
  const def = UTILITY_KINDS[kind];
  if (!def) throw Object.assign(new Error(`No utility channel called "${kind}"`), { status: 404 });
  const cfg = { ...def.defaults, ...(previous || {}), kind };
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
    };
  });
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
  const where = placeLabel(u);
  while (t < to) {
    const end = Math.min(to, DateTime.fromMillis(t, { zone }).plus({ hours: 1 }).startOf('hour').toMillis());
    if (end <= t) break;
    rows.push({
      start: t, end, type: 'utility', meta_id: `utility:${u.kind}`, video_id: `utility:${u.kind}:${t}`,
      title: u.kind === 'weather' ? 'Local Forecast' : UTILITY_KINDS[u.kind]?.name || u.kind,
      episode_title: where, season: null, episode: null, poster: '', background: '',
      description: u.kind === 'weather' ? `Current conditions and the ${u.days}-day forecast for ${where || 'your area'}, with classical music.` : '',
      origin: 'utility', truncated: 0, cursor_prev: {},
    });
    t = end;
  }
  return rows;
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

/**
 * Draw the channel's current picture into `dir` (via an SVG, rendered by ffmpeg's librsvg). The picture is
 * written as an uncompressed BMP: the playout loops it 25 times a second, and a BMP costs nothing to decode
 * where a PNG would take a good part of a core. Resolves to { png, clockBox, width, height } (`png` is the
 * picture's path, whatever its format).
 */
export async function renderUtilityFrame(channel, { nowPlaying = '', dir, name = 'frame' }) {
  const u = utilityOf(channel);
  const { width, height } = frameSize(channel);
  let svg, clockBox;
  if (u.kind === 'weather') {
    const forecast = await utilityForecast(channel);
    ({ svg, clockBox } = weatherCard(forecast, { unit: u.units, width, height, nowPlaying }));
  } else {
    throw new Error(`Unknown utility ${u.kind}`);
  }
  fs.mkdirSync(dir, { recursive: true });
  const svgFile = path.join(dir, `${name}.svg`);
  const png = path.join(dir, `${name}.bmp`);
  fs.writeFileSync(svgFile, svg);
  await new Promise((resolve, reject) => execFile(config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', svgFile, '-frames:v', '1', '-pix_fmt', 'bgr24', '-update', '1', png],
    { timeout: 30000 }, (err, _o, stderr) => (err ? reject(new Error(`Could not draw the forecast: ${(stderr || err.message).trim().split('\n').pop()}`)) : resolve())));
  fs.rmSync(svgFile, { force: true });
  return { png, clockBox, width, height };
}

/** Make sure the music a utility channel needs is on its way. */
export function warmUtility(channel) {
  const u = utilityOf(channel);
  if (u?.music && knownSet(u.music)) ensureSet(u.music);
}

export const _test = { HOUR };
