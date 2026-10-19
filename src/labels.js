// Human-readable summaries of channel contents, shared by the Stremio addon and the MCP tools.

import { store } from './db.js';

const DAY = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** "1,2,3,4,5" -> "Weekdays"; "6,7" -> "Weekends"; all -> "Daily"; else "Mon, Wed". */
export function daysLabel(days) {
  const d = String(days).split(',').map(Number).sort().join(',');
  if (d === '1,2,3,4,5,6,7') return 'Daily';
  if (d === '1,2,3,4,5') return 'Weekdays';
  if (d === '6,7') return 'Weekends';
  return d.split(',').map((n) => DAY[n]).join(', ');
}

/** "20:00" -> "8 PM", "20:30" -> "8:30 PM". */
export function clock12(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return `${h % 12 || 12}${m ? `:${String(m).padStart(2, '0')}` : ''} ${h < 12 ? 'AM' : 'PM'}`;
}

/** Every show/movie a channel can play, wildcards expanded (minus unticked matches), in pool order. */
export function poolTitles(channelId) {
  const names = [];
  for (const s of store.listSources(channelId)) {
    if (s.kind !== 'wildcard') { names.push(s.name); continue; }
    const excluded = new Set(s.options.excluded || []);
    const resolved = (s.options.resolved || []).filter((r) => !excluded.has(r.id)).map((r) => r.name);
    names.push(...(resolved.length ? resolved : [s.name]));
  }
  return [...new Set(names)];
}

/**
 * The channel's lineup for Stremio: its shows ("Clone Wars · Rebels · Bad Batch", capped with "and N more")
 * and its time slots ("Weekdays 8 PM: Modern Family"). Nothing time-sensitive, so a cached copy stays true.
 */
export function lineup(channelId, { max = 10 } = {}) {
  const titles = poolTitles(channelId);
  const shown = titles.slice(0, max).join(' · ');
  const more = titles.length > max ? ` · and ${titles.length - max} more` : '';
  const slots = store.listSlots(channelId).map((s) => `${daysLabel(s.days)} ${clock12(s.start)}: ${s.content.kind === 'pool' ? 'the mix' : s.content.name}`);
  return [titles.length ? `${shown}${more}` : 'Nothing in the lineup yet', ...slots].join('\n');
}
