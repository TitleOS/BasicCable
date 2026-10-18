// StreamTube's MCP server: lets an assistant (Claude Code, Claude Desktop...) manage channels, schedules,
// stream addons and settings from plain-language requests. Served over Streamable HTTP at /mcp.

import fs from 'node:fs';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import * as z from 'zod/v4';
import { store } from './db.js';
import { config, log } from './config.js';
import { ops } from './api.js';
import { search, getMeta, expandWildcard } from './metadata.js';
import { itemLabel, replaceItem } from './scheduler.js';
import { runnerStatus, ffmpegCaps, interruptRunner, publishedEdge } from './playout.js';
import { addonBase } from './picker.js';
import { repairGuide } from './repair.js';
import { parseDays, parseClock, parseDuration, minutesBetween, parseTitleSpec, normTitle, parseResolution } from './nl.js';

const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const CHARACTER_LIMIT = 25000;

const INSTRUCTIONS = `StreamTube runs virtual live TV channels for Stremio. Each channel has an auto-fill pool (shows, movies and
wildcards like "Star Trek*") that plays whenever no weekly time slot is active, plus optional time slots
("weeknights 8pm, 1 hour: Modern Family"). Streams come from the user's debrid-enabled Stremio addons.

- Refer to channels by number or name ("4", "Adult Swim"). Refer to shows and movies by name; add "movie:" or
  "show:" or a year ("Heat (1995)") to disambiguate, an IMDb id (tt...) to be exact, or * and ? for wildcards.
- Times are in the server's timezone (see streamtube_server_status). Days accept "weekdays", "weekends", "daily",
  "mon-fri", "mon, wed, fri"... Start times accept "8pm", "20:00"...
- Tools that change things report what each title matched; tell the user, especially when a match looks off.
- Confirm with the user before deleting channels, replacing slots, importing a backup with replace, or removing
  stream addons.`;

// ---------------------------------------------------------------------------
// helpers

const tz = () => store.getSettings().timezone || config.timezone;
const fmtTime = (ms) => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz() });
const fmtDay = (ms) => new Date(ms).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: tz() });
const mmss = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

function text(t) {
  return { content: [{ type: 'text', text: t.length > CHARACTER_LIMIT ? `${t.slice(0, CHARACTER_LIMIT)}\n\n…(cut short; ask for less, e.g. fewer hours or one channel)` : t }] };
}
function jsonResult(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], structuredContent: data };
}

/** Channel by number, id or (partial) name. */
function resolveChannel(ref) {
  const all = store.listChannels();
  const raw = String(ref).trim().replace(/^(channel|ch)\s*/i, '');
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    const byNumber = all.filter((c) => c.number === n);
    if (byNumber.length === 1) return byNumber[0];
    const byId = all.find((c) => c.id === n);
    if (byId) return byId;
  }
  const q = normTitle(raw);
  const exact = all.filter((c) => normTitle(c.name) === q);
  if (exact.length === 1) return exact[0];
  const partial = all.filter((c) => normTitle(c.name).includes(q));
  if (partial.length === 1) return partial[0];
  const list = all.map((c) => `${c.number} ${c.name}`).join(', ') || 'none yet';
  throw new Error(`${partial.length > 1 ? 'More than one channel matches' : 'No channel matches'} "${ref}". Channels: ${list}.`);
}

const yearOf = (m) => Number(String(m.releaseInfo || '').match(/\d{4}/)?.[0]) || null;

/**
 * Turn a title as written into a pool/slot content spec. Returns { spec, note, alternatives }.
 * Throws a readable error when nothing matches.
 */
async function resolveTitle(input, { defaultTypes = null } = {}) {
  const t = parseTitleSpec(input);
  if (!t.query) throw new Error('Empty title');
  if (t.wildcard) {
    const types = t.types || defaultTypes || ['series'];
    const matches = await expandWildcard(t.query, types);
    if (!matches.length) throw new Error(`The wildcard "${t.query}" matches nothing (${types.join(' & ')}). Try a broader pattern or streamtube_preview_wildcard.`);
    return {
      spec: { kind: 'wildcard', ref: t.query, name: t.query, options: { types } },
      note: `wildcard "${t.query}" → ${matches.length} ${types.join('/')} titles: ${matches.slice(0, 12).map((m) => m.name).join(', ')}${matches.length > 12 ? '…' : ''}`,
      alternatives: [],
    };
  }
  if (t.imdb) {
    for (const type of t.types || ['series', 'movie']) {
      try {
        const m = await getMeta(type, t.imdb);
        return { spec: { kind: type, ref: t.imdb, name: m.name, poster: m.poster }, note: `${m.name} (${type}, ${t.imdb})`, alternatives: [] };
      } catch { /* try the other type */ }
    }
    throw new Error(`No show or movie with IMDb id ${t.imdb}.`);
  }
  const types = t.types || defaultTypes || ['series', 'movie'];
  const results = await search(t.query, types);
  if (!results.length) throw new Error(`Nothing found for "${input}". Check the spelling, add a year, or use streamtube_search_titles.`);
  const q = normTitle(t.query);
  const qWords = q.split(' ').filter((w) => w.length > 1);
  const scored = results.map((m, i) => {
    const n = normTitle(m.name);
    const y = yearOf(m);
    let s = n === q ? 10 : n.startsWith(q) || q.startsWith(n) ? 4 : n.includes(q) ? 2 : 0;
    if (!s && qWords.length) {
      // Most of the words line up ("office us" ~ "the office (us)").
      const nWords = new Set(n.split(' '));
      if (qWords.filter((w) => nWords.has(w)).length / qWords.length >= 0.6) s = 2;
    }
    if (t.year && y === t.year) s += 6;
    else if (t.year && y && Math.abs(y - t.year) > 1) s -= 3;
    if (!t.types && types.length > 1 && m.type === 'series') s += 0.5;
    return { m, s: s - i * 0.01 };
  }).sort((a, b) => b.s - a.s);
  const describe = (m) => `${m.name} (${m.type === 'series' ? 'show' : 'movie'}${yearOf(m) ? `, ${m.releaseInfo}` : ''}, ${m.id})`;
  // Cinemeta's search is fuzzy and always returns something; don't add a title that merely shares a word.
  if (scored[0].s < 1.5) {
    throw new Error(`No close match for "${input}". Did you mean: ${scored.slice(0, 3).map((x) => describe(x.m)).join('; ')}? ` +
      'Retry with the exact name or IMDb id.');
  }
  const best = scored[0].m;
  return {
    spec: { kind: best.type, ref: best.id, name: best.name, poster: best.poster },
    note: describe(best),
    alternatives: scored.slice(1, 4).map((x) => describe(x.m)),
  };
}

