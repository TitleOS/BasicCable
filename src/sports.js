// Scores for the sports channel, from ESPN's public site API (no key needed). Three parts:
//  - a team index: every pro and college team in the leagues below, with the state its home venue is in, built
//    once in the background (a few thousand small requests) and kept in DATA_DIR/sports for a month;
//  - a team's games: its last result, a game in progress (with the live score), and its next game;
//  - "more sports" with no home state (UFC, golf, tennis, racing): the latest event and its result or leader.

import fs from 'node:fs';
import path from 'node:path';
import { DateTime } from 'luxon';
import { config, log, VERSION } from './config.js';

const SITE = 'https://site.api.espn.com/apis/site/v2/sports';
const CORE = 'https://sports.core.api.espn.com/v2/sports';
const UA = { 'user-agent': `BasicCable/${VERSION} (+https://github.com/TitleOS/BasicCable)`, accept: 'application/json' };
const MIN = 60e3;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Leagues with home teams, so with a state. `venue`: the league's team details reliably carry the venue's state. */
export const TEAM_LEAGUES = [
  { key: 'mlb', path: 'baseball/mlb', label: 'MLB', sport: 'Baseball', gender: 'men', level: 'pro', venue: true },
  { key: 'nba', path: 'basketball/nba', label: 'NBA', sport: 'Basketball', gender: 'men', level: 'pro', venue: true },
  { key: 'wnba', path: 'basketball/wnba', label: 'WNBA', sport: 'Basketball', gender: 'women', level: 'pro', venue: true },
  { key: 'nfl', path: 'football/nfl', label: 'NFL', sport: 'Football', gender: 'men', level: 'pro', venue: true },
  { key: 'nhl', path: 'hockey/nhl', label: 'NHL', sport: 'Hockey', gender: 'men', level: 'pro', venue: true },
  { key: 'mls', path: 'soccer/usa.1', label: 'MLS', sport: 'Soccer', gender: 'men', level: 'pro', venue: true },
  { key: 'nwsl', path: 'soccer/usa.nwsl', label: 'NWSL', sport: 'Soccer', gender: 'women', level: 'pro', venue: true },
  { key: 'cfb', path: 'football/college-football', label: 'NCAA Football', sport: 'Football', gender: 'men', level: 'college', venue: true },
  { key: 'mcbb', path: 'basketball/mens-college-basketball', label: "NCAA Men's Basketball", sport: 'Basketball', gender: 'men', level: 'college', venue: true },
  { key: 'wcbb', path: 'basketball/womens-college-basketball', label: "NCAA Women's Basketball", sport: 'Basketball', gender: 'women', level: 'college', venue: true },
  { key: 'mchockey', path: 'hockey/mens-college-hockey', label: "NCAA Men's Hockey", sport: 'Hockey', gender: 'men', level: 'college', venue: true },
  { key: 'wchockey', path: 'hockey/womens-college-hockey', label: "NCAA Women's Hockey", sport: 'Hockey', gender: 'women', level: 'college', venue: true },
  { key: 'cbase', path: 'baseball/college-baseball', label: 'NCAA Baseball', sport: 'Baseball', gender: 'men', level: 'college' },
  { key: 'csoft', path: 'baseball/college-softball', label: 'NCAA Softball', sport: 'Softball', gender: 'women', level: 'college' },
  { key: 'msoccer', path: 'soccer/usa.ncaa.m.1', label: "NCAA Men's Soccer", sport: 'Soccer', gender: 'men', level: 'college' },
  { key: 'wsoccer', path: 'soccer/usa.ncaa.w.1', label: "NCAA Women's Soccer", sport: 'Soccer', gender: 'women', level: 'college' },
];
const LEAGUE = Object.fromEntries(TEAM_LEAGUES.map((l) => [l.key, l]));

