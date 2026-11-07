// The pictures for the news channel: a transparent card laid over the picture of the day (the NEWS bug, the
// photo credit, the headline bar and the song caption), and the headline strip that ffmpeg scrolls through the
// bar. Both are SVGs that ffmpeg (librsvg) turns into images; the clock is drawn live by ffmpeg.

const FONT = "Montserrat, 'DejaVu Sans', Arial, sans-serif";
const esc = (s) => String(s ?? '').replace(/[<>&"']/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[ch]));
const f1 = (n) => Number(n.toFixed(1));

/**
 * About how wide a run of text is in Montserrat, in em. librsvg cannot report text widths, so the strip is
 * laid out from this estimate; it runs a little wide rather than narrow, so headlines never touch.
 */
export function textWidthEm(text, bold = false) {
  let em = 0;
  for (const ch of String(text)) {
    if (/[ijl'.,:;!|\s]/.test(ch)) em += 0.32;
    else if (/[ftrI()\[\]-]/.test(ch)) em += 0.42;
    else if (/[mwMW@%]/.test(ch)) em += 1.0;
    else if (/[A-Z]/.test(ch)) em += 0.76;
    else if (/[0-9]/.test(ch)) em += 0.64;
    else if (/[a-z]/.test(ch)) em += 0.63;
    else em += 0.7;
  }
  return em * (bold ? 1.06 : 1);
}

/** Layout for a frame of `width` x `height`: where the bar, the strip window and the clock go (frame pixels). */
export function newsLayout(width = 1920, height = 1080) {
  const S = width / 1920;
  const barY = Math.round(910 * S), barH = Math.round(92 * S);
  const labelW = Math.round(270 * S);
  return {
    S, barY, barH, labelW,
    ticker: { x: labelW, y: barY, w: width - labelW, h: barH },
    clockBox: { x: Math.round(1200 * S), y: Math.round(1002 * S), w: Math.round(640 * S), h: height - Math.round(1002 * S) },
    speed: Math.round(100 * S), // pixels per second: slow enough to read, about a headline every 10 seconds
  };
}

/**
 * The overlay card. `credit` is the picture's caption; with `opaque`, the card paints its own background
 * (when there is no picture of the day). Returns the SVG.
 */
export function newsCard({ width = 1920, height = 1080, credit = '', nowPlaying = '', sources = [], opaque = false, title = 'News' } = {}) {
  const L = newsLayout(width, height);
  const px = (n) => f1(n * L.S);
  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${FONT}">`);
  out.push('<defs><linearGradient id="shade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.8"/></linearGradient>' +
    '<linearGradient id="top" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0.55"/><stop offset="1" stop-color="#000" stop-opacity="0"/></linearGradient>' +
    '<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#132a4d"/><stop offset="1" stop-color="#070b14"/></linearGradient></defs>');
  if (opaque) out.push(`<rect width="${width}" height="${height}" fill="url(#bg)"/>`);
  out.push(`<rect x="0" y="0" width="${width}" height="${px(220)}" fill="url(#top)"/>`);
  out.push(`<rect x="0" y="${px(640)}" width="${width}" height="${height - px(640)}" fill="url(#shade)"/>`);
  // the bug, top left
  const bugW = Math.max(230, 60 + textWidthEm(title.toUpperCase(), true) * 44 + 4 * title.length);
  out.push(`<rect x="${px(80)}" y="${px(60)}" width="${px(bugW)}" height="${px(70)}" rx="${px(10)}" fill="#e5484d"/>`);
  out.push(`<text x="${px(80 + bugW / 2)}" y="${px(110)}" fill="#fff" font-size="${px(44)}" font-weight="700" text-anchor="middle" letter-spacing="${px(4)}">${esc(title.toUpperCase())}</text>`);
  if (sources.length) out.push(`<text x="${px(80 + bugW + 24)}" y="${px(108)}" fill="#fff" fill-opacity="0.85" font-size="${px(24)}" font-weight="700" letter-spacing="${px(2)}">${esc(sources.join(' · ').toUpperCase())}</text>`);
  // the picture's credit, above the bar
  if (credit) out.push(`<text x="${px(80)}" y="${px(885)}" fill="#fff" fill-opacity="0.75" font-size="${px(22)}">${esc(credit.length > 120 ? `${credit.slice(0, 118)}…` : credit)}</text>`);
  // the headline bar: its label is painted here; the strip is overlaid to its right at playout
  out.push(`<rect x="0" y="${L.barY}" width="${width}" height="${L.barH}" fill="#0b1220" fill-opacity="0.94"/>`);
  out.push(`<rect x="0" y="${L.barY}" width="${L.labelW}" height="${L.barH}" fill="#e5484d"/>`);
  out.push(`<text x="${L.labelW / 2}" y="${L.barY + L.barH * 0.64}" fill="#fff" font-size="${px(32)}" font-weight="700" text-anchor="middle" letter-spacing="${px(2)}">HEADLINES</text>`);
  // the caption bar: the song on the left, the clock's corner on the right
  out.push(`<rect x="0" y="${px(1002)}" width="${width}" height="${height - px(1002)}" fill="#000" fill-opacity="0.65"/>`);
  const caption = nowPlaying.length > 72 ? `${nowPlaying.slice(0, 70).replace(/\s+\S*$/, '')}…` : nowPlaying;
  out.push(`<text x="${px(80)}" y="${px(1052)}" fill="#c9ced9" font-size="${px(30)}">${caption ? `<tspan fill="#e5484d" font-weight="700">♪ </tspan>${esc(caption)}` : '<tspan fill="#8b93a7">Basic Cable · News</tspan>'}</text>`);
  out.push('</svg>');
  return out.join('\n');
}

/**
 * The headline strip: every headline with its source tag in one row, with the first window's worth repeated
 * at the end so the scroll wraps without a gap. Returns { svg, width, contentWidth }: ffmpeg shows a
 * `windowWidth`-wide crop moving through the first `contentWidth` pixels.
 */
export const MAX_STRIP_WIDTH = 32000; // the renderer (cairo) draws nothing wider than 32767 pixels

export function tickerStrip(headlines, { height = 92, windowWidth = 1650, scale = 1 } = {}) {
  const fontSize = Math.round(34 * scale), tagSize = Math.round(24 * scale);
  const gap = Math.round(56 * scale);
  const parts = [];
  let x = Math.round(24 * scale);
  const widthOf = (it) => Math.round(textWidthEm(it.tag || '', true) * tagSize + (it.tag || '').length * scale + 14 * scale) + Math.round(textWidthEm(it.title) * fontSize) + 2 * gap;
  // As many headlines as fit the renderer's limit, leaving room for the repeated start.
  const items = [];
  let est = x;
  for (const it of headlines.length ? headlines : [{ tag: '', title: 'Headlines are on their way…' }]) {
    if (items.length && est + widthOf(it) > MAX_STRIP_WIDTH - windowWidth) break;
    items.push(it);
    est += widthOf(it);
  }
  const draw = (it) => {
    if (it.tag) {
      parts.push(`<text x="${x}" y="${f1(height * 0.66)}" fill="#ffd166" font-size="${tagSize}" font-weight="700" letter-spacing="${f1(scale)}">${esc(it.tag)}</text>`);
      x += Math.round(textWidthEm(it.tag, true) * tagSize + it.tag.length * scale + 14 * scale);
    }
    parts.push(`<text x="${x}" y="${f1(height * 0.66)}" fill="#ffffff" font-size="${fontSize}">${esc(it.title)}</text>`);
    x += Math.round(textWidthEm(it.title) * fontSize) + gap;
    parts.push(`<circle cx="${x}" cy="${f1(height * 0.55)}" r="${f1(5 * scale)}" fill="#e5484d"/>`);
    x += gap;
  };
  for (const it of items) draw(it);
  const contentWidth = Math.max(x, windowWidth + 1);
  x = contentWidth;
  // repeat from the start until a full window is covered past the content's end
  for (let round = 0; round < 50 && x < contentWidth + windowWidth; round++) {
    for (const it of items) { if (x >= contentWidth + windowWidth) break; draw(it); }
  }
  const width = Math.min(MAX_STRIP_WIDTH + 700, Math.max(x, contentWidth + windowWidth));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${FONT}">${parts.join('')}</svg>`;
  return { svg, width, contentWidth, shown: items.length };
}