const isPoolWord = (s) => /^(the\s+)?(auto[- ]?fill\s+)?pool$|^auto[- ]?fill$/i.test(String(s).trim());

/** A slot as described ("weekdays", "8pm", end "9pm" or "60"/"1h", content) -> slotInput body + a description. */
async function buildSlot(slot) {
  const days = parseDays(slot.days);
  const start = parseClock(slot.start);
  let minutes;
  if (slot.end != null && slot.end !== '') minutes = minutesBetween(start, parseClock(slot.end));
  else if (slot.length != null && slot.length !== '') minutes = parseDuration(slot.length);
  else throw new Error(`Slot at ${slot.start}: give an end time ("9pm") or a length ("60", "1h30m").`);
  let content;
  let note;
  if (isPoolWord(slot.content)) {
    content = { kind: 'pool' };
    note = "the channel's auto-fill pool";
  } else {
    const r = await resolveTitle(slot.content);
    content = r.spec;
    note = r.note;
  }
  return { body: { days, start, minutes, content, play_order: slot.order === 'random' ? 'random' : 'sequential' }, note };
}

function daysLabel(days) {
  const d = String(days).split(',').map(Number).sort().join(',');
  if (d === '1,2,3,4,5,6,7') return 'Daily';
  if (d === '1,2,3,4,5') return 'Weekdays';
  if (d === '6,7') return 'Weekends';
  return d.split(',').map((n) => ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][n]).join(', ');
}

function slotLabel(s) {
  const [h, m] = s.start.split(':').map(Number);
  const endMin = h * 60 + m + s.minutes;
  const clock = (mins) => { const hh = Math.floor(mins / 60) % 24; const mm = mins % 60; return `${hh % 12 || 12}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'AM' : 'PM'}`; };
  const what = s.content.kind === 'pool' ? 'auto-fill pool' : `${s.content.name}${s.content.kind === 'wildcard' ? ' (wildcard)' : ''}`;
  const order = s.content.kind === 'movie' ? '' : s.play_order === 'random' ? ', random order' : ', in order';
  return `slot ${s.id}: ${daysLabel(s.days)} ${clock(h * 60 + m)}–${clock(endMin)} → ${what}${order}`;
}

function sourceLabel(s) {
  if (s.kind !== 'wildcard') return `${s.name} (${s.kind === 'series' ? 'show' : 'movie'}, ${s.ref})`;
  const resolved = s.options.resolved || [];
  const excluded = new Set(s.options.excluded || []);
  const active = resolved.filter((r) => !excluded.has(r.id));
  return `${s.name} (wildcard, ${active.length} of ${resolved.length} titles${excluded.size ? `; excluded: ${resolved.filter((r) => excluded.has(r.id)).map((r) => r.name).join(', ')}` : ''})`;
}

function nowNext(c, now = Date.now()) {
  const cur = store.epgAt(c.id, now);
  const next = cur ? store.epgAfter(c.id, cur.start) : store.epgAfter(c.id, now);
  return { cur, next };
}

function channelConfigLine(c) {
  const o = c.options || {};
  return [`${c.resolution}p (fallback ${c.fallback})`, { shuffle: 'shuffle shows', sequential: 'rotate shows in order', random: 'random episodes' }[c.fill_mode],
    `round to ${c.round_minutes || 0} min`, `subtitles ${o.subtitles || 'auto'}`, `audio ${o.audio || 'aac'}/${o.audioLanguage || 'eng'}`,
    o.excludeKeywords?.length ? `skip: ${o.excludeKeywords.join(', ')}` : null, o.avoidDolbyVision === false ? 'allows Dolby Vision' : null,
    o.includeSpecials ? 'includes specials' : null, c.enabled ? null : 'DISABLED'].filter(Boolean).join(' · ');
}

function channelSummary(c, now = Date.now()) {
  const { cur, next } = nowNext(c, now);
  const sources = store.listSources(c.id);
  const slots = store.listSlots(c.id);
  return [
    `### ${c.number} · ${c.name}`,
    channelConfigLine(c),
    cur ? `Now: ${itemLabel(cur)} (${mmss(now - cur.start)} in, until ${fmtTime(cur.end)})` : 'Now: nothing scheduled',
    next ? `Next ${fmtTime(next.start)}: ${itemLabel(next)}` : null,
    `Pool: ${sources.length ? sources.map(sourceLabel).join('; ') : 'empty'}`,
    slots.length ? `Slots:\n${slots.map((s) => `- ${slotLabel(s)}`).join('\n')}` : 'Slots: none (pool all day)',
  ].filter(Boolean).join('\n');
}

function guideLines(c, from, to) {
  const rows = store.epgRange(c.id, from, to);
  if (!rows.length) return '(nothing scheduled)';
  let day = '';
  const out = [];
  for (const r of rows) {
    const d = fmtDay(r.start);
    if (d !== day) { out.push(`**${d}**`); day = d; }
    out.push(`- ${fmtTime(r.start)}–${fmtTime(r.end)} ${itemLabel(r)}${r.origin === 'slot' ? ' [slot]' : ''}${r.truncated ? ' [cut short]' : ''}`);
  }
  return out.join('\n');
}

function maskAddon(url) {
  try {
    const u = new URL(addonBase(url));
    return `${u.origin}/•••/manifest.json`;
  } catch {
    return '(unreadable URL)';
  }
}

