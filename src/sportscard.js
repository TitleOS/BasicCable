// The pictures for the sports channel: a page of scorecards (two columns of four), drawn as an SVG that ffmpeg
// (librsvg) turns into an image. Each team card shows its last result (opponent, final score, date), or LIVE in
// red with the score as it stands and the over-the-air channel carrying it; other sports show their event.
// The clock in the corner is drawn live by ffmpeg, as on the other utility channels.

import { textWidthEm } from './newscard.js';
import { dayLabel, whenLabel, resultOf } from './sports.js';

const FONT = "Montserrat, 'DejaVu Sans', Arial, sans-serif";
const SCORE_FONT = "'Bebas Neue', Montserrat, 'DejaVu Sans', Arial, sans-serif";
const esc = (s) => String(s ?? '').replace(/[<>&"']/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[ch]));
const f1 = (n) => Number(n.toFixed(1));
const RED = '#e5484d';

/** Cut `text` with an ellipsis so it fits `px` pixels at `size` (by the width estimate). */
export function fit(text, px, size, bold = false) {
  const s = String(text || '');
  if (textWidthEm(s, bold) * size <= px) return s;
  let out = s;
  while (out.length > 1 && textWidthEm(`${out}…`, bold) * size > px) out = out.slice(0, -1);
  return `${out.trimEnd()}…`;
}

/** A colour light enough to read white text on? Picks the badge's text colour. */
function light(hex) {
  const n = parseInt(hex, 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 170;
}

/** Layout of a page (frame pixels): the grid, the bottom bar, the clock's corner. */
export function sportsLayout(width = 1920, height = 1080) {
  const S = width / 1920;
  const px = (n) => Math.round(n * S);
  const cols = 2, rows = 4;
  const x0 = px(80), y0 = px(170), gap = px(28), rowGap = px(18);
  const cardW = Math.floor((width - 2 * x0 - gap) / cols);
  const cardH = Math.floor((px(985) - y0 - (rows - 1) * rowGap) / rows);
  return {
    S, px, cols, rows, x0, y0, gap, rowGap, cardW, cardH,
    barY: px(1002),
    clockBox: { x: px(1200), y: px(1002), w: px(640), h: height - px(1002) },
  };
}

/** "at Boston Bruins", "vs Nashville Predators" (neutral sites read "vs"). */
const against = (g) => `${g.home || g.neutral ? 'vs' : 'at'} ${g.them.name}`;

function teamCard(c, x, y, w, h, P, zone, now) {
  const px = P;
  const out = [];
  const color = `#${c.team.color || '3a4a66'}`;
  out.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${px(14)}" fill="#111a2c" fill-opacity="0.92"/>`);
  out.push(`<rect x="${x}" y="${y}" width="${px(10)}" height="${h}" rx="${px(4)}" fill="${color}"/>`);
  if (c.live) out.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${px(14)}" fill="none" stroke="${RED}" stroke-width="${px(3)}"/>`);
  const left = x + px(34);
  const right = x + w - px(28);
  // the league, and the status at the top right
  out.push(`<text x="${left}" y="${y + px(36)}" fill="#8f9ab0" font-size="${px(19)}" font-weight="700" letter-spacing="${px(2)}">${esc(c.label.toUpperCase())}</text>`);
  // the badge and the team
  const bx = left + px(34), by = y + px(92), br = px(32);
  const abbr = (c.team.abbr || c.team.name.slice(0, 3)).toUpperCase().slice(0, 4);
  out.push(`<circle cx="${bx}" cy="${by}" r="${br}" fill="${color}"/>`);
  out.push(`<text x="${bx}" y="${by + px(abbr.length > 3 ? 7 : 8)}" fill="${light(c.team.color || '3a4a66') ? '#111' : '#fff'}" font-size="${px(abbr.length > 3 ? 17 : 21)}" font-weight="700" text-anchor="middle">${esc(abbr)}</text>`);
  const nameX = bx + br + px(18);
  const g = c.live || c.last;
  // The score is ours first. Its width (Bebas Neue is narrow) and the W/L chip decide how much room the name gets.
  const score = g ? `${g.us.score ?? '–'} – ${g.them.score ?? '–'}` : '';
  const scoreW = g ? textWidthEm(score) * px(70) * 0.62 : 0;
  const chip = g && !c.live && resultOf(g) ? px(64) : 0;
  const nameRoom = right - nameX - scoreW - chip - px(24);
  out.push(`<text x="${nameX}" y="${y + px(90)}" fill="#fff" font-size="${px(32)}" font-weight="700">${esc(fit(c.team.name, nameRoom, px(32), true))}</text>`);
  if (c.error && !c.last && !c.live) {
    out.push(`<text x="${nameX}" y="${y + px(130)}" fill="#8f9ab0" font-size="${px(24)}">Scores unavailable right now</text>`);
    return out.join('');
  }
  if (c.live) {
    out.push(`<text x="${right}" y="${y + px(38)}" fill="${RED}" font-size="${px(26)}" font-weight="700" text-anchor="end" letter-spacing="${px(3)}">LIVE</text>`);
  } else if (g) {
    out.push(`<text x="${right}" y="${y + px(36)}" fill="#8f9ab0" font-size="${px(20)}" text-anchor="end">${esc(dayLabel(g.date, zone))}</text>`);
  }
  if (!g) {
    out.push(`<text x="${nameX}" y="${y + px(130)}" fill="#c9ced9" font-size="${px(24)}">No games played yet</text>`);
  } else {
    out.push(`<text x="${nameX}" y="${y + px(130)}" fill="#c9ced9" font-size="${px(25)}">${esc(fit(against(g), right - nameX - scoreW - px(24), px(25)))}</text>`);
    out.push(`<text x="${right}" y="${y + px(122)}" fill="#fff" font-family="${SCORE_FONT}" font-size="${px(70)}" text-anchor="end">${esc(score)}</text>`);
    if (!c.live) {
      const r = resultOf(g);
      if (r) {
        const cx = right - scoreW - px(40);
        out.push(`<rect x="${f1(cx - px(20))}" y="${y + px(74)}" width="${px(40)}" height="${px(40)}" rx="${px(8)}" fill="${r === 'W' ? '#2f9e5b' : r === 'L' ? '#a33a3e' : '#56607a'}"/>`);
        out.push(`<text x="${f1(cx)}" y="${y + px(103)}" fill="#fff" font-size="${px(24)}" font-weight="700" text-anchor="middle">${r}</text>`);
      }
    }
  }
  // the bottom line: the live game's clock and channel, or what's next
  const foot = y + h - px(22);
  if (c.live) {
    const bits = [c.live.detail].filter(Boolean).join('');
    out.push(`<text x="${nameX}" y="${foot}" fill="#ff8b8e" font-size="${px(22)}" font-weight="700">${esc(bits)}</text>`);
    const on = c.ota ? `On ${c.ota.name} · channel ${c.ota.channel}` : c.live.broadcasts?.length ? `On ${c.live.broadcasts.slice(0, 2).join(', ')}` : '';
    if (on) out.push(`<text x="${right}" y="${foot}" fill="${c.ota ? '#ffd166' : '#8f9ab0'}" font-size="${px(22)}" font-weight="700" text-anchor="end">${esc(fit(on, w * 0.55, px(22), true))}</text>`);
  } else if (c.next) {
    const n = c.next;
    const on = c.nextOta ? ` · channel ${c.nextOta.channel}` : '';
    const text = `Next: ${n.home || n.neutral ? 'vs' : 'at'} ${n.them.short || n.them.name} · ${whenLabel(n.date, zone, now)}${on}`;
    out.push(`<text x="${nameX}" y="${foot}" fill="${c.nextOta ? '#ffd166' : '#8f9ab0'}" font-size="${px(21)}">${esc(fit(text, right - nameX, px(21)))}</text>`);
  }
  return out.join('');
}

function eventCard(c, x, y, w, h, P, zone) {
  const px = P;
  const out = [];
  const color = `#${c.color || '3a4a66'}`;
  out.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${px(14)}" fill="#111a2c" fill-opacity="0.92"/>`);
  out.push(`<rect x="${x}" y="${y}" width="${px(10)}" height="${h}" rx="${px(4)}" fill="${color}"/>`);
  if (c.live) out.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${px(14)}" fill="none" stroke="${RED}" stroke-width="${px(3)}"/>`);
  const left = x + px(34), right = x + w - px(28);
  out.push(`<text x="${left}" y="${y + px(36)}" fill="#8f9ab0" font-size="${px(19)}" font-weight="700" letter-spacing="${px(2)}">${esc(c.label)}</text>`);
  if (c.live) out.push(`<text x="${right}" y="${y + px(38)}" fill="${RED}" font-size="${px(26)}" font-weight="700" text-anchor="end" letter-spacing="${px(3)}">LIVE</text>`);
  else if (c.date) out.push(`<text x="${right}" y="${y + px(36)}" fill="#8f9ab0" font-size="${px(20)}" text-anchor="end">${esc(dayLabel(c.date, zone))}</text>`);
  out.push(`<text x="${left}" y="${y + px(84)}" fill="#fff" font-size="${px(30)}" font-weight="700">${esc(fit(c.title, right - left, px(30), true))}</text>`);
  const headline = c.error ? 'Results unavailable right now' : c.headline;
  out.push(`<text x="${left}" y="${y + px(126)}" fill="${c.live ? '#fff' : '#c9ced9'}" font-size="${px(27)}">${esc(fit(headline, right - left, px(27)))}</text>`);
  const foot = y + h - px(22);
  const tail = c.next?.date ? `Next: ${c.next.title} · ${dayLabel(c.next.date, zone)}` : c.detail;
  if (tail) out.push(`<text x="${left}" y="${foot}" fill="${c.live ? '#ff8b8e' : '#8f9ab0'}" font-size="${px(21)}"${c.live ? ' font-weight="700"' : ''}>${esc(fit(tail, right - left, px(21), c.live))}</text>`);
  return out.join('');
}

/**
 * One page of scorecards. `title` is the state ("Minnesota"); `page`/`pages` number the page in the top right.
 * Returns the SVG.
 */
export function sportsPage(cards, { width = 1920, height = 1080, title = '', page = 1, pages = 1, nowPlaying = '', zone = 'UTC', now = Date.now(), message = '' } = {}) {
  const L = sportsLayout(width, height);
  const { px } = L;
  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${FONT}">`);
  out.push('<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#12284a"/><stop offset="0.55" stop-color="#0a1426"/><stop offset="1" stop-color="#05080f"/></linearGradient>' +
    '<pattern id="lines" width="40" height="40" patternUnits="userSpaceOnUse" patternTransform="rotate(35)"><rect width="40" height="40" fill="none"/><rect width="2" height="40" fill="#ffffff" fill-opacity="0.025"/></pattern></defs>');
  out.push(`<rect width="${width}" height="${height}" fill="url(#bg)"/><rect width="${width}" height="${height}" fill="url(#lines)"/>`);
  // the bug and the state
  const bugW = px(250);
  out.push(`<rect x="${px(80)}" y="${px(60)}" width="${bugW}" height="${px(70)}" rx="${px(10)}" fill="${RED}"/>`);
  out.push(`<text x="${px(80) + bugW / 2}" y="${px(110)}" fill="#fff" font-size="${px(44)}" font-weight="700" text-anchor="middle" letter-spacing="${px(4)}">SCORES</text>`);
  if (title) out.push(`<text x="${px(80) + bugW + px(26)}" y="${px(108)}" fill="#fff" fill-opacity="0.85" font-size="${px(28)}" font-weight="700" letter-spacing="${px(3)}">${esc(title.toUpperCase())}</text>`);
  if (pages > 1) out.push(`<text x="${width - px(80)}" y="${px(108)}" fill="#8f9ab0" font-size="${px(24)}" font-weight="700" text-anchor="end" letter-spacing="${px(2)}">${page} / ${pages}</text>`);
  // the cards
  cards.slice(0, L.cols * L.rows).forEach((c, i) => {
    const col = i % L.cols, row = Math.floor(i / L.cols);
    const x = L.x0 + col * (L.cardW + L.gap), y = L.y0 + row * (L.cardH + L.rowGap);
    out.push(c.kind === 'event' ? eventCard(c, x, y, L.cardW, L.cardH, px, zone) : teamCard(c, x, y, L.cardW, L.cardH, px, zone, now));
  });
  if (!cards.length) {
    out.push(`<text x="${width / 2}" y="${height / 2}" fill="#c9ced9" font-size="${px(36)}" text-anchor="middle">${esc(message || 'No teams picked yet: choose some on the Utilities page.')}</text>`);
  }
  // the caption bar: the song on the left, the clock's corner on the right
  out.push(`<rect x="0" y="${L.barY}" width="${width}" height="${height - L.barY}" fill="#000" fill-opacity="0.65"/>`);
  const caption = nowPlaying.length > 72 ? `${nowPlaying.slice(0, 70).replace(/\s+\S*$/, '')}…` : nowPlaying;
  out.push(`<text x="${px(80)}" y="${px(1052)}" fill="#c9ced9" font-size="${px(30)}">${caption ? `<tspan fill="${RED}" font-weight="700">♪ </tspan>${esc(caption)}` : '<tspan fill="#8b93a7">Basic Cable · Sports</tspan>'}</text>`);
  out.push('</svg>');
  return out.join('\n');
}
