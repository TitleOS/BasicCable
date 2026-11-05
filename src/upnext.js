// The "Up next" box: what's on after the current program and after that, drawn into the picture during the
// program's last minute (an optional channel setting).

import fs from 'node:fs';

export const UP_NEXT_SECONDS = 60;
const MAX_LINE = 46;

export const upNextFont = [
  process.env.UP_NEXT_FONT,
  '/usr/share/fonts/truetype/montserrat/Montserrat-SemiBold.ttf',
  '/usr/share/fonts/opentype/montserrat/Montserrat-SemiBold.otf',
  '/usr/share/fonts/truetype/montserrat/Montserrat-Bold.ttf',
  '/usr/share/fonts/opentype/montserrat/Montserrat-Bold.otf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  'C:/Windows/Fonts/arial.ttf',
].filter(Boolean).find((f) => { try { return fs.statSync(f).isFile(); } catch { return false; } }) || null;

const clip = (s) => (s.length > MAX_LINE ? `${s.slice(0, MAX_LINE - 1).trimEnd()}…` : s);

/** The box's lines, e.g. "UP NEXT · 8:30 PM" / "Modern Family S02E03 · The Kiss" / "THEN · 9:00 PM" / ... */
export function upNextText(next, later, { label, timeZone }) {
  const at = (ms) => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone });
  const lines = [`UP NEXT · ${at(next.start)}`, clip(label(next))];
  if (later) lines.push(`THEN · ${at(later.start)}`, clip(label(later)));
  return lines.join('\n');
}

/**
 * drawtext for the box: one text block on a semi-transparent black box in the bottom-right corner, sized for a
 * picture `height` pixels tall. `from` is when it appears, in seconds into the ffmpeg run (0 = straight away).
 * `textFile` and `font` are paths; text goes through a file so titles never need escaping for the filter graph.
 */
export function upNextFilter({ textFile, font, height, from = 0 }) {
  const esc = (p) => p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
  const size = Math.max(14, Math.round(height * 0.026));
  const pad = Math.round(size * 0.75);
  const margin = Math.round(height * 0.045) + pad;
  return `drawtext=fontfile='${esc(font)}':textfile='${esc(textFile)}':expansion=none:fontsize=${size}:fontcolor=white` +
    `:line_spacing=${Math.round(size * 0.4)}:box=1:boxcolor=black@0.6:boxborderw=${pad}:x=w-tw-${margin}:y=h-th-${margin}` +
    (from > 0 ? `:enable='gte(t,${from.toFixed(2)})'` : '');
}