// Channel settings shared by create/update/bulk tools, in plain names.
const channelFields = {
  logo: z.string().optional().describe('Logo image URL ("" removes it)'),
  resolution: z.union([z.number(), z.string()]).optional().describe('Target resolution: 2160 (or "4k"), 1440, 1080, 720, 576, 480'),
  fallback: z.enum(['lower', 'higher']).optional().describe('If the target resolution is missing, try the next lower (default) or next higher first'),
  fill_mode: z.enum(['shuffle', 'sequential', 'random']).optional()
    .describe('Auto-fill order: shuffle = shuffle shows, episodes in order; sequential = rotate shows in order; random = random episodes'),
  round_minutes: z.number().int().min(0).max(60).optional().describe('Round runtimes up to this many minutes (padding; default 5)'),
  enabled: z.boolean().optional().describe('Disabled channels are hidden from Stremio and not prefetched'),
  subtitles: z.enum(['auto', 'soft', 'off']).optional()
    .describe('English subtitles: auto = selectable track, or burned in for image subs (re-encodes); soft = selectable only; off'),
  audio: z.enum(['aac', 'copy']).optional().describe('aac = convert to stereo AAC (most compatible); copy = pass original audio through'),
  audio_language: z.string().min(2).max(3).optional().describe('Preferred audio language, ISO 639-2 like eng, spa, jpn'),
  exclude_keywords: z.array(z.string()).optional().describe('Skip releases whose name contains any of these, e.g. ["HEVC","REMUX"]; [] clears'),
  avoid_dolby_vision: z.boolean().optional().describe('Rank Dolby Vision-only releases last (default true)'),
  include_specials: z.boolean().optional().describe('Include season 0 specials'),
};

const OPTION_KEYS = { subtitles: 'subtitles', audio: 'audio', audio_language: 'audioLanguage', exclude_keywords: 'excludeKeywords', avoid_dolby_vision: 'avoidDolbyVision', include_specials: 'includeSpecials' };

/** Plain tool arguments -> the REST-style body ops.* expect. Options merge over the channel's current ones. */
function channelBody(args, current = null) {
  const body = {};
  for (const k of ['name', 'number', 'logo', 'fallback', 'fill_mode', 'round_minutes', 'enabled']) if (args[k] !== undefined) body[k] = args[k];
  if (args.resolution !== undefined) body.resolution = typeof args.resolution === 'number' ? args.resolution : parseResolution(args.resolution);
  const opts = {};
  for (const [k, v] of Object.entries(OPTION_KEYS)) if (args[k] !== undefined) opts[v] = args[k];
  if (Object.keys(opts).length || !current) body.options = { ...(current?.options || {}), ...opts };
  return body;
}

const slotSchema = z.object({
  days: z.union([z.string(), z.array(z.union([z.string(), z.number()]))]).describe('e.g. "weekdays", "weekends", "daily", "mon-fri", "mon, wed, fri", ["sat","sun"]'),
  start: z.string().describe('Start time, e.g. "8pm", "20:00", "8:30 PM"'),
  end: z.string().optional().describe('End time, e.g. "9pm" (may pass midnight). Give end or length.'),
  length: z.union([z.number(), z.string()]).optional().describe('Length instead of end: minutes (60) or "1h30m"'),
  content: z.string().describe('What plays: a show or movie name ("Modern Family", "movie: Heat (1995)"), a wildcard ("Batman*"), or "pool" for the auto-fill pool'),
  order: z.enum(['in_order', 'random']).optional().describe('Episodes in order (default) or random'),
});

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const RO_NET = { ...RO, openWorldHint: true };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };

// ---------------------------------------------------------------------------
// tools

