// Guide clean-up: find items stretched far past their title's usual runtime (an older build re-stretched
// slots for files with broken length headers) and put the guide back in shape.

import { store } from './db.js';
import { log } from './config.js';
import { buildChannel, replaceItem, maxItemLength, itemLabel } from './scheduler.js';
import { interruptRunner, publishedEdge } from './playout.js';

/**
 * Upcoming over-long items: the channel's guide is re-planned from now. An over-long item that is on air is
 * skipped (the channel moves on to what its rules pick next, and viewers are switched over).
 * Returns a list of what was fixed.
 */
export async function repairGuide({ now = Date.now() } = {}) {
  const fixed = [];
  for (const channel of store.listChannels()) {
    const rows = store.all('SELECT * FROM epg WHERE channel_id = ? AND end > ? ORDER BY start', channel.id, now);
    let rebuild = false;
    for (const r of rows) {
      const max = await maxItemLength(r, channel);
      if (r.end - r.start <= max + 60000) continue;
      const minutes = Math.round((r.end - r.start) / 60000);
      if (r.start <= now) {
        await replaceItem(channel.id, r.id, { now: Math.min(Math.max(now, publishedEdge(channel.id) ?? 0), r.end - 1000) });
        interruptRunner(channel.id);
        fixed.push(`channel ${channel.number}: skipped ${itemLabel(r)} (on air, ${minutes} min in the guide)`);
      } else {
        rebuild = true;
        fixed.push(`channel ${channel.number}: ${itemLabel(r)} had ${minutes} min`);
      }
    }
    if (rebuild) await buildChannel(channel.id, { rebuild: true });
  }
  if (fixed.length) log.info(`guide repair:\n  ${fixed.join('\n  ')}`);
  return fixed;
}