/** Sports without home teams, turned on one by one on the web page. */
export const EVENT_SPORTS = {
  ufc: { name: 'UFC', label: 'UFC', path: 'mma/ufc', kind: 'fight', color: 'd20a0a' },
  pfl: { name: 'PFL (MMA)', label: 'PFL', path: 'mma/pfl', kind: 'fight', color: 'b8860b' },
  pga: { name: 'PGA Tour golf', label: 'PGA TOUR', path: 'golf/pga', kind: 'golf', color: '1b4d89' },
  lpga: { name: 'LPGA golf', label: 'LPGA', path: 'golf/lpga', kind: 'golf', color: '00205b' },
  atp: { name: "ATP tennis (men's)", label: 'ATP', path: 'tennis/atp', kind: 'tennis', color: '0b3d91' },
  wta: { name: "WTA tennis (women's)", label: 'WTA', path: 'tennis/wta', kind: 'tennis', color: '7b2d8e' },
  f1: { name: 'Formula 1', label: 'F1', path: 'racing/f1', kind: 'race', color: 'e10600' },
  nascar: { name: 'NASCAR Cup Series', label: 'NASCAR', path: 'racing/nascar-premier', kind: 'race', color: 'ffd659' },
  indycar: { name: 'IndyCar', label: 'INDYCAR', path: 'racing/irl', kind: 'race', color: '0d3b66' },
};

export const STATES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware',
  DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
  KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
  MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
  NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon',
  PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah',
  VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};
const STATE_BY_NAME = new Map(Object.entries(STATES).map(([k, v]) => [v.toLowerCase(), k]));

/**
 * Over-the-air channels by network, as ESPN names the network. ESPN doesn't know channel numbers, so these are
 * a starting point the user edits; only the Twin Cities are filled in.
 */
export const DEFAULT_OTA = {
  MN: { ABC: '5', CBS: '4', FOX: '9', NBC: '11', PBS: '2', CW: '23', ION: '41', 'FOX 9+': '29', KSTC: '45' },
};

// ---------------------------------------------------------------------------
// fetching