function registerTools(server) {
  // ---- reading

  server.registerTool('streamtube_list_channels', {
    title: 'List channels',
    description: 'List every channel with its settings, what is on now and next, its auto-fill pool and time slots. Start here to see what exists.',
    inputSchema: z.object({ response_format: z.enum(['markdown', 'json']).default('markdown') }),
    annotations: RO,
  }, async ({ response_format }) => {
    const channels = store.listChannels();
    if (response_format === 'json') return jsonResult({ timezone: tz(), channels: channels.map((c) => ({ ...ops.channelDetail(c), now: nowNext(c).cur, next: nowNext(c).next })) });
    if (!channels.length) return text('No channels yet. Create one with streamtube_create_channel.');
    return text(`${channels.length} channels (times in ${tz()}):\n\n${channels.map((c) => channelSummary(c)).join('\n\n')}`);
  });

  server.registerTool('streamtube_get_channel', {
    title: 'Get channel',
    description: 'One channel in detail: settings, pool, slots (with slot ids) and its upcoming guide.',
    inputSchema: z.object({
      channel: z.union([z.string(), z.number()]).describe('Channel number or name'),
      guide_hours: z.number().min(0).max(48).default(6).describe('Hours of upcoming guide to include'),
    }),
    annotations: RO,
  }, async ({ channel, guide_hours }) => {
    const c = resolveChannel(channel);
    const now = Date.now();
    return text(`${channelSummary(c, now)}\n\n**Guide, next ${guide_hours}h** (${tz()})\n${guideLines(c, now, now + guide_hours * 3600e3)}`);
  });

  server.registerTool('streamtube_get_guide', {
    title: 'Get guide',
    description: 'The program guide for one channel or all channels over the next few hours. Use streamtube_whats_on for just now/next.',
    inputSchema: z.object({
      channel: z.union([z.string(), z.number()]).optional().describe('Channel number or name; omit for all channels'),
      hours: z.number().min(0.5).max(48).default(4).describe('How many hours ahead'),
      offset_hours: z.number().min(-24).max(48).default(0).describe('Start this many hours from now (negative looks back)'),
    }),
    annotations: RO,
  }, async ({ channel, hours, offset_hours }) => {
    const from = Date.now() + offset_hours * 3600e3;
    const to = from + hours * 3600e3;
    const list = channel != null ? [resolveChannel(channel)] : store.listChannels().filter((c) => c.enabled);
    return text(list.map((c) => `### ${c.number} · ${c.name}\n${guideLines(c, from, to)}`).join('\n\n') + `\n\n(times in ${tz()})`);
  });

  server.registerTool('streamtube_whats_on', {
    title: "What's on",
    description: 'What is playing right now and next on every enabled channel, and which channels are being watched (and by which device IPs).',
    inputSchema: z.object({}),
    annotations: RO,
  }, async () => {
    const now = Date.now();
    const live = new Map(runnerStatus().map((r) => [r.channelId, r]));
    const lines = store.listChannels().filter((c) => c.enabled).map((c) => {
      const { cur, next } = nowNext(c, now);
      const r = live.get(c.id);
      const watching = r ? ` 🔴 streaming to ${r.viewers?.join(', ') || 'a viewer'}${r.stream?.height ? ` at ${r.stream.height}p` : ''}${r.state !== 'playing' ? ` (${r.state}${r.message ? `: ${r.message}` : ''})` : ''}` : '';
      return `- **${c.number} ${c.name}**: ${cur ? `${itemLabel(cur)} (${mmss(now - cur.start)} in, ends ${fmtTime(cur.end)})` : 'nothing on'}` +
        `${next ? ` → next ${fmtTime(next.start)} ${itemLabel(next)}` : ''}${watching}`;
    });
    return text(`${fmtDay(now)} ${fmtTime(now)} (${tz()})\n${lines.join('\n') || 'No enabled channels.'}`);
  });

  server.registerTool('streamtube_search_titles', {
    title: 'Search titles',
    description: 'Search shows and movies (Cinemeta, the same catalog Stremio uses). Use it to check a name or find the exact title/IMDb id before adding it.',
    inputSchema: z.object({
      query: z.string().min(1).describe('Name to search for'),
      type: z.enum(['any', 'series', 'movie']).default('any'),
      limit: z.number().int().min(1).max(40).default(10),
    }),
    annotations: RO_NET,
  }, async ({ query, type, limit }) => {
    const res = (await search(query, type === 'any' ? ['series', 'movie'] : [type])).slice(0, limit);
    if (!res.length) return text(`Nothing found for "${query}".`);
    return text(res.map((m) => `- ${m.name} — ${m.type === 'series' ? 'show' : 'movie'}${m.releaseInfo ? `, ${m.releaseInfo}` : ''} (${m.id})`).join('\n'));
  });

  server.registerTool('streamtube_preview_wildcard', {
    title: 'Preview wildcard',
    description: 'Show which titles a wildcard such as "Star Trek*" or "*Batman*" would add, before adding it.',
    inputSchema: z.object({
      pattern: z.string().min(1).describe('Glob pattern: * matches anything, ? one character'),
      types: z.enum(['series', 'movie', 'both']).default('series'),
    }),
    annotations: RO_NET,
  }, async ({ pattern, types }) => {
    const res = await expandWildcard(pattern, types === 'both' ? ['series', 'movie'] : [types]);
    return text(res.length ? `${res.length} matches for "${pattern}":\n${res.map((m) => `- ${m.name}${m.releaseInfo ? ` (${m.releaseInfo})` : ''} ${m.id}`).join('\n')}` : `No matches for "${pattern}".`);
  });

  server.registerTool('streamtube_check_streams', {
    title: 'Check streams',
    description: 'Which debrid releases are available for what is on now (or next) on a channel, ranked the way StreamTube would pick them. Useful when something looks wrong (low quality, not playing).',
    inputSchema: z.object({
      channel: z.union([z.string(), z.number()]).describe('Channel number or name'),
      which: z.enum(['now', 'next']).default('now'),
    }),
    annotations: RO_NET,
  }, async ({ channel, which }) => {
    const c = resolveChannel(channel);
    const { cur, next } = nowNext(c);
    const item = which === 'next' ? next : cur;
    if (!item) return text(`Nothing ${which === 'next' ? 'up next' : 'on now'} on ${c.name}.`);
    const r = await ops.channelStreams(c, item);
    if (r.error) return text(`${itemLabel(item)}: ${r.error}`);
    if (!r.candidates.length) return text(`${itemLabel(item)}: no cached, playable debrid release found. It will be skipped for another episode.`);
    return text(`${itemLabel(item)} — target ${r.target}p, then ${r.fallback} first:\n` +
      r.candidates.slice(0, 12).map((x, i) => `${i === 0 ? '▶' : `${i + 1}.`} ${x.resolution || '?'}p${x.preferred ? ' [preferred]' : ''}${x.cached ? ' [cached]' : ''} ${x.label.slice(0, 140)}`).join('\n'));
  });

  server.registerTool('streamtube_server_status', {
    title: 'Server status',
    description: 'StreamTube version, timezone, ffmpeg, install URLs (Stremio manifest, M3U, XMLTV) and which channels are streaming now.',
    inputSchema: z.object({}),
    annotations: RO,
  }, async () => {
    const s = store.getSettings();
    const caps = await ffmpegCaps();
    const base = (s.publicUrl || config.baseUrl || `http://<this-server>:${config.port}`).replace(/\/+$/, '');
    const live = runnerStatus();
    return text([
      `StreamTube ${VERSION} · timezone ${tz()} · ffmpeg ${caps.ok ? caps.version : `missing (${caps.error})`}${caps.ok && !caps.subtitles ? ' (subtitles off: needs ffmpeg 7.x)' : ''}`,
      `Channels: ${store.listChannels().length} (${store.listChannels().filter((c) => c.enabled).length} enabled) · stream addons: ${(s.streamAddons || []).length}`,
      `Stremio manifest: ${base}/manifest.json · M3U: ${base}/playlist.m3u · XMLTV: ${base}/epg.xml`,
      live.length ? `Streaming now:\n${live.map((r) => `- channel ${store.getChannel(r.channelId)?.number ?? r.channelId}: ${r.state}${r.item ? ` ${r.item.label}` : ''}${r.stream?.height ? ` @ ${r.stream.height}p` : ''} → ${r.viewers?.join(', ') || 'no active viewer'}`).join('\n')}` : 'Nothing is streaming right now.',
    ].join('\n'));
  });

  server.registerTool('streamtube_get_settings', {
    title: 'Get settings',
    description: 'Server settings: stream addons (debrid keys hidden unless reveal_addon_urls is true), metadata addon, timezone, preferred release words, prefetch lead time, per-device stream cap, default resolution.',
    inputSchema: z.object({ reveal_addon_urls: z.boolean().default(false).describe('Show full addon URLs, including the debrid key inside them') }),
    annotations: RO,
  }, async ({ reveal_addon_urls }) => {
    const s = store.getSettings();
    const addons = (s.streamAddons || []).map((u, i) => `${i + 1}. ${reveal_addon_urls ? u : maskAddon(u)}`);
    return text([
      `Stream addons:\n${addons.join('\n') || '(none — add one with streamtube_add_stream_addon)'}`,
      `Metadata addon: ${s.metaAddon}`,
      `Timezone: ${s.timezone}`,
      `Preferred release words: ${(s.preferKeywords || []).join(', ') || '(none)'}`,
      `Prepare streams ahead: ${s.prefetchMinutes} min${s.prefetchMinutes ? '' : ' (off)'}`,
      `One stream per viewer IP: ${s.oneStreamPerIp ? 'on' : 'off'}`,
      `Default resolution for new channels: ${s.defaultResolution}p`,
      `Public URL: ${s.publicUrl || '(from request)'}`,
    ].join('\n'));
  });

  // ---- channels

  server.registerTool('streamtube_create_channel', {
    title: 'Create channel',
    description: 'Create a channel in one go: name and settings, the shows/movies/wildcards for its auto-fill pool, and optional weekly time slots. ' +
      'Example: name "Sitcoms", pool ["The Office", "Parks and Recreation", "Brooklyn Nine-Nine"], slots [{days:"weekdays", start:"8pm", end:"9pm", content:"Modern Family"}]. ' +
      'Returns what every title matched; titles that matched nothing are listed so you can retry them.',
    inputSchema: z.object({
      name: z.string().min(1).max(80),
      number: z.number().int().min(1).max(9999).optional().describe('Channel number (next free one if omitted)'),
      ...channelFields,
      pool: z.array(z.string()).default([]).describe('Shows, movies or wildcards for the auto-fill pool, e.g. ["The Office", "movie: Heat (1995)", "Star Trek*"]'),
      slots: z.array(slotSchema).default([]).describe('Weekly time slots'),
    }),
    annotations: WRITE,
  }, async (args) => {
    const resolvedPool = [];
    const problems = [];
    for (const title of args.pool) {
      try { resolvedPool.push({ title, ...(await resolveTitle(title)) }); } catch (e) { problems.push(`pool "${title}": ${e.message}`); }
    }
    const builtSlots = [];
    for (const s of args.slots) {
      try { builtSlots.push(await buildSlot(s)); } catch (e) { problems.push(`slot ${s.days} ${s.start}: ${e.message}`); }
    }
    const c = await ops.createChannel(channelBody(args));
    const added = [];
    for (const r of resolvedPool) {
      try { await ops.addSource(c, r.spec, { rebuildGuide: false }); added.push(`+ ${r.title} → ${r.note}${r.alternatives.length ? ` (other matches: ${r.alternatives.join('; ')})` : ''}`); } catch (e) { problems.push(`pool "${r.title}": ${e.message}`); }
    }
    for (const b of builtSlots) {
      try { const slot = await ops.addSlot(c, b.body, { rebuildGuide: false }); added.push(`+ ${slotLabel(slot)} (${b.note})`); } catch (e) { problems.push(`slot: ${e.message}`); }
    }
    await ops.rebuild(c.id);
    const fresh = store.getChannel(c.id);
    return text(`Created channel ${fresh.number} · ${fresh.name}.\n${added.join('\n') || '(empty pool, no slots)'}` +
      `${problems.length ? `\n\nNot added:\n${problems.map((p) => `- ${p}`).join('\n')}` : ''}\n\n${channelSummary(fresh)}`);
  });

  server.registerTool('streamtube_update_channel', {
    title: 'Update channel',
    description: 'Change one channel\'s name, number or settings (resolution, fill order, subtitles, audio, skip words...). Only the fields you pass change. For the pool or slots use the pool/slot tools.',
    inputSchema: z.object({
      channel: z.union([z.string(), z.number()]).describe('Channel number or name'),
      name: z.string().min(1).max(80).optional(),
      number: z.number().int().min(1).max(9999).optional(),
      ...channelFields,
    }),
    annotations: { ...WRITE, idempotentHint: true },
  }, async (args) => {
    const cur = resolveChannel(args.channel);
    const { channel: _ignored, ...fields } = args;
    if (!Object.values(fields).some((v) => v !== undefined)) throw new Error('Nothing to change: pass at least one field.');
    const c = await ops.updateChannel(cur, channelBody(fields, cur));
    return text(`Updated.\n\n${channelSummary(c)}`);
  });

  server.registerTool('streamtube_bulk_update_channels', {
    title: 'Bulk update channels',
    description: 'Apply the same settings to many channels at once, e.g. "set every channel to 720p" or "turn subtitles off on channels 3, 5 and Kids". Pass channels: "all", or a list of numbers/names.',
    inputSchema: z.object({
      channels: z.union([z.literal('all'), z.array(z.union([z.string(), z.number()]))]).describe('"all" or a list of channel numbers/names'),
      ...channelFields,
    }),
    annotations: { ...WRITE, idempotentHint: true },
  }, async (args) => {
    const { channels, ...fields } = args;
    if (!Object.values(fields).some((v) => v !== undefined)) throw new Error('Nothing to change: pass at least one setting.');
    const targets = channels === 'all' ? store.listChannels() : channels.map(resolveChannel);
    const done = [];
    for (const cur of targets) {
      const c = await ops.updateChannel(cur, channelBody(fields, cur));
      done.push(`- ${c.number} ${c.name}: ${channelConfigLine(c)}`);
    }
    return text(`Updated ${done.length} channels:\n${done.join('\n')}`);
  });

  server.registerTool('streamtube_delete_channel', {
    title: 'Delete channel',
    description: 'Delete a channel with its pool, slots and guide. Cannot be undone (an export_backup first keeps a copy). Confirm with the user first.',
    inputSchema: z.object({ channel: z.union([z.string(), z.number()]).describe('Channel number or name') }),
    annotations: DESTRUCTIVE,
  }, async ({ channel }) => {
    const c = resolveChannel(channel);
    ops.deleteChannel(c);
    return text(`Deleted channel ${c.number} · ${c.name}.`);
  });

  // ---- pool

  server.registerTool('streamtube_add_to_pool', {
    title: 'Add to pool',
    description: 'Add shows, movies or wildcards to a channel\'s auto-fill pool, e.g. ["Bob\'s Burgers", "movies: Batman*", "tt0386676"]. Returns what each matched.',
    inputSchema: z.object({
      channel: z.union([z.string(), z.number()]),
      titles: z.array(z.string()).min(1).describe('Names ("The Office"), "movie:"/"show:" prefixes, years ("Heat (1995)"), IMDb ids, or wildcards ("Star Trek*")'),
    }),
    annotations: WRITE,
  }, async ({ channel, titles }) => {
    const c = resolveChannel(channel);
    const lines = [];
    let changed = false;
    for (const title of titles) {
      try {
        const r = await resolveTitle(title);
        await ops.addSource(c, r.spec, { rebuildGuide: false });
        changed = true;
        lines.push(`+ ${title} → ${r.note}${r.alternatives.length ? ` (other matches: ${r.alternatives.join('; ')})` : ''}`);
      } catch (e) {
        lines.push(`✗ ${title}: ${e.message}`);
      }
    }
    if (changed) await ops.rebuild(c.id);
    return text(`${c.number} ${c.name}:\n${lines.join('\n')}`);
  });

  server.registerTool('streamtube_remove_from_pool', {
    title: 'Remove from pool',
    description: 'Remove shows, movies or wildcards from a channel\'s auto-fill pool, by name, IMDb id or wildcard pattern. To drop single titles from a wildcard, use streamtube_set_wildcard_exclusions instead.',
    inputSchema: z.object({
      channel: z.union([z.string(), z.number()]),
      titles: z.array(z.string()).min(1),
    }),
    annotations: { ...DESTRUCTIVE, openWorldHint: false },
  }, async ({ channel, titles }) => {
    const c = resolveChannel(channel);
    const sources = store.listSources(c.id);
    const lines = [];
    let changed = false;
    for (const title of titles) {
      const q = normTitle(title);
      const matches = sources.filter((s) => s.ref.toLowerCase() === title.toLowerCase().trim() || normTitle(s.name) === q);
      const hit = matches.length ? matches : sources.filter((s) => normTitle(s.name).includes(q));
      if (hit.length !== 1) {
        lines.push(`✗ ${title}: ${hit.length ? `matches several (${hit.map((s) => s.name).join(', ')}); be more specific` : `not in the pool (${sources.map((s) => s.name).join(', ') || 'empty'})`}`);
        continue;
      }
      await ops.deleteSource(c, hit[0].id, { rebuildGuide: false });
      changed = true;
      lines.push(`- removed ${sourceLabel(hit[0])}`);
    }
    if (changed) await ops.rebuild(c.id);
    return text(`${c.number} ${c.name}:\n${lines.join('\n')}`);
  });

  server.registerTool('streamtube_set_wildcard_exclusions', {
    title: 'Set wildcard exclusions',
    description: 'Untick (exclude) or re-tick (include) individual titles that a wildcard in a channel\'s pool matched, e.g. exclude "Star Trek Continues" from "Star Trek*". Can also re-scan the wildcard for new titles.',
    inputSchema: z.object({
      channel: z.union([z.string(), z.number()]),
      pattern: z.string().describe('The wildcard as it appears in the pool, e.g. "Star Trek*"'),
      exclude: z.array(z.string()).default([]).describe('Matched titles to leave out'),
      include: z.array(z.string()).default([]).describe('Previously excluded titles to bring back'),
      rescan: z.boolean().default(false).describe('Search again for titles matching the pattern'),
    }),
    annotations: { ...WRITE, idempotentHint: true },
  }, async ({ channel, pattern, exclude, include, rescan }) => {
    const c = resolveChannel(channel);
    const s = store.listSources(c.id).find((x) => x.kind === 'wildcard' && x.ref.toLowerCase() === pattern.toLowerCase().trim());
    if (!s) throw new Error(`No wildcard "${pattern}" in ${c.name}'s pool. Wildcards there: ${store.listSources(c.id).filter((x) => x.kind === 'wildcard').map((x) => x.ref).join(', ') || 'none'}.`);
    const resolved = s.options.resolved || [];
    const find = (name) => resolved.find((r) => normTitle(r.name) === normTitle(name)) || resolved.find((r) => normTitle(r.name).includes(normTitle(name)));
    const excluded = new Set(s.options.excluded || []);
    const notes = [];
    for (const name of exclude) { const r = find(name); if (r) { excluded.add(r.id); notes.push(`excluded ${r.name}`); } else notes.push(`✗ "${name}" isn't one of its matches`); }
    for (const name of include) { const r = find(name); if (r) { excluded.delete(r.id); notes.push(`included ${r.name}`); } else notes.push(`✗ "${name}" isn't one of its matches`); }
    const updated = await ops.updateSource(c, s, { excluded: [...excluded], refresh: rescan });
    return text(`${notes.join('\n') || 'No title changes.'}${rescan ? '\nRe-scanned.' : ''}\nNow: ${sourceLabel(updated)}`);
  });

  // ---- slots

  server.registerTool('streamtube_add_slots', {
    title: 'Add time slots',
    description: 'Add weekly time slots to a channel, e.g. [{days:"weeknights", start:"8pm", end:"9pm", content:"Modern Family"}, {days:"saturday", start:"9am", length:"3h", content:"pool"}]. ' +
      'Set replace_existing to swap out all the channel\'s current slots (confirm with the user first). When slots overlap, the earlier-starting one wins.',
    inputSchema: z.object({
      channel: z.union([z.string(), z.number()]),
      slots: z.array(slotSchema).min(1),
      replace_existing: z.boolean().default(false),
    }),
    annotations: WRITE,
  }, async ({ channel, slots, replace_existing }) => {
    const c = resolveChannel(channel);
    const built = [];
    const problems = [];
    for (const s of slots) {
      try { built.push(await buildSlot(s)); } catch (e) { problems.push(`${s.days} ${s.start}: ${e.message}`); }
    }
    if (!built.length) throw new Error(`No slot could be added:\n${problems.join('\n')}`);
    if (replace_existing) for (const s of store.listSlots(c.id)) await ops.deleteSlot(c, s.id, { rebuildGuide: false });
    const lines = [];
    for (const b of built) {
      const slot = await ops.addSlot(c, b.body, { rebuildGuide: false });
      lines.push(`+ ${slotLabel(slot)} (${b.note})`);
    }
    await ops.rebuild(c.id);
    return text(`${c.number} ${c.name}${replace_existing ? ' (previous slots removed)' : ''}:\n${lines.join('\n')}` +
      `${problems.length ? `\n\nNot added:\n${problems.map((p) => `- ${p}`).join('\n')}` : ''}\n\nAll slots now:\n${store.listSlots(c.id).map((s) => `- ${slotLabel(s)}`).join('\n')}`);
  });

  server.registerTool('streamtube_remove_slots', {
    title: 'Remove time slots',
    description: 'Remove time slots from a channel by slot id (see streamtube_get_channel), or all of them.',
    inputSchema: z.object({
      channel: z.union([z.string(), z.number()]),
      slot_ids: z.array(z.number().int()).default([]),
      all: z.boolean().default(false).describe('Remove every slot on the channel'),
    }),
    annotations: DESTRUCTIVE,
  }, async ({ channel, slot_ids, all }) => {
    const c = resolveChannel(channel);
    const slots = store.listSlots(c.id);
    const targets = all ? slots : slots.filter((s) => slot_ids.includes(s.id));
    const missing = all ? [] : slot_ids.filter((id) => !slots.some((s) => s.id === id));
    for (const s of targets) await ops.deleteSlot(c, s.id, { rebuildGuide: false });
    if (targets.length) await ops.rebuild(c.id);
    return text(`${c.number} ${c.name}: removed ${targets.length} slot(s)${missing.length ? `; no slot with id ${missing.join(', ')}` : ''}.\n` +
      `Remaining:\n${store.listSlots(c.id).map((s) => `- ${slotLabel(s)}`).join('\n') || '- none (pool all day)'}`);
  });

  // ---- playback

  server.registerTool('streamtube_skip_current', {
    title: 'Skip current program',
    description: 'Skip what is on now on a channel and start whatever the channel\'s rules pick next (next episode, or another title). Anyone watching switches over within seconds.',
    inputSchema: z.object({ channel: z.union([z.string(), z.number()]) }),
    annotations: WRITE,
  }, async ({ channel }) => {
    const c = resolveChannel(channel);
    // If the channel is streaming, cut where its published video ends, so the replacement starts from the top.
    const at = Math.max(Date.now(), publishedEdge(c.id) ?? 0);
    const cur = store.epgAt(c.id, at) || store.epgAt(c.id, Date.now());
    if (!cur) throw new Error(`Nothing is on ${c.name} right now.`);
    await replaceItem(c.id, cur.id, { now: Math.min(at, cur.end - 1000) });
    const now = store.epgAt(c.id, at);
    const live = interruptRunner(c.id);
    return text(`Skipped ${itemLabel(cur)} on ${c.number} ${c.name}. Now: ${now ? itemLabel(now) : 'nothing scheduled'}${live ? ' (switching the live stream now)' : ''}.`);
  });

  server.registerTool('streamtube_rebuild_guide', {
    title: 'Rebuild guide',
    description: 'Re-plan the upcoming guide for a channel (or every channel). What is on now keeps playing. Rarely needed: edits rebuild automatically.',
    inputSchema: z.object({ channel: z.union([z.string(), z.number()]).optional().describe('Omit for every channel') }),
    annotations: { ...WRITE, idempotentHint: true },
  }, async ({ channel }) => {
    const list = channel != null ? [resolveChannel(channel)] : store.listChannels();
    for (const c of list) await ops.rebuild(c.id);
    return text(`Rebuilt the guide for ${list.map((c) => `${c.number} ${c.name}`).join(', ')}.`);
  });

  server.registerTool('streamtube_repair_guide', {
    title: 'Repair guide',
    description: 'Find guide items stretched far past their usual runtime (e.g. a 50-minute episode holding a 9-hour slot) and fix them: upcoming ones are re-planned, an on-air one is skipped. Also runs automatically at startup.',
    inputSchema: z.object({}),
    annotations: { ...WRITE, idempotentHint: true },
  }, async () => {
    const fixed = await repairGuide();
    return text(fixed.length ? `Fixed ${fixed.length} item(s):\n${fixed.map((f) => `- ${f}`).join('\n')}` : 'The guide looks fine: nothing is stretched past its usual runtime.');
  });

  // ---- stream addons & settings

  server.registerTool('streamtube_add_stream_addon', {
    title: 'Add stream addon',
    description: 'Add a debrid-enabled Stremio stream addon by its manifest URL (Torrentio, Comet, MediaFusion, AIOStreams... configured with the debrid key in the URL). Tests it first by default.',
    inputSchema: z.object({
      url: z.string().min(8).describe('Manifest URL, e.g. https://torrentio.strem.fun/realdebrid=KEY/manifest.json (stremio:// links work too)'),
      test: z.boolean().default(true).describe('Check it returns cached, playable streams before adding'),
    }),
    annotations: WRITE,
  }, async ({ url, test }) => {
    const s = store.getSettings();
    const clean = url.trim().replace(/^stremio:\/\//i, 'https://');
    if ((s.streamAddons || []).some((u) => addonBase(u) === addonBase(clean))) return text(`That addon is already configured (${maskAddon(clean)}).`);
    let report = '';
    if (test) {
      const r = await ops.testAddon(clean);
      report = `\nTest (Modern Family S01E01): ${r.name || 'addon'} returned ${r.total} streams, ${r.withUrl} with direct links, ${r.playable} cached & usable.${r.hint ? `\n${r.hint}` : ''}`;
    }
    await ops.applySettings({ streamAddons: [...(s.streamAddons || []), clean] });
    return text(`Added stream addon ${maskAddon(clean)}.${report}`);
  });

  server.registerTool('streamtube_remove_stream_addon', {
    title: 'Remove stream addon',
    description: 'Remove a stream addon by its number in streamtube_get_settings, its host name (e.g. "torrentio") or full URL. Confirm with the user first.',
    inputSchema: z.object({ addon: z.union([z.number(), z.string()]).describe('1-based number, host name or URL') }),
    annotations: DESTRUCTIVE,
  }, async ({ addon }) => {
    const list = store.getSettings().streamAddons || [];
    let idx = -1;
    if (typeof addon === 'number' || /^\d+$/.test(String(addon))) idx = Number(addon) - 1;
    else {
      const q = String(addon).toLowerCase();
      const hits = list.map((u, i) => [u, i]).filter(([u]) => u.toLowerCase() === q || addonBase(u).toLowerCase() === addonBase(q).toLowerCase() || new URL(addonBase(u)).host.includes(q));
      if (hits.length > 1) throw new Error(`"${addon}" matches several addons; use its number from streamtube_get_settings.`);
      idx = hits[0]?.[1] ?? -1;
    }
    if (idx < 0 || idx >= list.length) throw new Error(`No such addon. There are ${list.length}: ${list.map((u, i) => `${i + 1}. ${maskAddon(u)}`).join(', ') || 'none'}.`);
    const removed = list[idx];
    await ops.applySettings({ streamAddons: list.filter((_, i) => i !== idx) });
    return text(`Removed ${maskAddon(removed)}. ${list.length - 1} addon(s) left.`);
  });

  server.registerTool('streamtube_test_stream_addons', {
    title: 'Test stream addons',
    description: 'Check that configured stream addons answer and return cached, playable debrid streams (tests against Modern Family S01E01). Tests all of them, or one by number.',
    inputSchema: z.object({ addon: z.number().int().min(1).optional().describe('1-based number; omit to test all') }),
    annotations: RO_NET,
  }, async ({ addon }) => {
    const list = store.getSettings().streamAddons || [];
    if (!list.length) return text('No stream addons configured.');
    const targets = addon ? [[list[addon - 1], addon]] : list.map((u, i) => [u, i + 1]);
    const out = [];
    for (const [u, n] of targets) {
      if (!u) { out.push(`${n}. no such addon`); continue; }
      try {
        const r = await ops.testAddon(u);
        out.push(`${n}. ${r.name || maskAddon(u)}: ${r.total} streams, ${r.withUrl} direct, ${r.playable} cached & usable${r.error ? ` (error: ${r.error})` : ''}${r.hint ? `\n   ${r.hint}` : ''}` +
          (r.sample?.length ? `\n   best: ${r.sample[0].resolution || '?'}p ${r.sample[0].label.slice(0, 100)}` : ''));
      } catch (e) {
        out.push(`${n}. ${maskAddon(u)}: ${e.message}`);
      }
    }
    return text(out.join('\n'));
  });

  server.registerTool('streamtube_update_settings', {
    title: 'Update settings',
    description: 'Change server settings: timezone, preferred release words (e.g. ["Superfan"]), how many minutes ahead streams are prepared, the one-stream-per-device cap, default resolution for new channels, public URL, metadata addon.',
    inputSchema: z.object({
      timezone: z.string().optional().describe('IANA name, e.g. America/Chicago'),
      prefer_keywords: z.array(z.string()).optional().describe('Release-name words that win over everything else; [] clears'),
      prefetch_minutes: z.number().int().min(0).max(60).optional().describe('Prepare streams this long before airtime; 0 turns it off'),
      one_stream_per_ip: z.boolean().optional(),
      default_resolution: z.union([z.number(), z.string()]).optional(),
      public_url: z.string().optional().describe('Address devices use to reach StreamTube; "" = from the request'),
      meta_addon: z.string().optional().describe('Metadata addon URL (Cinemeta by default)'),
    }),
    annotations: { ...WRITE, idempotentHint: true },
  }, async (a) => {
    const patch = {};
    if (a.timezone !== undefined) patch.timezone = a.timezone;
    if (a.prefer_keywords !== undefined) patch.preferKeywords = a.prefer_keywords;
    if (a.prefetch_minutes !== undefined) patch.prefetchMinutes = a.prefetch_minutes;
    if (a.one_stream_per_ip !== undefined) patch.oneStreamPerIp = a.one_stream_per_ip;
    if (a.default_resolution !== undefined) patch.defaultResolution = typeof a.default_resolution === 'number' ? a.default_resolution : parseResolution(a.default_resolution);
    if (a.public_url !== undefined) patch.publicUrl = a.public_url;
    if (a.meta_addon !== undefined) patch.metaAddon = a.meta_addon;
    if (!Object.keys(patch).length) throw new Error('Nothing to change: pass at least one setting.');
    await ops.applySettings(patch);
    return text(`Saved: ${Object.keys(a).filter((k) => a[k] !== undefined).join(', ')}.`);
  });

  // ---- backup

  server.registerTool('streamtube_export_backup', {
    title: 'Export backup',
    description: 'Export every channel (settings, pool, wildcards, slots, show progress) as backup JSON. include_settings adds server settings, which contain the debrid addon URLs and keys.',
    inputSchema: z.object({ include_settings: z.boolean().default(false) }),
    annotations: RO,
  }, async ({ include_settings }) => jsonResult(ops.exportBackup({ includeSettings: include_settings })));

  server.registerTool('streamtube_import_backup', {
    title: 'Import backup',
    description: 'Import a StreamTube backup (the JSON from streamtube_export_backup or the web UI). Adds the channels alongside existing ones, or replaces them all with replace=true (confirm with the user first).',
    inputSchema: z.object({
      backup: z.record(z.string(), z.unknown()).describe('The backup JSON object'),
      replace: z.boolean().default(false).describe('Delete every existing channel first'),
      include_settings: z.boolean().default(false).describe('Also apply the settings stored in the backup'),
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async ({ backup, replace, include_settings }) => {
    const r = await ops.importBackup(backup, { replace, includeSettings: include_settings });
    return text(`Imported ${r.imported} channel(s)${r.replaced ? ', replacing the old ones' : ''}${r.settings ? ', plus settings' : ''}. Guides are being built.`);
  });
}

function createServer() {
  const server = new McpServer({ name: 'streamtube-mcp-server', version: VERSION }, { instructions: INSTRUCTIONS });
  registerTools(server);
  return server;
}

/** Node (req, res) handler for /mcp. Auth and Origin checks happen in index.js before this runs. */
export const mcpHandler = toNodeHandler(createMcpHandler(createServer, {
  onerror: (e) => log.warn(`mcp: ${e.message}`),
}), { onerror: (e) => log.warn(`mcp: ${e.message}`) });
