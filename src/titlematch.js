// Is a release really the title we asked for? Stream addons sometimes answer one show's id with a sibling
// show's files (Comet hands out "Star.Wars.The.Clone.Wars.S01E05" for the 2003 "Star Wars: Clone Wars"). We
// read the title off the release name and drop it when it names another title the server knows about.

const VIDEO_EXT = /\.(mkv|mp4|m4v|avi|ts|m2ts|webm|mov|wmv)$/i;
// Where the title part of a release name ends: episode numbers, quality and source tags.
const STOP = /^(?:s\d{1,2}(?:e\d{1,3})*|\d{1,2}x\d{2,3}|seasons?|complete|episodes?|\d{3,4}[pi]|4k|uhd|bluray|bdrip|brrip|hdrip|webrip|webdl|web|hdtv|dvdrip|dvd|remux|[xh]26[45]|hevc|avc|proper|repack|multi|dual)$/i;
const YEAR = /^(19\d{2}|20\d{2})$/;

/** Lower case, no accents or punctuation, "&" as "and", no leading "the". */
export function normalizeTitle(s) {
  return String(s).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/['’`]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
    .replace(/^the /, '');
}

/** The title (and year, when it carries one) at the start of a release or file name, or null. */
export function parseReleaseTitle(text) {
  const clean = String(text).trim().replace(VIDEO_EXT, '')
    .replace(/^[^\p{L}\p{N}([]+/u, '') // Comet's "📄 " and the like
    .replace(/^(?:\[[^\]]*\]\s*)+/, '') // leading [group] tags
    .replace(/[._-]+/g, ' ');
  const kept = [];
  let year = null;
  for (const tok of clean.split(/\s+/).filter(Boolean)) {
    if (/^[([]/.test(tok)) {
      const y = tok.match(/^[([]\s*(19\d{2}|20\d{2})/);
      if (y) year = Number(y[1]);
      break;
    }
    if (STOP.test(tok)) break;
    kept.push(tok);
  }
  // "Heat 1995 1080p": a year right before the tags is the release year, not part of the name ("1917" alone is).
  if (year == null && kept.length > 1 && YEAR.test(kept[kept.length - 1])) year = Number(kept.pop());
  const name = normalizeTitle(kept.join(' '));
  return name ? { name, year } : null;
}

/** The release name to judge a stream by: its file name when it has one, else the first line that names a file, else the torrent name. */
export function streamReleaseTitle(stream) {
  const lines = [stream.title, stream.description].filter(Boolean).join('\n').split('\n').map((l) => l.trim()).filter(Boolean);
  const order = [stream.behaviorHints?.filename, ...lines.filter((l) => VIDEO_EXT.test(l)), lines[0]].filter(Boolean);
  for (const text of order) {
    const t = parseReleaseTitle(text);
    if (t) return t;
  }
  return null;
}

/** "2003–2005" -> [2003, 2005]; "2023–" -> [2023, this year]; "1995" -> [1995, 1995]. */
export function yearRange(releaseInfo) {
  const m = String(releaseInfo || '').match(/(\d{4})(?:\s*[–-]\s*(\d{4})?)?/);
  if (!m) return null;
  const start = Number(m[1]);
  const open = m[0].length > 4 && !m[2];
  return [start, m[2] ? Number(m[2]) : open ? new Date().getFullYear() : start];
}

/**
 * True when a stream's release names another known title rather than this one.
 * own: { id, names: [normalized names], years: [start, end] | null }
 * known: Map(normalized name -> Set of title ids) of every title the server plays.
 */
export function namesOtherTitle(stream, own, known) {
  const rt = streamReleaseTitle(stream);
  if (!rt) return false;
  const ids = known.get(rt.name);
  const elsewhere = !!ids && [...ids].some((id) => id !== own.id);
  if (own.names.includes(rt.name)) {
    // Same name as ours. A namesake ("Doctor Who" 2005 and 2023) can still be told apart by the year.
    if (!elsewhere || rt.year == null || !own.years) return false;
    return rt.year < own.years[0] - 1 || rt.year > own.years[1];
  }
  return elsewhere;
}
