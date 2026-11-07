// The forecast picture for the weather channel, as an SVG that ffmpeg (librsvg) turns into the video frame.
// Everything that changes slowly is drawn here (conditions, the days, the song playing); the clock in the
// bottom-right corner is left blank and drawn live by ffmpeg over it.

import { convertTemp, unitSuffix, humidityMood } from './weather.js';

const FONT = "Montserrat, 'DejaVu Sans', Arial, sans-serif";
const esc = (s) => String(s ?? '').replace(/[<>&"']/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[ch]));
const f1 = (n) => Number(n.toFixed(1));

// ---------------------------------------------------------------------------
// icons: each returns SVG centred on (x, y), about `s` pixels across

function sun(x, y, s, color = '#ffd166') {
  const r = s * 0.28;
  const rays = [];
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4;
    rays.push(`<line x1="${f1(x + Math.cos(a) * r * 1.45)}" y1="${f1(y + Math.sin(a) * r * 1.45)}" x2="${f1(x + Math.cos(a) * r * 1.85)}" y2="${f1(y + Math.sin(a) * r * 1.85)}"/>`);
  }
  return `<g stroke="${color}" stroke-width="${f1(s * 0.07)}" stroke-linecap="round" fill="${color}"><circle cx="${x}" cy="${y}" r="${f1(r)}" stroke="none"/>${rays.join('')}</g>`;
}

/** The moon at `phase` (0 new, 0.5 full): the lit part in pale grey over a dark disc. */
function moon(x, y, s, phase) {
  const r = s * 0.4;
  const k = Math.cos(phase * 2 * Math.PI); // 1 new, 0 quarter, -1 full
  const waxing = phase < 0.5;
  const gibbous = k < 0;
  const rx = f1(Math.max(0.01, r * Math.abs(k)));
  const outer = waxing ? 1 : 0;
  const inner = waxing === gibbous ? 1 : 0;
  const lit = `M ${x} ${f1(y - r)} A ${f1(r)} ${f1(r)} 0 0 ${outer} ${x} ${f1(y + r)} A ${rx} ${f1(r)} 0 0 ${inner} ${x} ${f1(y - r)} Z`;
  return `<g><circle cx="${x}" cy="${y}" r="${f1(r)}" fill="#1f2636" stroke="#3a4560" stroke-width="${f1(s * 0.03)}"/>` +
    `<path d="${lit}" fill="#e8ecf5"/><circle cx="${f1(x - r * 0.3)}" cy="${f1(y - r * 0.2)}" r="${f1(r * 0.12)}" fill="#c9ced9" opacity="0.5"/>` +
    `<circle cx="${f1(x + r * 0.25)}" cy="${f1(y + r * 0.3)}" r="${f1(r * 0.09)}" fill="#c9ced9" opacity="0.5"/></g>`;
}

function cloud(x, y, s, color = '#dfe5f0') {
  const w = s * 0.9, h = s * 0.5;
  return `<g fill="${color}"><ellipse cx="${f1(x - w * 0.22)}" cy="${f1(y + h * 0.1)}" rx="${f1(w * 0.28)}" ry="${f1(h * 0.42)}"/>` +
    `<ellipse cx="${f1(x + w * 0.05)}" cy="${f1(y - h * 0.15)}" rx="${f1(w * 0.32)}" ry="${f1(h * 0.55)}"/>` +
    `<ellipse cx="${f1(x + w * 0.3)}" cy="${f1(y + h * 0.12)}" rx="${f1(w * 0.24)}" ry="${f1(h * 0.38)}"/>` +
    `<rect x="${f1(x - w * 0.3)}" y="${f1(y + h * 0.05)}" width="${f1(w * 0.65)}" height="${f1(h * 0.45)}" rx="${f1(h * 0.2)}"/></g>`;
}

function drops(x, y, s, count, color = '#7cc4ff') {
  const out = [];
  for (let i = 0; i < count; i++) {
    const dx = x - s * 0.25 + (i * s * 0.5) / Math.max(1, count - 1);
    out.push(`<line x1="${f1(dx + s * 0.04)}" y1="${f1(y)}" x2="${f1(dx - s * 0.04)}" y2="${f1(y + s * 0.2)}"/>`);
  }
  return `<g stroke="${color}" stroke-width="${f1(s * 0.06)}" stroke-linecap="round">${out.join('')}</g>`;
}

function flakes(x, y, s) {
  const out = [];
  for (let i = 0; i < 3; i++) {
    const cx = x - s * 0.25 + i * s * 0.25, cy = y + s * 0.1 + (i % 2) * s * 0.08, r = s * 0.07;
    out.push(`<g stroke="#eaf4ff" stroke-width="${f1(s * 0.025)}"><line x1="${f1(cx - r)}" y1="${cy}" x2="${f1(cx + r)}" y2="${cy}"/><line x1="${cx}" y1="${f1(cy - r)}" x2="${cx}" y2="${f1(cy + r)}"/>` +
      `<line x1="${f1(cx - r * 0.7)}" y1="${f1(cy - r * 0.7)}" x2="${f1(cx + r * 0.7)}" y2="${f1(cy + r * 0.7)}"/><line x1="${f1(cx - r * 0.7)}" y1="${f1(cy + r * 0.7)}" x2="${f1(cx + r * 0.7)}" y2="${f1(cy - r * 0.7)}"/></g>`);
  }
  return out.join('');
}

export function weatherIcon(kind, x, y, s) {
  switch (kind) {
    case 'sun': return sun(x, y, s);
    case 'partly': return sun(x - s * 0.2, y - s * 0.18, s * 0.7) + cloud(x + s * 0.08, y + s * 0.12, s * 0.85);
    case 'fog': return cloud(x, y - s * 0.12, s * 0.8, '#b7c0d3') + `<g stroke="#b7c0d3" stroke-width="${f1(s * 0.05)}" stroke-linecap="round"><line x1="${f1(x - s * 0.35)}" y1="${f1(y + s * 0.22)}" x2="${f1(x + s * 0.35)}" y2="${f1(y + s * 0.22)}"/><line x1="${f1(x - s * 0.25)}" y1="${f1(y + s * 0.34)}" x2="${f1(x + s * 0.3)}" y2="${f1(y + s * 0.34)}"/></g>`;
    case 'drizzle': return cloud(x, y - s * 0.1, s) + drops(x, y + s * 0.2, s * 0.7, 3);
    case 'rain': return cloud(x, y - s * 0.1, s) + drops(x, y + s * 0.18, s, 3);
    case 'snow': return cloud(x, y - s * 0.1, s) + flakes(x, y + s * 0.2, s);
    case 'storm': return cloud(x, y - s * 0.1, s, '#aeb8cc') + `<polygon points="${f1(x + s * 0.02)},${f1(y + s * 0.08)} ${f1(x - s * 0.12)},${f1(y + s * 0.3)} ${f1(x)},${f1(y + s * 0.28)} ${f1(x - s * 0.06)},${f1(y + s * 0.48)} ${f1(x + s * 0.14)},${f1(y + s * 0.22)} ${f1(x + s * 0.02)},${f1(y + s * 0.24)}" fill="#ffd166"/>`;
    default: return cloud(x, y, s);
  }
}

/** A face for the humidity: happy, neutral or sad. */
export function face(mood, x, y, s) {
  const r = s * 0.45;
  const fill = { happy: '#7bd88f', neutral: '#ffd166', sad: '#ff7b7b' }[mood] || '#ffd166';
  const my = y + r * 0.25;
  const mouth = mood === 'happy' ? `M ${f1(x - r * 0.45)} ${f1(my)} Q ${x} ${f1(my + r * 0.6)} ${f1(x + r * 0.45)} ${f1(my)}`
    : mood === 'sad' ? `M ${f1(x - r * 0.45)} ${f1(my + r * 0.3)} Q ${x} ${f1(my - r * 0.35)} ${f1(x + r * 0.45)} ${f1(my + r * 0.3)}`
      : `M ${f1(x - r * 0.42)} ${f1(my + r * 0.1)} L ${f1(x + r * 0.42)} ${f1(my + r * 0.1)}`;
  return `<g><circle cx="${x}" cy="${y}" r="${f1(r)}" fill="${fill}"/><circle cx="${f1(x - r * 0.35)}" cy="${f1(y - r * 0.25)}" r="${f1(r * 0.1)}" fill="#1a1d26"/>` +
    `<circle cx="${f1(x + r * 0.35)}" cy="${f1(y - r * 0.25)}" r="${f1(r * 0.1)}" fill="#1a1d26"/><path d="${mouth}" stroke="#1a1d26" stroke-width="${f1(r * 0.12)}" fill="none" stroke-linecap="round"/></g>`;
}

// ---------------------------------------------------------------------------

/** "2026-11-07T06:59" -> "6:59 AM" */
export function clockLabel(iso) {
  const m = String(iso || '').match(/T(\d{2}):(\d{2})/);
  if (!m) return '';
  const h = Number(m[1]), min = m[2];
  return `${h % 12 || 12}:${min} ${h < 12 ? 'AM' : 'PM'}`;
}

/** "Waxing Crescent" -> "Wax. Crescent", for narrow columns. */
function shortMoon(name) {
  return String(name || '').replace(/^Waxing /, 'Wax. ').replace(/^Waning /, 'Wan. ').replace(/^First Quarter$/, '1st Quarter');
}

function dayLabels(date, todayIso) {
  const d = new Date(`${date}T12:00:00Z`);
  const weekday = d.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
  const short = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return { name: date === todayIso ? 'Today' : weekday, date: short };
}

/** The calendar date in the forecast's timezone, as "YYYY-MM-DD". */
export function localDate(ms, timeZone) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

/**
 * The whole card. `forecast` comes from fetchForecast; `nowPlaying` is the caption for the music; the
 * bottom-right `clockBox` ({ x, y, w, h } in card pixels) is returned so the caller can draw the clock there.
 */
export function weatherCard(forecast, { unit = 'F', width = 1920, height = 1080, nowPlaying = '', now = Date.now(), title = 'Local Forecast' } = {}) {
  const S = width / 1920; // everything below is laid out for 1920x1080 and scaled
  const px = (n) => f1(n * S);
  const suffix = unitSuffix(unit);
  const t = (c) => { const v = convertTemp(c, unit); return v == null ? '--' : `${v}${unit === 'K' ? '' : '°'}`; };
  const todayIso = localDate(now, forecast.timezone);
  const days = forecast.days.slice(0, 7);
  const n = Math.max(1, days.length);
  const placeName = [forecast.place?.name, forecast.place?.region].filter(Boolean).join(', ');
  const cur = forecast.current || {};
  const mood = humidityMood(cur.humidity);
  const out = [];

  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${FONT}">`);
  out.push('<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0d1f3c"/><stop offset="0.55" stop-color="#0a1428"/><stop offset="1" stop-color="#060b16"/></linearGradient>' +
    '<linearGradient id="bar" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#e5484d"/><stop offset="1" stop-color="#3e63dd"/></linearGradient></defs>');
  out.push(`<rect width="${width}" height="${height}" fill="url(#bg)"/>`);
  out.push(`<rect x="0" y="${px(214)}" width="${width}" height="${px(4)}" fill="url(#bar)"/>`);

  // header: place and current conditions
  out.push(`<text x="${px(80)}" y="${px(78)}" fill="#8b93a7" font-size="${px(26)}" font-weight="700" letter-spacing="${px(6)}">${esc(title.toUpperCase())}</text>`);
  out.push(`<text x="${px(80)}" y="${px(150)}" fill="#ffffff" font-size="${px(64)}" font-weight="700">${esc(placeName || 'Your area')}</text>`);
  out.push(`<text x="${px(80)}" y="${px(192)}" fill="#c9ced9" font-size="${px(26)}">${esc(cur.text || '')}${cur.humidity != null ? ` · Humidity ${Math.round(cur.humidity)}%` : ''}${cur.wind != null ? ` · Wind ${Math.round(cur.wind)} ${unit === 'F' ? 'mph' : 'km/h'}` : ''}</text>`);
  // At night a clear sky gets the moon as it looks tonight, not a sun.
  const night = cur.isDay === false && (cur.icon === 'sun' || cur.icon === 'partly');
  out.push(night ? moon(px(1380), px(120), px(150), (days[0]?.moon || { phase: 0 }).phase) + (cur.icon === 'partly' ? cloud(px(1420), px(150), px(110)) : '')
    : weatherIcon(cur.icon || 'cloud', px(1380), px(120), px(150)));
  out.push(`<text x="${px(1700)}" y="${px(190)}" fill="#ffffff" font-size="${px(124)}" font-weight="700" text-anchor="end">${esc(t(cur.temp))}</text>`);
  out.push(`<text x="${px(1700)}" y="${px(66)}" fill="#8b93a7" font-size="${px(22)}" font-weight="700" text-anchor="end" letter-spacing="${px(3)}">NOW · ${esc(suffix)}</text>`);
  out.push(face(mood, px(1790), px(120), px(120)));

  // one column per day
  const left = 80, right = 1920 - 80, gap = 18;
  const colW = (right - left - gap * (n - 1)) / n;
  const top = 250, bottom = 900;
  const big = n <= 5;
  days.forEach((d, i) => {
    const x0 = left + i * (colW + gap);
    const cx = x0 + colW / 2;
    const { name, date } = dayLabels(d.date, todayIso);
    out.push(`<rect x="${px(x0)}" y="${px(top)}" width="${px(colW)}" height="${px(bottom - top)}" rx="${px(18)}" fill="#ffffff" fill-opacity="${i === 0 ? 0.1 : 0.06}" stroke="#ffffff" stroke-opacity="0.08"/>`);
    out.push(`<text x="${px(cx)}" y="${px(top + 52)}" fill="#ffffff" font-size="${px(big ? 34 : 28)}" font-weight="700" text-anchor="middle">${esc(name)}</text>`);
    out.push(`<text x="${px(cx)}" y="${px(top + 86)}" fill="#8b93a7" font-size="${px(22)}" text-anchor="middle">${esc(date)}</text>`);
    out.push(weatherIcon(d.icon, px(cx), px(top + 170), px(big ? 120 : 96)));
    out.push(`<text x="${px(cx)}" y="${px(top + 258)}" fill="#c9ced9" font-size="${px(big ? 24 : 20)}" text-anchor="middle">${esc(d.text)}${d.rain != null && d.rain >= 30 ? ` · ${Math.round(d.rain)}%` : ''}</text>`);
    // sun over the high, sunrise under it; moon (tonight's phase) over the low
    const sx = cx - colW * 0.25, mx = cx + colW * 0.25, iy = top + 330;
    out.push(sun(px(sx), px(iy), px(big ? 74 : 60)));
    out.push(moon(px(mx), px(iy), px(big ? 74 : 60), d.moon?.phase ?? 0));
    out.push(`<text x="${px(sx)}" y="${px(iy + 95)}" fill="#ffd166" font-size="${px(big ? 48 : 40)}" font-weight="700" text-anchor="middle">${esc(t(d.high))}</text>`);
    out.push(`<text x="${px(mx)}" y="${px(iy + 95)}" fill="#a9c4ff" font-size="${px(big ? 48 : 40)}" font-weight="700" text-anchor="middle">${esc(t(d.low))}</text>`);
    out.push(`<text x="${px(sx)}" y="${px(iy + 128)}" fill="#8b93a7" font-size="${px(big ? 20 : 17)}" text-anchor="middle">↑ ${esc(clockLabel(d.sunrise))}</text>`);
    out.push(`<text x="${px(mx)}" y="${px(iy + 128)}" fill="#8b93a7" font-size="${px(big ? 20 : 17)}" text-anchor="middle">${esc(big ? d.moon?.name || '' : shortMoon(d.moon?.name))}</text>`);
    // humidity with its face
    const hm = humidityMood(d.humidity);
    out.push(face(hm, px(cx - 46), px(top + 560), px(big ? 56 : 48)));
    out.push(`<text x="${px(cx - 8)}" y="${px(top + 572)}" fill="#ffffff" font-size="${px(big ? 32 : 26)}" font-weight="700">${d.humidity != null ? `${Math.round(d.humidity)}%` : '--'}</text>`);
    out.push(`<text x="${px(cx)}" y="${px(top + 612)}" fill="#8b93a7" font-size="${px(18)}" text-anchor="middle">HUMIDITY</text>`);
  });

  // bottom bar: the music on the left, room for the clock on the right
  const barY = 950;
  out.push(`<rect x="0" y="${px(barY)}" width="${width}" height="${px(1080 - barY)}" fill="#000000" fill-opacity="0.45"/>`);
  out.push(`<rect x="0" y="${px(barY)}" width="${width}" height="${px(3)}" fill="#ffffff" fill-opacity="0.1"/>`);
  // The caption stops short of the clock's corner; long titles are cut rather than run under it.
  const caption = nowPlaying.length > 72 ? `${nowPlaying.slice(0, 70).replace(/\s+\S*$/, '')}…` : nowPlaying;
  out.push(`<text x="${px(80)}" y="${px(1025)}" fill="#c9ced9" font-size="${px(30)}">${caption ? `<tspan fill="#e5484d" font-weight="700">♪ </tspan>${esc(caption)}` : '<tspan fill="#8b93a7">Basic Cable · Local Forecast</tspan>'}</text>`);
  out.push('</svg>');
  return { svg: out.join('\n'), clockBox: { x: Math.round(1200 * S), y: Math.round(barY * S), w: Math.round(640 * S), h: Math.round((1080 - barY) * S) } };
}
