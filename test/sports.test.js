import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'st-sports-'));
process.env.TZ = 'America/Chicago';
const sports = await import('../src/sports.js');
const { sportsPage, fit } = await import('../src/sportscard.js');
const { utilityConfig, utilityText } = await import('../src/utilities.js');
const { pauseDownloads } = await import('../src/music.js');
pauseDownloads(true);
const hasFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

const SITE = 'https://site.api.espn.com/apis/site/v2/sports';
const CORE = 'https://sports.core.api.espn.com/v2/sports';
const ZONE = 'America/Chicago';
const MIN = 60e3, HOUR = 60 * MIN, DAY = 24 * HOUR;

/** A fetch that answers from `routes` (url -> JSON, or a function of the url); anything else is a 404. */
function fakeFetch(routes, calls = []) {
  return async (url) => {
    calls.push(url);
    const hit = routes[url];
    const body = typeof hit === 'function' ? hit(url) : hit;
    if (body === undefined) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

const list = (...teams) => ({ sports: [{ leagues: [{ teams: teams.map((t) => ({ team: { isActive: true, ...t } })) }] }] });
const core = (L, id) => `${CORE}/${L.split('/')[0]}/leagues/${L.split('/')[1]}/teams/${id}?lang=en`;
const venue = (state, city = 'Somewhere') => ({ venue: { address: { city, state, country: 'USA' } } });

function indexRoutes() {
  const r = {};
  for (const L of sports.TEAM_LEAGUES) r[`${SITE}/${L.path}/teams?limit=1000`] = list();
  r[`${SITE}/hockey/nhl/teams?limit=1000`] = list({ id: '30', displayName: 'Minnesota Wild', abbreviation: 'MIN', color: '124734' }, { id: '1', displayName: 'Boston Bruins', abbreviation: 'BOS', color: 'ffb81c' });
  r[core('hockey/nhl', 30)] = venue('MN', 'Saint Paul');
  r[core('hockey/nhl', 1)] = venue('MA', 'Boston');
  // No venue in the team's details (MLB in the off-season): its schedule's home games name the ballpark.
  r[`${SITE}/baseball/mlb/teams?limit=1000`] = list({ id: '9', displayName: 'Minnesota Twins', abbreviation: 'MIN', color: '031f40' });
  r[core('baseball/mlb', 9)] = { venue: null };
  r[`${SITE}/baseball/mlb/teams/9/schedule`] = { events: [
    { competitions: [{ venue: { address: { city: 'Fort Myers', state: 'Florida' } }, neutralSite: true, competitors: [{ homeAway: 'home', team: { id: '9' } }] }] },
    { competitions: [{ venue: { address: { city: 'Detroit', state: 'Michigan' } }, competitors: [{ homeAway: 'away', team: { id: '9' } }] }] },
    { competitions: [{ venue: { fullName: 'Target Field', address: { city: 'Minneapolis', state: 'Minnesota' } }, competitors: [{ homeAway: 'home', team: { id: '9' } }] }] },
  ] };
  r[`${SITE}/basketball/wnba/teams?limit=1000`] = list({ id: '8', displayName: 'Minnesota Lynx', abbreviation: 'MIN', color: '236192' });
  r[core('basketball/wnba', 8)] = venue('MN');
  r[`${SITE}/basketball/mens-college-basketball/teams?limit=1000`] = list({ id: '135', displayName: 'Minnesota Golden Gophers', abbreviation: 'MINN', color: '7a0019' }, { id: '2900', displayName: 'St. Thomas Tommies', abbreviation: 'STMN', color: '510c76' });
  r[core('basketball/mens-college-basketball', 135)] = venue('MN');
  r[core('basketball/mens-college-basketball', 2900)] = venue('MN');
  r[`${SITE}/football/college-football/teams?limit=1000`] = list({ id: '135', displayName: 'Minnesota Golden Gophers', abbreviation: 'MINN' }, { id: '2817', displayName: 'Minnesota St Moorhead Dragons', abbreviation: 'MSUM' });
  r[core('football/college-football', 135)] = venue('MN');
  r[core('football/college-football', 2817)] = venue('MN');
  r[`${SITE}/hockey/mens-college-hockey/teams?limit=1000`] = list({ id: '2594', displayName: 'St. Cloud State Huskies', abbreviation: 'SCSU' }, { id: '9001', displayName: 'Augsburg Auggies', abbreviation: 'AUG' });
  r[core('hockey/mens-college-hockey', 2594)] = { ...venue('MN'), groups: { $ref: 'http://sports.core.api.espn.com/v2/x/groups/63?lang=en' } };
  r[core('hockey/mens-college-hockey', 9001)] = { ...venue('MN'), groups: { $ref: 'http://sports.core.api.espn.com/v2/x/groups/70?lang=en' } };
  r['https://sports.core.api.espn.com/v2/x/groups/63?lang=en'] = { name: 'National Collegiate Hockey Conference' };
  r['https://sports.core.api.espn.com/v2/x/groups/70?lang=en'] = { name: 'Minnesota Intercollegiate Athletic Conference' };
  // College baseball has no venues: matched to the schools found above by name.
  r[`${SITE}/baseball/college-baseball/teams?limit=1000`] = list({ id: '90', displayName: 'Minnesota Golden Gophers', abbreviation: 'MINN' }, { id: '850', displayName: 'St. Thomas Tommies', abbreviation: 'STMN' });
  // A school seen nowhere else, whose venue writes the state into the city.
  r[`${SITE}/soccer/usa.ncaa.w.1/teams?limit=1000`] = list({ id: '777', displayName: 'Hamline Pipers', abbreviation: 'HAM' });
  r[core('soccer/usa.ncaa.w.1', 777)] = { venue: { address: { city: 'Saint Paul, Minnesota', country: 'USA' } } };
  return r;
}

test('the team index finds each team\'s state, matches schools without venues by name, and marks Division I', async () => {
  sports._test.reset();
  const calls = [];
  const ix = await sports.ensureTeamIndex({ fetchImpl: fakeFetch(indexRoutes(), calls) });
  assert.ok(ix.teams.length >= 10);
  assert.equal(calls.filter((u) => u.includes('college-baseball/teams/')).length, 0, 'baseball schools were matched by name, not fetched');
  const mn = sports.teamsInState('MN');
  const names = mn.map((t) => `${t.league}:${t.name}`);
  assert.deepEqual(names.slice(0, 3), ['mlb:Minnesota Twins', 'wnba:Minnesota Lynx', 'nhl:Minnesota Wild'], 'pro teams first, in league order (MLB, NBA, WNBA, NFL, NHL...); the Twins found by a home game, not spring training');
  assert.ok(names.includes('cbase:St. Thomas Tommies'));
  assert.ok(names.includes('wsoccer:Hamline Pipers'), 'state read from "Saint Paul, Minnesota"');
  assert.ok(!names.some((n) => n.includes('Bruins')), 'Boston is in Massachusetts');
  const t = (league, name) => mn.find((x) => x.league === league && x.name === name);
  assert.equal(t('cfb', 'Minnesota Golden Gophers').d1, true);
  assert.equal(t('cfb', 'Minnesota St Moorhead Dragons').d1, false, 'not a Division I basketball school');
  assert.equal(t('mchockey', 'St. Cloud State Huskies').d1, true, 'NCHC is a Division I hockey conference');
  assert.equal(t('mchockey', 'Augsburg Auggies').d1, false, 'the MIAC is Division III');
  assert.equal(sports.defaultOn(t('cfb', 'Minnesota St Moorhead Dragons')), false);
  assert.equal(sports.defaultOn(t('nhl', 'Minnesota Wild')), true);
  assert.ok(sports.selectedTeams({ state: 'MN', teams: null }).includes('nhl:30'));
  assert.deepEqual(sports.selectedTeams({ state: 'MN', teams: ['nhl:30', 'bogus:1'] }), ['nhl:30']);
  assert.ok(fs.existsSync(path.join(process.env.DATA_DIR, 'sports', 'teams.json')), 'kept on disk');
});

const comp = (us, them, { state = 'post', completed = state === 'post', detail = 'Final', home = false, broadcasts = [] } = {}) => ({
  status: { type: { state, completed, shortDetail: detail } },
  broadcasts,
  competitors: [
    { homeAway: home ? 'home' : 'away', team: { id: '30', displayName: 'Minnesota Wild', shortDisplayName: 'Wild', abbreviation: 'MIN', color: '124734' }, score: us == null ? undefined : { value: us, displayValue: String(us) }, winner: state === 'post' ? us > them : undefined },
    { homeAway: home ? 'away' : 'home', team: { id: '1', displayName: 'Boston Bruins', shortDisplayName: 'Bruins', abbreviation: 'BOS', color: 'ffb81c' }, score: them == null ? undefined : { value: them, displayValue: String(them) }, winner: state === 'post' ? them > us : undefined },
  ],
});

test('a team card has its last final and, while a game is on, the live score from the game summary', async () => {
  sports._test.cache.clear();
  const now = Date.UTC(2026, 10, 15, 1, 30);
  const tv = (name, market = 'Home') => ({ type: { shortName: 'TV' }, market: { type: market }, media: { shortName: name } });
  const routes = {
    [`${SITE}/hockey/nhl/teams/30/schedule`]: {
      team: { displayName: 'Minnesota Wild', abbreviation: 'MIN', color: '124734' },
      requestedSeason: { year: 2027 },
      events: [
        { id: '1', date: new Date(now - 2 * DAY).toISOString(), competitions: [comp(6, 2)] },
        { id: '2', date: new Date(now - 30 * MIN).toISOString(), competitions: [comp(null, null, { state: 'pre', detail: '7:00 PM', home: true })] }, // the schedule is behind
        { id: '3', date: new Date(now + 2 * DAY).toISOString(), competitions: [comp(null, null, { state: 'pre', home: true, broadcasts: [tv('FOX 9+')] })] },
      ],
    },
    [`${SITE}/hockey/nhl/summary?event=2`]: {
      header: { competitions: [{ date: new Date(now - 30 * MIN).toISOString(), ...comp(2, 1, { state: 'in', detail: '2nd 10:32', home: true }) }] },
      broadcasts: [{ ...tv('ESPN+', 'National'), type: { shortName: 'Streaming' } }, tv('KSTC'), tv('BSN', 'Away')],
    },
  };
  const g = await sports.teamGames('nhl', '30', { fetchImpl: fakeFetch(routes), now });
  assert.equal(g.last.id, '1');
  assert.equal(sports.resultOf(g.last), 'W');
  assert.equal(g.last.home, false);
  assert.equal(g.live.id, '2');
  assert.equal(g.live.us.score, '2');
  assert.equal(g.live.them.score, '1');
  assert.equal(g.live.detail, '2nd 10:32');
  assert.deepEqual(g.live.broadcasts, ['KSTC'], 'TV only, national or our market; the other side\'s network is left out');
  assert.equal(g.next.id, '3');
  // over the air in the Twin Cities
  const ota = sports.DEFAULT_OTA.MN;
  assert.deepEqual(sports.otaFor(g.live.broadcasts, ota), { name: 'KSTC', channel: '45' });
  assert.deepEqual(sports.otaFor(g.next.broadcasts, ota), { name: 'FOX 9+', channel: '29' }, 'FOX 9+ is not FOX');
  assert.equal(sports.otaFor(['ESPN+'], ota), null);
  // the whole card list, as the channel builds it
  const cards = await sports.sportsCards({ state: 'MN', teams: ['nhl:30'], ota }, { fetchImpl: fakeFetch(routes), now });
  assert.equal(cards[0].live.id, '2');
  assert.deepEqual(cards[0].ota, { name: 'KSTC', channel: '45' });
  const svg = sportsPage(cards, { title: 'Minnesota', zone: ZONE, now });
  assert.match(svg, /fill="#e5484d"[^>]*>LIVE</, 'LIVE in red');
  assert.match(svg, /On KSTC · channel 45/);
  assert.match(svg, />2 – 1</);
  assert.match(svg, /2nd 10:32/);
});

test('an off-season team shows its last game from the season before', async () => {
  sports._test.cache.clear();
  const now = Date.UTC(2026, 10, 15, 12);
  const old = Date.UTC(2026, 8, 27, 19, 10);
  const routes = {
    [`${SITE}/baseball/mlb/teams/9/schedule`]: { requestedSeason: { year: 2027 }, events: [{ id: '10', date: new Date(now + 120 * DAY).toISOString(), competitions: [comp(null, null, { state: 'pre' })] }] },
    [`${SITE}/baseball/mlb/teams/9/schedule?season=2026&seasontype=2`]: { events: [{ id: '9', date: new Date(old).toISOString(), competitions: [{ ...comp(3, 5), competitors: comp(3, 5).competitors.map((c, i) => ({ ...c, team: { ...c.team, id: i ? '4' : '9' } })) }] }] },
  };
  const g = await sports.teamGames('mlb', '9', { fetchImpl: fakeFetch(routes), now });
  assert.equal(g.last.id, '9');
  assert.equal(g.last.date, old);
  assert.equal(sports.resultOf(g.last), 'L');
  assert.equal(g.live, null);
  assert.equal(sports.dayLabel(g.last.date, ZONE), 'Sun, Sep 27');
});

test('over-the-air channels are read from NETWORK = channel lines', () => {
  assert.deepEqual(sports.parseOta('FOX = 9\nnbc: 11\n\n KSTC = 45.1 '), { FOX: '9', nbc: '11', KSTC: '45.1' });
  assert.deepEqual(sports.parseOta({ CBS: 4 }), { CBS: '4' });
  assert.throws(() => sports.parseOta('FOX nine'), /NETWORK = channel/);
  assert.deepEqual(sports.otaFor(['Nbc'], { NBC: '11' }), { name: 'Nbc', channel: '11' });
});

test('other sports: the main event, the golf leader, the tennis champion and the race winner', () => {
  const ath = (name, extra = {}) => ({ athlete: { displayName: name }, ...extra });
  const bout = (a, b, { winner = 0, state = 'post' } = {}) => ({ status: { type: { state, completed: state === 'post' } }, competitors: [ath(a, { winner: winner === 1 }), ath(b, { winner: winner === 2 })] });
  const ufc = { name: 'UFC 334: Gane vs. Hokit', status: { type: { state: 'post' } }, competitions: [bout('Evan Elder', 'Samuel Sanches', { winner: 1 }), bout('Ciryl Gane', 'Josh Hokit', { winner: 1 }), bout('Someone Else', 'Another One', { winner: 2 })] };
  assert.deepEqual(sports.summarizeEvent('fight', ufc), { headline: 'Ciryl Gane def. Josh Hokit', detail: 'Main event · Final', live: false });
  const golf = { name: 'Austin Championship', status: { type: { state: 'in' } }, competitions: [{ status: { type: { shortDetail: 'Round 3 - Suspended' } }, competitors: [ath('Chad Ramey', { order: 2, score: '-13' }), ath('Trace Crowe', { order: 1, score: '-14' }), ath('Erik van Rooyen', { order: 3, score: '-13' })] }] };
  assert.deepEqual(sports.summarizeEvent('golf', golf), { headline: 'Trace Crowe leads at -14', detail: 'Round 3 - Suspended · Ramey -13, Rooyen -13', live: true });
  const set = (...v) => v.map((value) => ({ value }));
  const tennis = { name: 'Stockholm Open', status: { type: { state: 'post' } }, groupings: [{ grouping: { displayName: "Men's Singles" }, competitions: [
    { date: '2026-11-13T16:05Z', round: { displayName: 'Semifinal' }, status: { type: { state: 'post', completed: true } }, competitors: [ath('Lorenzo Musetti', { linescores: set(4, 2) }), ath('Taylor Fritz', { winner: true, linescores: set(6, 6) })] },
    { date: '2026-11-14T12:10Z', round: { displayName: 'Final' }, status: { type: { state: 'post', completed: true } }, competitors: [ath('Thiago Tirante', { linescores: set(6, 4, 6) }), ath('Taylor Fritz', { winner: true, linescores: set(2, 6, 7) })] },
  ] }, { grouping: { displayName: "Men's Doubles" }, competitions: [] }] };
  assert.deepEqual(sports.summarizeEvent('tennis', tennis), { headline: 'Champion: Taylor Fritz def. Thiago Tirante', detail: 'Final · 6-2 4-6 6-7', live: false });
  const race = { name: 'NASCAR Cup Series at Miami', status: { type: { state: 'post' } }, competitions: [{ status: { type: { state: 'post', completed: true } }, competitors: [ath('Tyler Reddick', { order: 2 }), ath('Ryan Blaney', { order: 1, winner: true }), ath('William Byron', { order: 3 })] }] };
  assert.deepEqual(sports.summarizeEvent('race', { ...race, competitions: [{ ...race.competitions[0], date: '2026-11-08T20:00Z' }] }),
    { headline: 'Ryan Blaney wins', detail: '2. Tyler Reddick · 3. William Byron', live: false, date: Date.parse('2026-11-08T20:00Z') });
});

test('an event sport whose next event is still to come shows the one before it, and the next', async () => {
  sports._test.cache.clear();
  const now = Date.UTC(2026, 10, 15, 12);
  const routes = {
    [`${SITE}/racing/f1/scoreboard`]: {
      leagues: [{ calendar: [
        { label: 'São Paulo Grand Prix', startDate: '2026-11-06T15:30Z', endDate: '2026-11-08T19:00Z', event: { $ref: 'http://sports.core.api.espn.pvt/v2/sports/racing/leagues/f1/events/600057450?lang=en' } },
        { label: 'Las Vegas Grand Prix', startDate: '2026-11-20T00:30Z', endDate: '2026-11-22T08:00Z', event: { $ref: 'http://x/events/600057451' } },
      ] }],
      events: [{ id: '600057451', name: 'Heineken Las Vegas Grand Prix', date: '2026-11-20T00:30Z', status: { type: { state: 'pre' } }, competitions: [] }],
    },
    [`${SITE}/racing/f1/scoreboard?dates=20261105-20261109`]: {
      events: [{ id: '600057450', name: 'São Paulo Grand Prix', date: '2026-11-06T15:30Z', status: { type: { state: 'post' } }, competitions: [
        { type: { abbreviation: 'FP1' }, date: '2026-11-06T15:30Z', status: { type: { state: 'post', completed: true } }, competitors: [] },
        { type: { abbreviation: 'Race' }, date: '2026-11-08T17:00Z', status: { type: { state: 'post', completed: true } }, competitors: [{ order: 1, winner: true, athlete: { displayName: 'Lando Norris' } }, { order: 2, athlete: { displayName: 'Max Verstappen' } }] },
      ] }],
    },
  };
  const c = await sports.eventSport('f1', { fetchImpl: fakeFetch(routes), now });
  assert.equal(c.title, 'São Paulo Grand Prix');
  assert.equal(c.headline, 'Lando Norris wins');
  assert.equal(sports.dayLabel(c.date, ZONE), 'Sun, Nov 8', 'race day, not the start of the weekend');
  assert.equal(c.next.title, 'Heineken Las Vegas Grand Prix');
  const svg = sportsPage([{ kind: 'event', label: 'F1', color: 'e10600', ...c }], { zone: ZONE, now });
  assert.match(svg, /Next: Heineken Las Vegas Grand Prix · Thu, Nov 19/);
});

test('pages hold eight cards, and one to three live games are pinned to every page', () => {
  const cards = Array.from({ length: 15 }, (_, i) => ({ kind: 'team', key: `k${i}`, live: i < 2 ? {} : null }));
  const pages = sports.paginate(cards);
  assert.equal(pages.length, 3);
  for (const p of pages) assert.deepEqual(p.slice(0, 2).map((c) => c.key), ['k0', 'k1']);
  assert.ok(pages.every((p) => p.length <= 8));
  assert.equal(new Set(pages.flat().map((c) => c.key)).size, 15, 'every card is shown');
  assert.deepEqual(sports.paginate([]), [[]]);
  assert.equal(sports.paginate(cards.slice(0, 5)).length, 1, 'no pinning when everything fits on one page');
});

test('long names are cut with an ellipsis to fit', () => {
  assert.equal(fit('Minnesota Wild', 1000, 30), 'Minnesota Wild');
  const cut = fit('Minnesota State University Moorhead Dragons Women\'s Soccer', 300, 30);
  assert.ok(cut.endsWith('…') && cut.length < 30, cut);
});

test('sports settings: a state is required, picking one brings its over-the-air channels, teams and sports are checked', async () => {
  await assert.rejects(utilityConfig('sports', {}), /Pick a state/);
  await assert.rejects(utilityConfig('sports', { state: 'XX' }), /Pick a state/);
  const cfg = await utilityConfig('sports', { state: 'mn' });
  assert.equal(cfg.state, 'MN');
  assert.equal(cfg.teams, null, 'the state\'s default teams');
  assert.equal(cfg.ota.FOX, '9');
  const more = await utilityConfig('sports', { teams: ['nhl:30', 'nhl:30', 'x'], extras: { ufc: true, golf: true, f1: 'true' }, ota: 'NBC = 11' }, cfg);
  assert.deepEqual(more.teams, ['nhl:30']);
  assert.deepEqual(more.extras, { ufc: true, f1: true }, 'unknown sports are dropped');
  assert.deepEqual(more.ota, { NBC: '11' });
  const moved = await utilityConfig('sports', { state: 'WI' }, more);
  assert.equal(moved.teams, null, 'a new state starts from its own teams');
  assert.deepEqual(moved.ota, {}, 'no channels known for Wisconsin');
  await assert.rejects(utilityConfig('sports', { ota: 'FOX nine' }, cfg), /NETWORK = channel/);
  const text = utilityText(more);
  assert.equal(text.title, 'Scoreboard');
  assert.equal(text.subtitle, 'Minnesota');
  assert.match(text.description, /plus UFC, F1/);
});

test('the playout turns the score pages and carries a song on from where the last part stopped', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const { ChannelRunner } = await import('../src/playout.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-pages-'));
  const ff = (...a) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...a]);
  ff('-f', 'lavfi', '-i', 'color=red:size=320x180', '-frames:v', '1', '-pix_fmt', 'bgr24', path.join(dir, 'p1.bmp'));
  ff('-f', 'lavfi', '-i', 'color=blue:size=640x180', '-frames:v', '1', '-pix_fmt', 'bgr24', path.join(dir, 'pages.bmp'));
  ff('-f', 'lavfi', '-i', 'sine=frequency=440:duration=10', path.join(dir, 'song.m4a'));
  const r = Object.create(ChannelRunner.prototype);
  r.capsBurst = false;
  const frame = { png: path.join(dir, 'p1.bmp'), width: 320, height: 180, pages: { file: path.join(dir, 'pages.bmp'), count: 2, seconds: 1 } };
  const args = r.utilityArgs(frame, path.join(dir, 'song.m4a'), 3, 4, 6);
  const ss = args.indexOf('-ss');
  assert.ok(ss > 0 && args[ss + 1] === '6.00' && args[ss + 3] === path.join(dir, 'song.m4a'), 'the song starts 6s in');
  assert.match(args[args.indexOf('-filter_complex') + 1], /crop=w=320:h=180:x='320\*mod\(floor\(\(t\+[\d.]+\)\/1\)\\,2\)'/);
  assert.ok(!args.includes('stillimage'), 'the picture changes, so no still-image tuning');
  const out = path.join(dir, 'out.ts');
  execFileSync('ffmpeg', [...args.filter((a, i) => !(a === '-readrate' || args[i - 1] === '-readrate')), out]);
  const dur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out]).toString());
  assert.ok(Math.abs(dur - 3) < 0.3, `3 seconds made (${dur})`);
});
