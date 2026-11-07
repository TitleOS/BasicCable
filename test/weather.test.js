import { test } from 'node:test';
import assert from 'node:assert/strict';
import { geocode, convertTemp, humidityMood, moonPhase, describeCode, fetchForecast } from '../src/weather.js';
import { weatherCard, clockLabel, localDate } from '../src/weathercard.js';

test('postal codes go to zippopotam, place names to the geocoder', async () => {
  const calls = [];
  const fetchJson = async (url) => {
    calls.push(url);
    if (url.includes('zippopotam.us/us/55101')) return { 'country abbreviation': 'US', places: [{ 'place name': 'Saint Paul', 'state abbreviation': 'MN', latitude: '44.95', longitude: '-93.09' }] };
    if (url.includes('zippopotam.us/gb/SW1A')) return { 'country abbreviation': 'GB', places: [{ 'place name': 'London', state: 'England', latitude: '51.5', longitude: '-0.14' }] };
    if (url.includes('zippopotam.us/')) throw new Error('HTTP 404');
    if (url.includes('geocoding-api')) return { results: [{ name: 'Lyon', admin1: 'Auvergne-Rhône-Alpes', country_code: 'FR', latitude: 45.76, longitude: 4.83 }] };
    throw new Error(`unexpected ${url}`);
  };
  assert.deepEqual(await geocode('55101', { fetchJson }), { lat: 44.95, lon: -93.09, name: 'Saint Paul', region: 'MN', country: 'US' });
  assert.equal((await geocode('gb SW1A', { fetchJson })).name, 'London');
  assert.equal((await geocode('Lyon', { fetchJson })).country, 'FR');
  await assert.rejects(geocode('99999', { fetchJson }), /No place found for postal code/);
  await assert.rejects(geocode('', { fetchJson }), /Enter a zip/);
});

test('temperatures convert and humidity gets a mood', () => {
  assert.equal(convertTemp(0, 'F'), 32);
  assert.equal(convertTemp(21.4, 'C'), 21);
  assert.equal(convertTemp(0, 'K'), 273);
  assert.equal(convertTemp(null, 'F'), null);
  assert.equal(humidityMood(45), 'happy');
  assert.equal(humidityMood(68), 'neutral');
  assert.equal(humidityMood(12), 'neutral');
  assert.equal(humidityMood(85), 'sad');
});

test('moon phases land on known new and full moons', () => {
  // Full moon 2024-01-25 17:54 UTC; new moon 2024-02-09 22:59 UTC.
  const full = moonPhase(Date.UTC(2024, 0, 25, 17, 54));
  assert.ok(Math.abs(full.phase - 0.5) < 0.02, `full: ${full.phase}`);
  assert.equal(full.name, 'Full Moon');
  const nw = moonPhase(Date.UTC(2024, 1, 9, 22, 59));
  assert.ok(nw.phase < 0.02 || nw.phase > 0.98, `new: ${nw.phase}`);
  assert.equal(nw.illumination < 0.01, true);
  assert.equal(moonPhase(Date.UTC(2024, 1, 2, 23, 18)).name, 'Last Quarter');
});

test('WMO codes become words and icons', () => {
  assert.deepEqual(describeCode(0), { text: 'Clear', icon: 'sun' });
  assert.deepEqual(describeCode(63), { text: 'Rain', icon: 'rain' });
  assert.deepEqual(describeCode(95), { text: 'Thunderstorms', icon: 'storm' });
  assert.equal(describeCode(999).icon, 'cloud');
});

const sample = {
  latitude: 44.9, longitude: -93.1, timezone: 'America/Chicago',
  current: { temperature_2m: 1.6, relative_humidity_2m: 76, weather_code: 0, is_day: 1, wind_speed_10m: 12 },
  daily: {
    time: ['2026-11-06', '2026-11-07', '2026-11-08'],
    temperature_2m_max: [8.3, 9.4, 10.8], temperature_2m_min: [-2.7, -0.2, 3.1], relative_humidity_2m_mean: [77, 88, 55],
    sunrise: ['2026-11-06T06:57', '2026-11-07T06:59', '2026-11-08T07:00'], sunset: ['2026-11-06T16:50', '2026-11-07T16:49', '2026-11-08T16:48'],
    weather_code: [0, 61, 3], precipitation_probability_max: [0, 80, 10],
  },
};

test('a forecast is parsed into days, and the card draws one column per day', async () => {
  const place = { lat: 44.9, lon: -93.1, name: 'Saint Paul', region: 'MN', country: 'US' };
  const fc = await fetchForecast(place, { days: 3, fetchJson: async () => sample, now: Date.UTC(2026, 10, 6, 22) });
  assert.equal(fc.days.length, 3);
  assert.equal(fc.days[1].text, 'Rain');
  assert.equal(fc.days[1].sunrise, '2026-11-07T06:59');
  assert.ok(fc.days[0].moon.name);
  const { svg, clockBox } = weatherCard(fc, { unit: 'F', nowPlaying: 'Mozart — "Gran Partita" <III. Adagio>', now: Date.UTC(2026, 10, 6, 22) });
  assert.ok(svg.startsWith('<svg'));
  assert.equal((svg.match(/HUMIDITY/g) || []).length, 3);
  assert.match(svg, /Saint Paul, MN/);
  assert.match(svg, /&lt;III\. Adagio&gt;/, 'song names are escaped');
  assert.match(svg, />47°</, 'high of 8.3 °C is 47 °F');
  assert.match(svg, />Today</);
  assert.match(svg, /6:59 AM/);
  assert.ok(clockBox.w > 0 && clockBox.y > 900);
  const k = weatherCard(fc, { unit: 'K', width: 1280, height: 720 }).svg;
  assert.match(k, />281</, 'Kelvin');
  assert.match(k, /width="1280"/);
});

test('clock labels and local dates', () => {
  assert.equal(clockLabel('2026-11-07T06:59'), '6:59 AM');
  assert.equal(clockLabel('2026-11-07T16:49'), '4:49 PM');
  assert.equal(clockLabel('2026-11-07T00:05'), '12:05 AM');
  assert.equal(localDate(Date.UTC(2026, 10, 7, 3), 'America/Chicago'), '2026-11-06');
});
