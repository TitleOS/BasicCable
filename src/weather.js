// Weather for the generated forecast channel: a postal code (or place name) becomes coordinates, Open-Meteo
// gives the forecast, and the sun and moon details are worked out here. No API keys.

import { VERSION } from './config.js';

const UA = { 'user-agent': `BasicCable/${VERSION} (+https://github.com/TitleOS/BasicCable)` };
export const MIN_DAYS = 3;
export const MAX_DAYS = 7;
export const UNITS = ['F', 'C', 'K'];

async function getJson(url, timeoutMs = 15000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: UA });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * Where a place is. "55101" is a US zip code; "GB SW1A", "de 10115" or "ca M5V" look up another country's
 * postal code; anything else ("Saint Paul, MN", "Lyon") is a place-name search. Resolves to
 * { lat, lon, name, region, country } or throws a readable error.
 */
export async function geocode(place, { fetchJson = getJson } = {}) {
  const q = String(place || '').trim();
  if (!q) throw new Error('Enter a zip or postal code');
  const m = q.match(/^(?:([a-z]{2})[\s,-]+)?([a-z0-9][a-z0-9 -]{1,9})$/i);
  if (m && /\d/.test(m[2])) {
    const cc = (m[1] || 'us').toLowerCase();
    const code = m[2].trim().replace(/\s+/g, ' ');
    try {
      const d = await fetchJson(`https://api.zippopotam.us/${cc}/${encodeURIComponent(code)}`);
      const p = d.places?.[0];
      if (p) return { lat: Number(p.latitude), lon: Number(p.longitude), name: p['place name'], region: p['state abbreviation'] || p.state || '', country: d['country abbreviation'] || cc.toUpperCase() };
    } catch (e) {
      if (!/HTTP 404/.test(e.message)) throw new Error(`Postal code lookup failed (${e.message})`);
    }
    if (m[1] || /^\d{5}$/.test(code)) throw new Error(`No place found for postal code "${q}"`);
  }
  const d = await fetchJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q.replace(/,/g, ' '))}&count=1&language=en&format=json`);
  const r = d.results?.[0];
  if (!r) throw new Error(`No place found for "${q}"`);
  return { lat: r.latitude, lon: r.longitude, name: r.name, region: r.admin1 || '', country: r.country_code || '' };
}

/** Celsius to the channel's unit, rounded for display. */
export function convertTemp(c, unit) {
  if (c == null || !Number.isFinite(c)) return null;
  if (unit === 'F') return Math.round(c * 9 / 5 + 32);
  if (unit === 'K') return Math.round(c + 273.15);
  return Math.round(c);
}
export const unitSuffix = (unit) => (unit === 'K' ? 'K' : `°${unit}`);

/** How the air feels: 'happy' (comfortable), 'neutral' (a bit muggy or dry) or 'sad' (oppressive). */
export function humidityMood(pct) {
  if (pct == null) return 'neutral';
  if (pct > 75) return 'sad';
  if (pct > 60 || pct < 20) return 'neutral';
  return 'happy';
}

const SYNODIC = 29.530588853;
const NEW_MOON = Date.UTC(2000, 0, 6, 18, 14); // a known new moon

/** The moon on a date: phase 0..1 (0 = new, 0.5 = full), lit fraction and a name. */
export function moonPhase(date = Date.now()) {
  const days = (Number(date) - NEW_MOON) / 86400000;
  const phase = ((days / SYNODIC) % 1 + 1) % 1;
  const illumination = (1 - Math.cos(phase * 2 * Math.PI)) / 2;
  const names = ['New Moon', 'Waxing Crescent', 'First Quarter', 'Waxing Gibbous', 'Full Moon', 'Waning Gibbous', 'Last Quarter', 'Waning Crescent'];
  const name = names[Math.round(phase * 8) % 8];
  return { phase, illumination, name };
}

// WMO weather interpretation codes, as Open-Meteo reports them.
const WMO = [
  [[0], 'Clear', 'sun'], [[1], 'Mostly clear', 'sun'], [[2], 'Partly cloudy', 'partly'], [[3], 'Overcast', 'cloud'],
  [[45, 48], 'Fog', 'fog'], [[51, 53, 55, 56, 57], 'Drizzle', 'drizzle'], [[61, 63, 65, 66, 67], 'Rain', 'rain'],
  [[71, 73, 75, 77], 'Snow', 'snow'], [[80, 81, 82], 'Showers', 'rain'], [[85, 86], 'Snow showers', 'snow'],
  [[95, 96, 99], 'Thunderstorms', 'storm'],
];
export function describeCode(code) {
  const hit = WMO.find(([codes]) => codes.includes(Number(code)));
  return hit ? { text: hit[1], icon: hit[2] } : { text: '', icon: 'cloud' };
}

/**
 * Today and the next days for a place: { place, timezone, current, days: [{ date, high, low, humidity, sunrise,
 * sunset, code, text, icon, moon }] }. Temperatures stay in Celsius here; convertTemp turns them into the
 * channel's unit when the card is drawn.
 */
export async function fetchForecast(place, { days = 5, fetchJson = getJson, now = Date.now() } = {}) {
  const n = Math.max(MIN_DAYS, Math.min(MAX_DAYS, Number(days) || 5));
  const u = new URL('https://api.open-meteo.com/v1/forecast');
  u.searchParams.set('latitude', place.lat);
  u.searchParams.set('longitude', place.lon);
  u.searchParams.set('daily', 'temperature_2m_max,temperature_2m_min,relative_humidity_2m_mean,sunrise,sunset,weather_code,precipitation_probability_max');
  u.searchParams.set('current', 'temperature_2m,relative_humidity_2m,weather_code,is_day,wind_speed_10m');
  u.searchParams.set('timezone', 'auto');
  u.searchParams.set('forecast_days', String(n));
  const d = await fetchJson(u.href);
  const day = d.daily || {};
  const out = [];
  for (let i = 0; i < (day.time || []).length; i++) {
    const code = day.weather_code?.[i];
    out.push({
      date: day.time[i],
      high: day.temperature_2m_max?.[i] ?? null,
      low: day.temperature_2m_min?.[i] ?? null,
      humidity: day.relative_humidity_2m_mean?.[i] ?? null,
      rain: day.precipitation_probability_max?.[i] ?? null,
      sunrise: day.sunrise?.[i] || null, // local time, "2026-11-07T06:59"
      sunset: day.sunset?.[i] || null,
      code,
      ...describeCode(code),
      // The moon as it will look that evening.
      moon: moonPhase(Date.parse(`${day.time[i]}T21:00:00Z`) || now),
    });
  }
  const c = d.current || {};
  return {
    place,
    timezone: d.timezone || 'UTC',
    fetchedAt: now,
    current: { temp: c.temperature_2m ?? null, humidity: c.relative_humidity_2m ?? null, code: c.weather_code, isDay: c.is_day !== 0, wind: c.wind_speed_10m ?? null, ...describeCode(c.weather_code) },
    days: out,
  };
}