async function getJson(url, { fetchImpl = fetch, timeout = 12000 } = {}) {
  const res = await fetchImpl(url, { headers: UA, signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Run `fn` over `items`, at most `n` at a time. */
async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

const hex = (c) => (/^[0-9a-f]{6}$/i.test(String(c || '')) ? String(c).toLowerCase() : '3a4a66');
const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim();
const corePath = (L) => { const [sport, league] = L.path.split('/'); return `${CORE}/${sport}/leagues/${league}`; };

/** The two-letter state of a venue: its address's state, or a state name at the end of its city ("Saint Paul, Minnesota"). */
export function venueState(venue) {
  const a = venue?.address || {};
  if (a.country && !/^(usa|us|united states)$/i.test(a.country)) return null;
  const s = String(a.state || '').trim().toUpperCase();
  if (STATES[s]) return s;
  const fromName = STATE_BY_NAME.get(String(a.state || '').trim().toLowerCase());
  if (fromName) return fromName;
  const m = String(a.city || '').match(/,\s*([A-Za-z .]+)$/);
  if (m) {
    const t = m[1].trim();
    if (STATES[t.toUpperCase()]) return t.toUpperCase();
    return STATE_BY_NAME.get(t.toLowerCase()) || null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// the team index

export const SPORTS_DIR = path.join(config.dataDir, 'sports');
const INDEX_FILE = () => path.join(SPORTS_DIR, 'teams.json');
const INDEX_VERSION = 1;
export const INDEX_TTL = 30 * DAY;
// Men's college hockey lists Division III programs too; these are the Division I conferences.
const D1_HOCKEY = /atlantic hockey|big ten|central collegiate|\bccha\b|ecac|hockey east|national collegiate hockey|\bnchc\b|independent/i;

let index = null;
let building = null;
let progress = { done: 0, total: 0, error: null };

function loadIndex() {
  if (index) return index;
  try {
    const j = JSON.parse(fs.readFileSync(INDEX_FILE(), 'utf8'));
    if (j.version === INDEX_VERSION && Array.isArray(j.teams)) index = j;
  } catch { /* not built yet */ }
  return index;
}

/** Where the index stands, for the web page: { ready, building, builtAt, done, total, error }. */
export function indexStatus() {
  loadIndex();
  return { ready: !!index, building: !!building, builtAt: index?.builtAt || null, teams: index?.teams.length || 0, done: progress.done, total: progress.total, error: progress.error };
}

/** Make sure the index exists and is under a month old; builds it in the background otherwise. Resolves to it. */
export function ensureTeamIndex({ fetchImpl, force = false } = {}) {
  loadIndex();
  if (building) return building;
  if (index && !force && Date.now() - index.builtAt < INDEX_TTL) return Promise.resolve(index);
  progress = { done: 0, total: 0, error: null };
  building = buildIndex({ fetchImpl })
    .then((ix) => {
      index = ix;
      fs.mkdirSync(SPORTS_DIR, { recursive: true });
      fs.writeFileSync(`${INDEX_FILE()}.part`, JSON.stringify(ix));
      fs.renameSync(`${INDEX_FILE()}.part`, INDEX_FILE());
      log.info(`sports: indexed ${ix.teams.length} teams in ${TEAM_LEAGUES.length} leagues`);
      return ix;
    })
    .catch((e) => {
      progress.error = e.message;
      log.warn(`sports: could not build the team list (${e.message})${index ? '; keeping the old one' : ''}`);
      return index;
    })
    .finally(() => { building = null; });
  return building;
}

/** The state of a team's home venue, from a home game (not at a neutral site) on its schedule. */
async function homeVenueState(L, id, fetchImpl) {
  const d = await getJson(`${SITE}/${L.path}/teams/${id}/schedule`, { fetchImpl });
  for (const e of d.events || []) {
    const c = e.competitions?.[0];
    const us = (c?.competitors || []).find((x) => String(x.team?.id ?? x.id) === String(id));
    if (us?.homeAway === 'home' && !c.neutralSite) {
      const s = venueState(c.venue);
      if (s) return s;
    }
  }
  return null;
}

async function buildIndex({ fetchImpl } = {}) {
  const lists = {};
  for (const L of TEAM_LEAGUES) {
    const d = await getJson(`${SITE}/${L.path}/teams?limit=1000`, { fetchImpl });
    lists[L.key] = (d.sports?.[0]?.leagues?.[0]?.teams || []).map((x) => x.team)
      .filter((t) => t?.id && t.isActive !== false && !t.isAllStar)
      .map((t) => ({ league: L.key, id: String(t.id), name: t.displayName || t.name || '', abbr: t.abbreviation || '', color: hex(t.color), location: t.location || '' }));
  }
  progress.total = Object.values(lists).reduce((n, l) => n + l.length, 0);
  // Division I schools: the college basketball lists hold only Division I.
  const d1 = new Set([...lists.mcbb, ...lists.wcbb].flatMap((t) => [norm(t.name)]));
  const school = new Map(); // college name -> state, from leagues with venues, for leagues without
  const groups = new Map(); // conference $ref -> its name
  const order = [...TEAM_LEAGUES].sort((a, b) => (b.venue ? 1 : 0) - (a.venue ? 1 : 0));
  for (const L of order) {
    await mapLimit(lists[L.key], 8, async (t) => {
      try {
        const known = L.level === 'college' ? school.get(norm(t.name)) : null;
        if (known && !L.venue) { t.state = known; return; }
        let d = null;
        try {
          d = await getJson(`${corePath(L)}/teams/${t.id}?lang=en`, { fetchImpl });
        } catch { /* fall through to the schedule */ }
        t.state = venueState(d?.venue) || known || null;
        // Some teams' details have no venue (MLB in the off-season, much of MLS): a home game on the
        // schedule names it.
        if (!t.state) t.state = await homeVenueState(L, t.id, fetchImpl).catch(() => null);
        if (L.key === 'mchockey' && d?.groups?.$ref) {
          if (!groups.has(d.groups.$ref)) groups.set(d.groups.$ref, getJson(d.groups.$ref.replace(/^http:/, 'https:'), { fetchImpl }).then((g) => g.name || '').catch(() => ''));
          t.conference = await groups.get(d.groups.$ref);
        }
      } finally {
        if (t.state && L.level === 'college' && !school.has(norm(t.name))) school.set(norm(t.name), t.state);
        progress.done++;
      }
    });
  }
  const teams = [];
  for (const L of TEAM_LEAGUES) {
    for (const t of lists[L.key]) {
      if (!t.state) continue;
      const isD1 = L.level === 'pro' ? true
        : L.key === 'wchockey' ? true
          : L.key === 'mchockey' ? D1_HOCKEY.test(t.conference || '')
            : d1.has(norm(t.name));
      teams.push({ league: t.league, id: t.id, name: t.name, abbr: t.abbr, color: t.color, state: t.state, d1: isD1 });
    }
  }
  return { version: INDEX_VERSION, builtAt: Date.now(), teams };
}

export const teamKey = (t) => `${t.league}:${t.id}`;

/** Ticked when the state is picked: pro teams and Division I college programs. */
export const defaultOn = (t) => LEAGUE[t.league]?.level === 'pro' || !!t.d1;

/** Every indexed team in a state: pro teams first (by league), then colleges by school, each school's sports together. */
export function teamsInState(state) {
  const ix = loadIndex();
  if (!ix || !STATES[state]) return [];
  const rank = Object.fromEntries(TEAM_LEAGUES.map((l, i) => [l.key, i]));
  return ix.teams.filter((t) => t.state === state).sort((a, b) => {
    const pa = LEAGUE[a.league].level === 'pro' ? 0 : 1, pb = LEAGUE[b.league].level === 'pro' ? 0 : 1;
    if (pa !== pb) return pa - pb;
    if (pa === 1) {
      if (a.d1 !== b.d1) return a.d1 ? -1 : 1;
      const n = a.name.localeCompare(b.name);
      if (n) return n;
    }
    return rank[a.league] - rank[b.league];
  });
}

/** The teams a channel shows, as "league:id" keys: its own choice, or the state's defaults. */
export function selectedTeams(cfg) {
  if (Array.isArray(cfg?.teams)) return cfg.teams.filter((k) => LEAGUE[String(k).split(':')[0]]);
  return teamsInState(cfg?.state).filter(defaultOn).map(teamKey);
}

/** Team details from the index, or null. */
export function indexedTeam(key) {
  const [league, id] = String(key).split(':');
  return loadIndex()?.teams.find((t) => t.league === league && t.id === id) || null;
}

export const leagueOf = (key) => LEAGUE[key] || null;

// ---------------------------------------------------------------------------
// broadcasts and over-the-air channels

const netKey = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9+]/g, '');

/** Parse "FOX = 9" lines (or an object) into { FOX: '9' }. Throws on a line it can't read. */
export function parseOta(input) {
  if (input && typeof input === 'object' && !Array.isArray(input)) return parseOta(Object.entries(input).map(([k, v]) => `${k} = ${v}`).join('\n'));
  const out = {};
  for (const raw of String(input || '').split(/\n|;/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(.{1,24}?)\s*[=:]\s*(\d{1,3}(?:[.-]\d{1,2})?)$/);
    if (!m) throw new Error(`Can't read "${line.slice(0, 40)}": write it as NETWORK = channel, e.g. FOX = 9`);
    out[m[1].trim()] = m[2].replace('-', '.');
  }
  return out;
}

/** The first of a game's TV networks that has an over-the-air channel: { name, channel }, or null. */
export function otaFor(names, ota) {
  const map = new Map(Object.entries(ota || {}).map(([k, v]) => [netKey(k), v]));
  for (const n of names || []) {
    const ch = map.get(netKey(n));
    if (ch) return { name: n, channel: ch };
  }
  return null;
}

/**
 * TV network names for a game: national ones and the team's own market. ESPN uses two shapes:
 * { type: { shortName: 'TV' }, market: { type: 'Home' }, media: { shortName } } and { market: 'home', names: [] }.
 */
export function broadcastNames(list, homeAway = '') {
  const out = [];
  for (const b of list || []) {
    const type = String(b.type?.shortName || 'TV');
    if (type !== 'TV') continue;
    const market = String(typeof b.market === 'string' ? b.market : b.market?.type || 'national').toLowerCase();
    if (market !== 'national' && homeAway && market !== homeAway.toLowerCase()) continue;
    for (const n of b.media?.shortName ? [b.media.shortName] : b.names || []) if (n && !out.includes(n)) out.push(n);
  }
  return out;
}

// ---------------------------------------------------------------------------
// a team's games

const scoreOf = (s) => (s == null ? null : typeof s === 'object' ? String(s.displayValue ?? s.value ?? '') : String(s));

function sideOf(x) {
  const t = x.team || {};
  return { id: String(t.id ?? x.id ?? ''), name: t.displayName || t.name || '', short: t.shortDisplayName || t.name || t.displayName || '', abbr: t.abbreviation || '', color: hex(t.color), score: scoreOf(x.score), winner: x.winner === true };
}

/** One game from a schedule (or a summary's header), seen from `teamId`'s side, or null. */
export function parseGame(e, teamId, comp = e?.competitions?.[0]) {
  if (!comp) return null;
  const cs = comp.competitors || [];
  const us = cs.find((x) => String(x.team?.id ?? x.id) === String(teamId));
  const them = cs.find((x) => x !== us);
  if (!us || !them) return null;
  const st = comp.status?.type || e.status?.type || {};
  return {
    id: String(e.id ?? comp.id ?? ''), date: Date.parse(e.date || comp.date), home: us.homeAway === 'home', neutral: !!comp.neutralSite,
    us: sideOf(us), them: sideOf(them), state: st.state || 'pre', completed: !!st.completed, detail: st.shortDetail || st.detail || '',
    broadcasts: broadcastNames(comp.broadcasts?.length ? comp.broadcasts : e.broadcasts, us.homeAway),
  };
}

/** W, L or T from a finished game, by the winner flag or else the score. */
export function resultOf(g) {
  if (g.us.winner) return 'W';
  if (g.them.winner) return 'L';
  const a = Number(g.us.score), b = Number(g.them.score);
  if (Number.isFinite(a) && Number.isFinite(b)) return a > b ? 'W' : a < b ? 'L' : 'T';
  return '';
}

const cache = new Map(); // url -> { at, ttl, data }
async function cached(url, ttl, { fetchImpl, now = Date.now() } = {}) {
  const hit = cache.get(url);
  if (hit && now - hit.at < hit.ttl) return hit.data;
  try {
    const data = await getJson(url, { fetchImpl });
    cache.set(url, { at: now, ttl, data });
    return data;
  } catch (e) {
    if (hit) { hit.at = now - hit.ttl + MIN; return hit.data; } // the last good answer; try again in a minute
    throw e;
  }
}

const SCHEDULE_TTL = 15 * MIN;
const LIVE_TTL = 50e3;
const OLD_SEASON_TTL = 12 * HOUR;
// A game counts as on now from its start time until it is final (ESPN's own status can lag a few minutes).
const GAME_WINDOW = 6 * HOUR;

/**
 * A team's games: { team, last, live, next }. `last` is the latest final; `live` a game in progress with its
 * current score; `next` the next game. Off-season teams (a new season with nothing played yet) get their last
 * game from the season before.
 */
export async function teamGames(league, id, { fetchImpl, now = Date.now() } = {}) {
  const L = LEAGUE[league];
  if (!L) throw new Error(`Unknown league ${league}`);
  const base = `${SITE}/${L.path}/teams/${id}/schedule`;
  const d = await cached(base, SCHEDULE_TTL, { fetchImpl, now });
  const team = d.team ? { name: d.team.displayName || '', abbr: d.team.abbreviation || '', color: hex(d.team.color) } : null;
  let games = (d.events || []).map((e) => parseGame(e, id)).filter(Boolean);
  if (!games.some((g) => g.completed)) {
    const year = Number(d.requestedSeason?.year || d.season?.year || new Date(now).getUTCFullYear()) - 1;
    for (const type of [2, 3]) {
      try {
        const old = await cached(`${base}?season=${year}&seasontype=${type}`, OLD_SEASON_TTL, { fetchImpl, now });
        games = games.concat((old.events || []).map((e) => parseGame(e, id)).filter(Boolean));
      } catch { /* no such season type */ }
    }
  }
  games.sort((a, b) => a.date - b.date);
  let live = games.find((g) => !g.completed && (g.state === 'in' || (g.date <= now && now - g.date < GAME_WINDOW && g.state !== 'post'))) || null;
  if (live) {
    // The schedule is cached; the summary has the score as it stands.
    try {
      const s = await cached(`${SITE}/${L.path}/summary?event=${live.id}`, LIVE_TTL, { fetchImpl, now });
      const comp = s.header?.competitions?.[0];
      const fresh = comp && parseGame({ id: live.id, date: comp.date || new Date(live.date).toISOString(), broadcasts: s.broadcasts }, id, comp);
      if (fresh) {
        if (!fresh.broadcasts.length) fresh.broadcasts = live.broadcasts;
        Object.assign(live, fresh);
      }
    } catch (e) {
      log.warn(`sports: live score for ${L.label} game ${live.id}: ${e.message}`);
    }
    if (live.completed || live.state === 'post') live = null;
    else if (live.state === 'pre') live = null; // not started yet after all (a delay)
  }
  const done = games.filter((g) => g.completed || g.state === 'post');
  const last = done.length ? done[done.length - 1] : null;
  const next = games.find((g) => !g.completed && g.state !== 'post' && g !== live && g.date > now) || null;
  return { team, last, live, next };
}

// ---------------------------------------------------------------------------
// sports without home teams

const eventState = (e) => e?.status?.type?.state || e?.competitions?.[0]?.status?.type?.state || 'pre';
const athlete = (x) => x?.athlete?.shortName || x?.athlete?.displayName || x?.team?.displayName || x?.displayName || '';
const lastName = (s) => String(s || '').trim().split(/\s+/).pop();

/** The headline of an event, by sport: { headline, detail, live }. */
export function summarizeEvent(kind, e) {
  const state = eventState(e);
  const live = state === 'in';
  const comps = e.competitions || [];
  const detail = e.status?.type?.shortDetail || comps[0]?.status?.type?.shortDetail || '';
  if (kind === 'fight') {
    // The main event closes the card; find it by the names in the event's title, else take the last bout.
    const names = String(e.name || '').split(':').pop().split(/\s+vs\.?\s+/i).map((s) => lastName(s).toLowerCase());
    const main = comps.find((c) => names.length === 2 && names.every((n) => (c.competitors || []).some((x) => athlete(x).toLowerCase().endsWith(n)))) || comps[comps.length - 1];
    const finished = comps.filter((c) => c.status?.type?.completed);
    const said = (c) => {
      const w = (c.competitors || []).find((x) => x.winner), l = (c.competitors || []).find((x) => x !== w);
      return w ? `${athlete(w)} def. ${athlete(l)}` : (c.competitors || []).map(athlete).join(' vs. ');
    };
    if (main?.status?.type?.completed) return { headline: said(main), detail: 'Main event · Final', live: false };
    if (live) {
      const latest = finished[finished.length - 1];
      return { headline: latest ? said(latest) : (main ? said(main) : e.name), detail: `${finished.length} of ${comps.length} bouts done`, live };
    }
    return { headline: main ? said(main) : e.name, detail: state === 'post' ? 'Final' : 'Main event', live };
  }
  if (kind === 'golf') {
    const c = comps[0] || {};
    const field = [...(c.competitors || [])].sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
    const lead = field[0];
    const score = (x) => scoreOf(x?.score) || '';
    const cDetail = c.status?.type?.shortDetail || c.status?.type?.detail || detail;
    if (!lead) return { headline: e.name, detail: cDetail, live };
    if (state === 'post') return { headline: `${athlete(lead)} wins at ${score(lead)}`, detail: 'Final', live: false };
    const chase = field.slice(1, 3).map((x) => `${lastName(athlete(x))} ${score(x)}`).join(', ');
    return { headline: `${athlete(lead)} leads at ${score(lead)}`, detail: [cDetail, chase].filter(Boolean).join(' · '), live };
  }
  if (kind === 'tennis') {
    const singles = (e.groupings || []).filter((g) => /singles/i.test(g.grouping?.displayName || ''));
    const matches = singles.flatMap((g) => g.competitions || []).sort((a, b) => Date.parse(a.date || 0) - Date.parse(b.date || 0));
    const sets = (c) => {
      const [a, b] = c.competitors || [];
      return (a?.linescores || []).map((s, i) => `${s.value ?? ''}-${b?.linescores?.[i]?.value ?? ''}`).join(' ');
    };
    const said = (c) => {
      const w = (c.competitors || []).find((x) => x.winner), l = (c.competitors || []).find((x) => x !== w);
      return w ? `${athlete(w)} def. ${athlete(l)}` : (c.competitors || []).map(athlete).join(' vs. ');
    };
    const inPlay = matches.filter((c) => c.status?.type?.state === 'in');
    if (inPlay.length) {
      const c = inPlay[inPlay.length - 1];
      return { headline: said(c), detail: [c.round?.displayName, sets(c)].filter(Boolean).join(' · ') + (inPlay.length > 1 ? ` · ${inPlay.length} matches on` : ''), live: true };
    }
    const final = matches.filter((c) => c.status?.type?.completed && /^final$/i.test(c.round?.displayName || '')).pop();
    const latest = final || matches.filter((c) => c.status?.type?.completed).pop();
    if (latest) return { headline: final ? `Champion: ${said(latest)}` : said(latest), detail: [latest.round?.displayName, sets(latest)].filter(Boolean).join(' · '), live: false };
    return { headline: e.name, detail, live };
  }
  if (kind === 'race') {
    const race = comps.find((c) => /race/i.test(`${c.type?.abbreviation || ''} ${c.type?.text || ''}`)) || comps[comps.length - 1] || {};
    const order = [...(race.competitors || [])].sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
    const winner = order.find((x) => x.winner) || (race.status?.type?.completed ? order[0] : null);
    // The event's date is the start of the race weekend; the race has its own.
    if (winner) return { headline: `${athlete(winner)} wins`, detail: order.filter((x) => x !== winner).slice(0, 2).map((x, i) => `${i + 2}. ${athlete(x)}`).join(' · '), live: false, date: Date.parse(race.date) || null };
    if (live || race.status?.type?.state === 'in') return { headline: order[0] ? `${athlete(order[0])} leads` : e.name, detail: race.status?.type?.shortDetail || detail, live: true };
    return { headline: e.name, detail, live: false };
  }
  return { headline: e.name || '', detail, live };
}

const ymd = (ms) => new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');

/**
 * The card for an event sport: the event on now, else the latest finished one, else the next one along with
 * the result of the one before it. Resolves to { title, headline, detail, live, date, next }.
 */
export async function eventSport(key, { fetchImpl, now = Date.now() } = {}) {
  const S = EVENT_SPORTS[key];
  if (!S) throw new Error(`Unknown sport ${key}`);
  const sb = await cached(`${SITE}/${S.path}/scoreboard`, 3 * MIN, { fetchImpl, now });
  const events = sb.events || [];
  const pick = events.find((e) => eventState(e) === 'in')
    || events.filter((e) => eventState(e) === 'post').sort((a, b) => Date.parse(b.date) - Date.parse(a.date))[0]
    || events[0];
  if (!pick) return { title: S.name, headline: 'No events scheduled', detail: '', live: false, date: null, next: null };
  // Dated by the race itself, or by the last day of a finished tournament, else by when the event starts.
  const card = (e) => {
    const s = summarizeEvent(S.kind, e);
    const date = s.date || (eventState(e) === 'post' && Date.parse(e.endDate)) || Date.parse(e.date) || null;
    return { title: e.name || e.shortName || S.name, ...s, date };
  };
  if (eventState(pick) !== 'pre') return { ...card(pick), next: null };
  // Only the next event is listed: show the one before it from the season calendar, and mention the next.
  const next = { title: pick.name || '', date: Date.parse(pick.date) || null };
  const cal = (sb.leagues?.[0]?.calendar || []).filter((c) => c && typeof c === 'object' && c.endDate && Date.parse(c.endDate) < now);
  const prev = cal.sort((a, b) => Date.parse(a.endDate) - Date.parse(b.endDate)).pop();
  if (prev) {
    try {
      const from = Date.parse(prev.startDate) - DAY, to = Date.parse(prev.endDate) + DAY;
      const old = await cached(`${SITE}/${S.path}/scoreboard?dates=${ymd(from)}-${ymd(to)}`, OLD_SEASON_TTL, { fetchImpl, now });
      const id = String(prev.event?.$ref || '').match(/events\/(\d+)/)?.[1] || prev.id;
      const e = (old.events || []).find((x) => String(x.id) === String(id)) || (old.events || []).filter((x) => eventState(x) === 'post').pop();
      if (e) return { ...card(e), next };
    } catch (err) {
      log.warn(`sports: ${S.name}: the last event: ${err.message}`);
    }
  }
  return { ...card(pick), next: null };
}

// ---------------------------------------------------------------------------
// the cards the channel shows

/** "Sat, Nov 14" in the zone. */
export const dayLabel = (ms, zone) => DateTime.fromMillis(ms, { zone }).toFormat('ccc, LLL d');

/** "Today 7:00 PM", "Tomorrow 1:00 PM", "Tue 7:00 PM" or "Sat, Dec 6". */
export function whenLabel(ms, zone, now = Date.now()) {
  const t = DateTime.fromMillis(ms, { zone });
  const today = DateTime.fromMillis(now, { zone }).startOf('day');
  const days = Math.floor(t.startOf('day').diff(today, 'days').days);
  const time = t.toFormat('h:mm a');
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Tomorrow ${time}`;
  if (days > 1 && days < 7) return `${t.toFormat('ccc')} ${time}`;
  return t.toFormat('ccc, LLL d');
}

/**
 * Everything the channel shows, in order: games on now first, then by how recently each team played (or will),
 * the other sports mixed in by date. Each card:
 *  team:  { kind: 'team', key, label, team, live, last, next, ota, nextOta, error }
 *  event: { kind: 'event', key, label, color, title, headline, detail, live, date, next, error }
 */
export async function sportsCards(cfg, { fetchImpl, now = Date.now() } = {}) {
  const keys = selectedTeams(cfg);
  const teams = await mapLimit(keys, 6, async (key) => {
    const [league, id] = key.split(':');
    const L = LEAGUE[league];
    const known = indexedTeam(key);
    try {
      const g = await teamGames(league, id, { fetchImpl, now });
      const team = { name: g.team?.name || known?.name || '', abbr: g.team?.abbr || known?.abbr || '', color: g.team?.color || known?.color || '3a4a66' };
      return {
        kind: 'team', key, label: L.label, team, live: g.live, last: g.last, next: g.next,
        ota: g.live ? otaFor(g.live.broadcasts, cfg.ota) : null,
        nextOta: g.next ? otaFor(g.next.broadcasts, cfg.ota) : null,
        sortAt: g.live ? Infinity : Math.max(g.last?.date || 0, g.next && g.next.date - now < DAY ? g.next.date : 0),
      };
    } catch (e) {
      return { kind: 'team', key, label: L.label, team: { name: known?.name || key, abbr: known?.abbr || '', color: known?.color || '3a4a66' }, error: e.message, sortAt: 0 };
    }
  });
  const extras = Object.keys(EVENT_SPORTS).filter((k) => cfg.extras?.[k]);
  const events = await mapLimit(extras, 4, async (key) => {
    const S = EVENT_SPORTS[key];
    try {
      const c = await eventSport(key, { fetchImpl, now });
      return { kind: 'event', key, label: S.label, color: S.color, ...c, sortAt: c.live ? Infinity : c.date || 0 };
    } catch (e) {
      return { kind: 'event', key, label: S.label, color: S.color, title: S.name, headline: '', detail: '', error: e.message, sortAt: 0 };
    }
  });
  return [...teams, ...events].sort((a, b) => b.sortAt - a.sortAt);
}

export const CARDS_PER_PAGE = 8;

/**
 * Split the cards into pages of `per`. While one to three games are on, they are pinned to the top of every
 * page so a live score is never more than a page turn away; with more, they simply come first.
 */
export function paginate(cards, per = CARDS_PER_PAGE) {
  const live = cards.filter((c) => c.live);
  const rest = cards.filter((c) => !c.live);
  const pin = live.length >= 1 && live.length <= 3 && cards.length > per ? live : [];
  const pool = pin.length ? rest : cards;
  const room = per - pin.length;
  const pages = [];
  for (let i = 0; i < pool.length; i += room) pages.push([...pin, ...pool.slice(i, i + room)]);
  return pages.length ? pages : [[]];
}

export const _test = { cache, reset: () => { index = null; building = null; cache.clear(); progress = { done: 0, total: 0, error: null }; }, mapLimit };
