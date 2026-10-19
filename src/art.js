// Channel art: a 16:9 PNG per channel with its number and name, rendered once with ffmpeg and cached.
// Every channel shares one layout (badge, LIVE tag, name, underline, scanlines); each gets its own palette and
// background pattern, so they read as a set but are easy to tell apart.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { config, log } from './config.js';

const ART_VERSION = 2; // bump to re-render every channel after a design change
const W = 960;
const H = 540;
const dir = path.join(config.dataDir, 'art');

const firstExisting = (paths) => paths.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
const FONTS = {
  display: firstExisting([
    '/usr/share/fonts/opentype/bebas-neue/BebasNeue-Bold.otf',
    '/usr/share/fonts/truetype/bebas-neue/BebasNeue-Regular.ttf',
    '/usr/share/fonts/opentype/bebas-neue/BebasNeue-Regular.otf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSansCondensed-Bold.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    'C:/Windows/Fonts/impact.ttf',
  ]),
  label: firstExisting([
    '/usr/share/fonts/truetype/montserrat/Montserrat-Bold.ttf',
    '/usr/share/fonts/opentype/montserrat/Montserrat-Bold.otf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    'C:/Windows/Fonts/arialbd.ttf',
  ]),
  symbols: firstExisting(['/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 'C:/Windows/Fonts/seguisym.ttf']),
};

// ---------------------------------------------------------------------------
// colour

const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const hex = ([r, g, b]) => `0x${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;

// Hand-picked duotones: a near-black background, a glow colour for the spotlight and a neon accent.
const PALETTES = [
  ['ember', '#1a0605', '#7a1e0e', '#ff6b3d'],
  ['emerald', '#021a12', '#0b6644', '#3dffb0'],
  ['ultraviolet', '#12031f', '#55168c', '#c77dff'],
  ['gold rush', '#1a1202', '#7a5206', '#ffc93d'],
  ['ocean', '#02101f', '#0c4a85', '#3db8ff'],
  ['neon rose', '#1f0313', '#8a1150', '#ff4fa3'],
  ['circuit', '#0a1a02', '#356b0b', '#a6ff3d'],
  ['royal', '#06061f', '#28248a', '#8c8cff'],
  ['copper', '#1a0b02', '#7a3c0c', '#ff9a4d'],
  ['lagoon', '#021a1a', '#0c6666', '#3dfff0'],
  ['orchid', '#1a021a', '#6b0c6b', '#ff6bff'],
  ['citrine', '#151a02', '#5a660b', '#e8ff3d'],
  ['cobalt', '#020a1f', '#0c338a', '#5c95ff'],
  ['crimson', '#1f0207', '#8a0c22', '#ff3d5e'],
  ['jade', '#021f10', '#0c7a40', '#3dff8e'],
  ['amethyst', '#10031f', '#45128a', '#a77bff'],
];

/** A channel's palette, cycling through the set so neighbouring channels never share one. */
function palette(channel) {
  const [name, deep, glow, accent] = PALETTES[(channel.id - 1 + PALETTES.length * 1000) % PALETTES.length];
  return { name, deep: rgb(deep), glow: rgb(glow), accent: rgb(accent) };
}

// ---------------------------------------------------------------------------
// background patterns: alpha expressions for ffmpeg's geq (X, Y, W, H available). Kept off the left side so
// the name stays readable.

const fade = '(0.1+0.9*X/W)';
const MOTIFS = [
  { name: 'rays', a: `lt(mod(atan2(Y-H*0.55,X-W*0.86)*14/PI+28,2),1)*${fade}` },
  { name: 'rings', a: `lt(mod(hypot(X-W*0.82,Y-H*0.5),44),15)*${fade}` },
  { name: 'stripes', a: `lt(mod(X+Y,52),17)*${fade}` },
  { name: 'halftone', a: `lt(hypot(mod(X,30)-15,mod(Y,30)-15),1+12*X/W)` },
  { name: 'grid', a: `gt(lt(mod(X,54),3)+lt(mod(Y,54),3),0)*${fade}` },
  { name: 'waves', a: `lt(mod(Y+20*sin(X/46),38),11)*${fade}` },
  { name: 'chevrons', a: `lt(mod(X+abs(Y-H/2)*0.9,60),20)*${fade}` },
  { name: 'stars', a: `gt(random(0),0.9935)*(0.4+0.6*X/W)*2` },
];

// ---------------------------------------------------------------------------

function artKey(channel) {
  return crypto.createHash('sha1').update(`${ART_VERSION}|${channel.id}|${channel.number}|${channel.name}|${FONTS.display}`).digest('hex').slice(0, 10);
}

/** Public path for a channel's art; changes whenever its number or name does, so clients never show a stale image. */
export function artUrl(base, channel) {
  return `${base}/art/${artFile(channel)}`;
}

/** File name of the channel's current art, e.g. "2-4f1c09ab3e.png". */
export function artFile(channel) {
  return `${channel.id}-${artKey(channel)}.png`;
}

/** Render art for every channel in the background, so the first Stremio visit doesn't wait. */
export async function prerenderArt(channels) {
  for (const c of channels) {
    try { await ensureArt(c); } catch (e) { log.warn(`art for channel ${c.number} failed: ${e.message.split('\n')[0]}`); }
  }
}

/** Split a name into at most two balanced lines. */
function lines(name) {
  const words = name.toUpperCase().split(/\s+/).filter(Boolean);
  if (name.length <= 13 || words.length === 1) return [words.join(' ')];
  let best = null;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(' '), b = words.slice(i).join(' ');
    const score = Math.max(a.length, b.length);
    if (!best || score < best.score) best = { score, l: [a, b] };
  }
  return best.l;
}

const rendering = new Map();

/** Path to the channel's PNG, rendering it first if needed. */
export function ensureArt(channel) {
  const file = path.join(dir, artFile(channel));
  if (fs.existsSync(file)) return Promise.resolve(file);
  if (rendering.has(file)) return rendering.get(file);
  const job = render(channel, file).finally(() => rendering.delete(file));
  rendering.set(file, job);
  return job;
}

async function render(channel, file) {
  fs.mkdirSync(dir, { recursive: true });
  const { deep, glow, accent } = palette(channel);
  const motif = MOTIFS[(channel.id * 5 + 3) % MOTIFS.length];
  const num = String(channel.number);
  const nameLines = lines(channel.name);
  const longest = Math.max(...nameLines.map((l) => l.length));
  // Names stay left of the big number: about 600px wide next to two digits, 660px next to one.
  const budget = num.length > 1 ? 600 : 660;
  const size = Math.round(Math.min(nameLines.length > 1 ? 118 : 165, budget / (longest * 0.43)));
  const lineH = Math.round(size * 0.92);
  const numSize = num.length > 2 ? 300 : num.length > 1 ? 380 : 460;

  // Text goes through files so names never need escaping for the filter graph.
  const tmp = fs.mkdtempSync(path.join(dir, '.tmp-'));
  const tf = (n, text) => { const p = path.join(tmp, n); fs.writeFileSync(p, text); return p.replace(/\\/g, '/').replace(/:/g, '\\:'); };
  const font = (f) => f.replace(/\\/g, '/').replace(/:/g, '\\:');
  const [ar, ag, ab] = accent;

  const chain = [
    // big outlined number on the right, running off the bottom edge: a dark fill inside a neon border
    `drawtext=fontfile='${font(FONTS.display)}':textfile='${tf('num', num)}':fontsize=${numSize}` +
      `:fontcolor=${hex(deep)}@0.82:borderw=4:bordercolor=${hex(accent)}@0.9:x=W-tw-34:y=H-th*0.84`,
    // channel badge
    `drawbox=x=48:y=44:w=${num.length > 2 ? 158 : 138}:h=46:color=${hex(accent)}@1:t=fill`,
    `drawtext=fontfile='${font(FONTS.label)}':textfile='${tf('badge', `CH ${num.padStart(2, '0')}`)}':fontsize=26:fontcolor=${hex(deep)}:x=64:y=55`,
    // LIVE tag
    `drawtext=fontfile='${font(FONTS.symbols)}':textfile='${tf('dot', '●')}':fontsize=26:fontcolor=0xff3b4f:x=W-150:y=53`,
    `drawtext=fontfile='${font(FONTS.label)}':textfile='${tf('live', 'LIVE')}':fontsize=26:fontcolor=white@0.92:x=W-118:y=55`,
    // name, bottom-left, up to two lines
    ...nameLines.map((l, i) => `drawtext=fontfile='${font(FONTS.display)}':textfile='${tf(`l${i}`, l)}':fontsize=${size}:fontcolor=white` +
      `:shadowcolor=black@0.45:shadowx=0:shadowy=5:x=52:y=H-92-${lineH * (nameLines.length - i)}+${Math.round(size * 0.12)}`),
    // accent underline
    `drawbox=x=56:y=ih-74:w=170:h=9:color=${hex(accent)}@1:t=fill`,
    // scanlines and vignette
    'drawgrid=w=iw:h=4:t=1:color=black@0.13',
    'vignette=angle=PI/5',
  ].join(',');
  const graph = `[1:v]format=rgba,geq=r=${ar}:g=${ag}:b=${ab}:a='255*0.2*(${motif.a})'[pat];[0:v][pat]overlay=format=auto,${chain}`;
  const args = ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `gradients=s=${W}x${H}:c0=${hex(glow)}:c1=${hex(deep)}:x0=${Math.round(W * 0.78)}:y0=${Math.round(H * 0.42)}` +
      `:x1=${Math.round(W * 0.05)}:y1=${H}:nb_colors=2:type=radial:speed=0`,
    '-f', 'lavfi', '-i', `color=c=black@0:s=${W}x${H}`,
    '-filter_complex', graph,
    '-frames:v', '1', '-update', '1', file];
  try {
    await new Promise((resolve, reject) => execFile(config.ffmpeg, args, { timeout: 30000 }, (err, _o, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve())));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  // Older renders of this channel (previous name/number/design) are no longer referenced.
  for (const f of fs.readdirSync(dir)) if (f.startsWith(`${channel.id}-`) && path.join(dir, f) !== file) fs.rmSync(path.join(dir, f), { force: true });
  log.debug(`art: rendered ${path.basename(file)} (${palette(channel).name}, ${motif.name})`);
  return file;
}

export const _test = { lines, palette, MOTIFS };
