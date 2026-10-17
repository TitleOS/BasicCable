// Forgiving parsers for the way people describe schedules: "weeknights", "mon-fri", "8:30pm", "1h30m",
// "movie: Heat (1995)". Used by the MCP tools so requests can stay close to how they were phrased.

const DAY_NAMES = {
  mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, weds: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5, sat: 6, saturday: 6, sun: 7, sunday: 7,
};

function dayOf(token) {
  const t = token.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/s$/, '');
  if (/^[1-7]$/.test(t)) return Number(t);
  return DAY_NAMES[t] ?? DAY_NAMES[`${t}s`] ?? null;
}

/** Days of the week as ISO numbers (1 = Monday ... 7 = Sunday). Throws with a hint on anything unknown. */
export function parseDays(input) {
  const parts = (Array.isArray(input) ? input : [input]).flatMap((x) => (typeof x === 'number' ? [String(x)] : String(x).split(/\s*(?:,|\band\b|&|\/)\s*/i)));
  const out = new Set();
  for (const raw of parts) {
    const p = raw.trim().toLowerCase();
    if (!p) continue;
    if (/^(daily|every ?day|all( days)?|everyday|7 days)$/.test(p)) [1, 2, 3, 4, 5, 6, 7].forEach((d) => out.add(d));
    else if (/^(week ?days?|week ?nights?|mon(day)?\s*(?:-|–|to|through|thru)\s*fri(day)?)$/.test(p)) [1, 2, 3, 4, 5].forEach((d) => out.add(d));
    else if (/^(week ?ends?)$/.test(p)) [6, 7].forEach((d) => out.add(d));
    else {
      const range = p.match(/^([a-z0-9]+)\s*(?:-|–|to|through|thru)\s*([a-z0-9]+)$/);
      if (range) {
        const a = dayOf(range[1]), b = dayOf(range[2]);
        if (!a || !b) throw new Error(`Unknown day range "${raw}"`);
        for (let d = a; ; d = (d % 7) + 1) { out.add(d); if (d === b) break; }
      } else {
        const d = dayOf(p);
        if (!d) throw new Error(`Unknown day "${raw}". Use names like mon, tuesday, or words like weekdays, weekends, daily.`);
        out.add(d);
      }
    }
  }
  if (!out.size) throw new Error('No days given. Use names like mon, tuesday, or words like weekdays, weekends, daily.');
  return [...out].sort();
}

/** "8pm", "8:30 PM", "20:00", "0830", "noon", "midnight" -> "HH:MM" (24h). */
export function parseClock(input) {
  const s = String(input).trim().toLowerCase().replace(/\./g, '');
  if (s === 'noon' || s === 'midday') return '12:00';
  if (s === 'midnight') return '00:00';
  const m = s.match(/^(\d{1,2})(?::?(\d{2}))?\s*(am|pm|a|p)?$/);
  if (!m) throw new Error(`Couldn't read the time "${input}". Use forms like 8pm, 8:30 PM or 20:00.`);
  let h = Number(m[1]);
  const min = Number(m[2] || 0);
  const ap = m[3];
  if (ap) {
    if (h < 1 || h > 12) throw new Error(`"${input}" isn't a valid 12-hour time`);
    if (ap.startsWith('p') && h !== 12) h += 12;
    if (ap.startsWith('a') && h === 12) h = 0;
  }
  if (h > 23 || min > 59) throw new Error(`"${input}" isn't a valid time`);
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/** 90, "90", "90m", "1h", "1h30m", "1.5 hours", "45 minutes" -> minutes. */
export function parseDuration(input) {
  if (typeof input === 'number') return Math.round(input);
  const s = String(input).trim().toLowerCase();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s));
  let total = 0;
  let matched = false;
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)\s*(h|hr|hrs|hours?|m|min|mins|minutes?)(?![a-z])/g)) {
    matched = true;
    total += m[2].startsWith('h') ? Number(m[1]) * 60 : Number(m[1]);
  }
  if (!matched) throw new Error(`Couldn't read the length "${input}". Use minutes (90) or forms like 1h30m.`);
  return Math.round(total);
}

/** Minutes from start to end, wrapping past midnight ("10pm" to "1am" = 180). */
export function minutesBetween(startHHMM, endHHMM) {
  const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
  let d = toMin(endHHMM) - toMin(startHHMM);
  if (d <= 0) d += 24 * 60;
  return d;
}

/**
 * Pick apart a title as written: "Modern Family", "movie: Heat (1995)", "tt0386676", "Star Trek*",
 * "movies: Batman*". Returns { query, types, year, imdb, wildcard }.
 */
export function parseTitleSpec(input) {
  let s = String(input).trim();
  let types = null;
  const prefix = s.match(/^(movies?|films?|shows?|series|tv|any|all|both)\s*:\s*/i);
  if (prefix) {
    const p = prefix[1].toLowerCase();
    types = /^(movie|film)/.test(p) ? ['movie'] : /^(show|series|tv)/.test(p) ? ['series'] : ['series', 'movie'];
    s = s.slice(prefix[0].length).trim();
  }
  const imdb = s.match(/^tt\d{5,10}$/i) ? s.toLowerCase() : null;
  let year = null;
  const y = s.match(/\s*\((\d{4})\)\s*$/) || s.match(/\s+(\d{4})$/);
  if (y && !imdb && Number(y[1]) > 1900 && Number(y[1]) < 2100 && s.replace(y[0], '').trim()) {
    year = Number(y[1]);
    s = s.slice(0, s.length - y[0].length).trim();
  }
  const wildcard = /[*?]/.test(s);
  return { query: s, types, year, imdb, wildcard };
}

/** Lowercase, drop punctuation and articles' noise so "The Office (US)" ~ "the office us". */
export function normTitle(s) {
  return String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Resolution words to pixel heights: "4k" -> 2160, "1080p" -> 1080, "hd" -> 720. */
export function parseResolution(input) {
  const s = String(input).trim().toLowerCase();
  if (/^(4k|uhd|2160p?)$/.test(s)) return 2160;
  if (/^(2k|qhd|1440p?)$/.test(s)) return 1440;
  if (/^(fhd|full ?hd|1080p?)$/.test(s)) return 1080;
  if (/^(hd|720p?)$/.test(s)) return 720;
  if (/^(576p?)$/.test(s)) return 576;
  if (/^(sd|480p?)$/.test(s)) return 480;
  throw new Error(`Unknown resolution "${input}". Use 2160 (4K), 1440, 1080, 720, 576 or 480.`);
}
