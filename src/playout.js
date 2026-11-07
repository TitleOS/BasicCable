import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { config, log, redact } from './config.js';
import { store } from './db.js';
import { headerArgs } from './probe.js';
import { prepareStream, dropPrepared, skipUnplayable, preparedFor, fitGuideToFile, seedPrepared } from './prefetch.js';
import { buildChannel, itemLabel, retimeFrom } from './scheduler.js';
import { subtitlePlan, burnFilter } from './subtitles.js';
import { UP_NEXT_SECONDS, upNextFont, upNextText, upNextFilter } from './upnext.js';
import { perBreak, clipsFor, pickBreak, readyFile } from './commercials.js';
import { utilityOf, renderUtilityFrame } from './utilities.js';
import { pickTrack, trackPath, trackLabel } from './music.js';

// Read-ahead: ffmpeg reads up to READ_AHEAD_SECONDS ahead of real time, but each segment only appears in the
// live playlist when its moment in the schedule arrives. Viewers stay on real time and in step with the guide,
// while a slow or stalled debrid read drains the server's buffer instead of their screen.
//
// The playlist runs PREROLL_SECONDS ahead of what's due on screen, and that lead is the player's own cushion: a
// player tuning in starts at the first segment, PREROLL_SECONDS behind the edge (less its own start-up time).
// With 18s, players starting 5s late and refreshing their playlist only every target duration stalled a few
// times before they had built up a cushion; ~30s is where they stopped. The playlist lists ~60s, so a player
// that stalls carries on where it was instead of being pushed out of the window.
const SEGMENT_SECONDS = 6;
const WINDOW = 10; // segments listed in the live playlist
const PREROLL_SECONDS = 30; // how far ahead of the live position segments are published
const EARLY_FAIL_SECONDS = 15; // ffmpeg dying before producing this much video means the file is the problem
// A copied (not re-encoded) video can only be cut at its keyframes. Most files have one every 10s or less; some
// rips go 30s+ without one, and segments that long make players stall. Past this, the video gets re-encoded.
const LONG_SEGMENT_SECONDS = 12;
const longGop = new Map(); // stream url -> when it was found to need re-encoding (so a resume re-encodes too)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RETIME_MS = 3000; // a program starting this far off its guide time moves the guide
const MAX_LATE_RETIME_MS = 5 * 60 * 1000; // a later start than this joins the program part-way instead
const MIN_BREAK_GAP_MS = 10000; // a gap shorter than this before the next program isn't worth a commercial
const recentAds = new Map(); // channel id -> clip ids played lately, newest last (outlives a channel restart)
const recentTracks = new Map(); // channel id -> music track ids played lately, newest last
const BURN_PRESET = process.env.SUBTITLE_BURN_PRESET || 'veryfast';
// A channel's saved position (playout_state) is only trusted this long after it was written: debrid links
// expire, and an old row could point at a long-gone program anyway.
const STATE_MAX_AGE_MS = 6 * 3600 * 1000;
const STATE_SAVE_MS = 15000;
const EMPTY_VTT = 'WEBVTT\n\n';
// ffmpeg writes WebVTT cue times on the same output timeline as the video (including -output_ts_offset), and
// its MPEG-TS muxer puts that timeline's zero at 1.4s (126000 at 90 kHz). So cue time 0 always maps to 126000.
// (Reading the first video timestamp instead is wrong after a seek: it lands on the keyframe before the seek
// point, and with a timestamp offset or an MP4 source that is seconds away from cue zero.)
const VTT_MPEGTS_ZERO = 126000;

// ---------------------------------------------------------------------------
// ffmpeg capabilities

let caps;
export function ffmpegCaps() {
  if (caps) return caps;
  caps = new Promise((resolve) => {
    execFile(config.ffmpeg, ['-hide_banner', '-version'], (err, stdout) => {
      if (err) return resolve({ ok: false, error: err.message });
      const m = stdout.match(/ffmpeg version n?(\d+)\.(\d+)/);
      const major = m ? Number(m[1]) : 0, minor = m ? Number(m[2]) : 0;
      // "-readrate_initial_burst" arrived in 6.1; older builds just pace from the first frame.
      const burst = major > 6 || (major === 6 && minor >= 1) || !m;
      // ffmpeg 8.0's -readrate falls to ~0.5x real time whenever a subtitle stream is mapped, which would
      // stall the channel; 7.x (what the Docker image ships) paces correctly.
      const subtitles = !m || major < 8;
      execFile(config.ffmpeg, ['-hide_banner', '-filters'], (_e, out) => {
        resolve({ ok: true, version: m ? `${m[1]}.${m[2]}` : 'unknown', burst, subtitles, drawtext: /\bdrawtext\b/.test(out || '') });
      });
    });
  });
  return caps;
}

const FONT_CANDIDATES = [
  process.env.SLATE_FONT,
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/dejavu/DejaVuSans.ttf',
  'C:/Windows/Fonts/arial.ttf',
].filter(Boolean);
const slateFont = FONT_CANDIDATES.find((f) => { try { return fs.statSync(f).isFile(); } catch { return false; } });

function pickAudio(audio, lang) {
  if (!audio.length) return null;
  const want = (lang || 'eng').toLowerCase();
  const matches = (s) => {
    const l = (s.tags?.language || '').toLowerCase();
    return l === want || l.startsWith(want.slice(0, 2));
  };
  const commentary = (s) => /comment/i.test(s.tags?.title || '');
  const byLang = audio.filter(matches);
  const pool = byLang.length ? byLang : audio;
  const chosen = pool.find((s) => !commentary(s) && s.disposition?.default) || pool.find((s) => !commentary(s)) || pool[0];
  return audio.indexOf(chosen);
}

// ---------------------------------------------------------------------------
// Channel runner: one ffmpeg chain per channel, shared by every viewer

export class ChannelRunner {
  constructor(channelId) {
    this.channelId = Number(channelId);
    this.dir = path.join(config.hlsDir, `ch${this.channelId}-${Date.now().toString(36)}`);
    fs.mkdirSync(this.dir, { recursive: true });
    this.segments = []; // {name, duration, disc, seq, program, index}
    this.programs = new Map(); // program number -> { vtt: bool }
    this.nextSeq = 0;
    this.program = 0;
    // The channel's own timeline: contentTotal seconds of video produced so far, the first of which was due on
    // screen at timeBase (wall clock). Each program's timestamps continue from contentTotal, so players that
    // ignore discontinuity tags (mpv/ffmpeg) never see time run backwards and mistake it for the end of the stream.
    this.timeBase = null;
    this.contentTotal = 0;
    this.visible = 0; // segments published so far (never decreases)
    this.cancelled = new Set(); // programs whose output is thrown away (skipped)
    this.maxTarget = SEGMENT_SECONDS;
    this.resume = null; // { itemId, at } after a mid-program drop: carry on from there
    this.lastAccess = Date.now();
    this.viewers = new Map(); // viewer ip -> last request time
    this.stopped = false;
    this.proc = null;
    this.status = { state: 'starting', item: null, stream: null, since: Date.now(), message: '' };
    this.waiters = [];
    this.loop = this.run().catch((e) => log.error(`runner ${this.channelId} crashed:`, e));
  }

  touch(ip) {
    this.lastAccess = Date.now();
    if (ip) this.viewers.set(ip, this.lastAccess);
  }

  activeViewers() {
    const cutoff = Date.now() - config.idleSeconds * 1000;
    return [...this.viewers].filter(([, t]) => t > cutoff).map(([ip]) => ip);
  }

  stop() {
    this.stopped = true;
    if (this.proc) this.proc.kill('SIGKILL');
    this.resolveWaiters();
    setTimeout(() => fs.rm(this.dir, { recursive: true, force: true }, () => {}), 2000);
  }

  setStatus(s) { this.status = { ...this.status, ...s, since: Date.now() }; }

  /** Wall time at which the next second of video we produce will be shown: the channel's production clock. */
  clock() {
    const now = Date.now();
    if (this.timeBase == null) this.timeBase = now;
    const t = this.timeBase + this.contentTotal * 1000;
    if (t < now - SEGMENT_SECONDS * 1000) {
      // The buffer ran dry and production fell behind: carry on from now rather than replaying the past.
      this.timeBase += now - t;
      return now;
    }
    return t;
  }

  /** Seconds of video buffered beyond what is due on screen now. */
  leadSeconds() {
    return this.timeBase == null ? 0 : (this.timeBase + this.contentTotal * 1000 - Date.now()) / 1000;
  }

  /** Segments whose time has come (plus the tune-in preroll) are published; the rest wait in the buffer. */
  visibleCount() {
    if (this.timeBase == null) return 0;
    const due = (Date.now() - this.timeBase) / 1000 + PREROLL_SECONDS;
    while (this.visible < this.segments.length && this.segments[this.visible].contentStart <= due) this.visible++;
    return this.visible;
  }

  /** How far ahead to read for a file: READ_AHEAD_SECONDS, less for high bitrates or a small HLS_DIR. */
  leadTarget(info) {
    if (config.readAheadSeconds <= 0) return 0; // read-ahead turned off
    const bitrate = info?.bitrate || 10e6;
    let bytes = config.readAheadMB * 1048576;
    try {
      const st = fs.statfsSync(this.dir);
      bytes = Math.min(bytes, (st.bavail * st.bsize) / 4);
    } catch { /* statfs unsupported: use the configured cap */ }
    return Math.max(10, Math.min(config.readAheadSeconds, (bytes * 8) / bitrate));
  }

  deleteSegmentFiles(seg) {
    if (seg.deleted) return;
    seg.deleted = true;
    fs.rm(path.join(this.dir, seg.name), { force: true }, () => {});
    if (this.programs.get(seg.program)?.vtt) fs.rm(path.join(this.dir, `p${seg.program}_${seg.index}.vtt`), { force: true }, () => {});
  }

  /** Throw away buffered video nobody has been shown yet (the program it belongs to was skipped). */
  dropUnpublished() {
    const keep = this.visibleCount();
    for (const seg of this.segments.slice(keep)) this.deleteSegmentFiles(seg);
    this.segments.length = keep;
    const last = this.segments[keep - 1];
    this.contentTotal = last ? last.contentStart + last.duration : 0;
  }

  async run() {
    let lastItem = null;
    let fails = 0;
    let failItem = null;
    let breakBefore = null; // the program whose commercial break has already played
    let following = false; // the last thing on air was a program that played to its end
    while (!this.stopped) {
      const now = this.clock();
      let item = store.epgAt(this.channelId, now);
      // Never step back: after a program, only something later in the guide comes next. (The stream can be ahead
      // of the guide; going by the clock alone once replayed the end of the previous program and then the
      // current one again.)
      if (item && lastItem && item.start <= lastItem.start) item = store.epgAfter(this.channelId, lastItem.start);
      if (!item) {
        buildChannel(this.channelId).catch(() => {});
        this.setStatus({ state: 'offair', item: null, stream: null, message: 'Nothing scheduled' });
        following = false;
        await this.playSlate('Nothing scheduled on this channel', 'Add shows in the Basic Cable web interface', 30);
        continue;
      }
      // A program just finished ahead of the next one's start: that's where the commercials go. Breaks are never
      // guide items; they fill the room the guide leaves after each program, and stop at the next one's start.
      if (lastItem && breakBefore !== item.id && item.start - now >= MIN_BREAK_GAP_MS) {
        breakBefore = item.id;
        await this.playBreak(item);
        continue; // look at the guide again: it may have changed during the break
      }
      if (item.id !== failItem) { failItem = item.id; fails = 0; }
      const result = item.type === 'utility' ? await this.playUtility(item) : await this.playItem(item, { following });
      following = result === 'done';
      if (this.stopped) break;
      // Re-read it: starting it may have moved it in the guide.
      if (result === 'done') { lastItem = store.get('SELECT * FROM epg WHERE id = ?', item.id) || item; continue; }
      if (result === 'skipped') continue; // the guide now has a replacement at this spot
      fails++;
      if (result === 'retry' && fails <= 3) continue; // link dropped mid-item: resume where it stopped
      // Keep the channel alive with a slate, retrying every minute, giving up on the item after a few tries.
      const remaining = item.end - this.clock();
      const slateMs = fails > 3 ? remaining : Math.min(remaining, 60000);
      if (slateMs > 3000) await this.playSlate(`Couldn't play ${itemLabel(item)}`, this.status.message || 'No working stream found', slateMs / 1000);
      if (fails > 3) lastItem = item;
    }
  }

  async playItem(item, { following = false } = {}) {
    const channel = store.getChannel(this.channelId);
    if (!channel) { this.stop(); return 'failed'; }
    this.setStatus({ state: 'resolving', item: { ...item, label: itemLabel(item) }, stream: null, message: '' });

    // Normally the prefetcher has already picked and probed a file, so this returns at once.
    const t0 = Date.now();
    const prepare = async () => {
      try {
        return await prepareStream(item, channel);
      } catch (e) {
        this.setStatus({ state: 'error', message: redact(e.message) });
        log.warn(`channel ${channel.number}: ${e.message}`);
        return undefined;
      }
    };
    // After a restart, the stream this channel was playing before is used again, without asking the addons.
    const restored = !preparedFor(item, channel) && this.restoreState(item, channel);
    let prep;
    if (this.segments.length && !preparedFor(item, channel)) {
      // Mid-session and the next program isn't ready. The buffer usually covers the wait; if it runs low, keep
      // players fed with short "Up next" segments instead of letting the playlist freeze (players give up and
      // drop back to their menus).
      let settled = false;
      const pending = prepare().then((r) => { settled = true; return r; });
      while (!settled && !this.stopped) {
        if (this.leadSeconds() > 12) await Promise.race([pending, sleep(1000)]);
        else await this.playSlate(`Up next: ${itemLabel(item)}`, 'Getting the stream ready…', 4);
      }
      prep = await pending;
    } else {
      prep = await prepare();
    }
    if (prep === undefined) return 'failed';
    if (!prep) {
      // Nothing playable: put another episode in its place (by the channel's rules) and play that instead.
      if (await skipUnplayable(item, channel, { at: this.clock() })) return 'skipped';
      this.setStatus({ state: 'error', message: 'No cached debrid stream found' });
      return 'failed';
    }
    const waited = Date.now() - t0;

    // Normally the prefetcher already sized this program's slot to its file. If it didn't get to (tuned in
    // right after a restart, prefetching off), make room for a longer file now rather than cutting it off.
    if (prep.info?.duration && prep.info.duration * 1000 > item.end - item.start) {
      await fitGuideToFile(item, channel, prep.info, { onAir: true }).catch((e) => log.warn(`channel ${channel.number}: couldn't fit the guide: ${e.message}`));
      item = store.get('SELECT * FROM epg WHERE id = ?', item.id) || item;
    }

    // Warm up whatever comes next so the hand-over is quick.
    const next = store.epgAfter(this.channelId, item.start);
    if (next) prepareStream(next, channel).catch(() => {});

    let transcode = false;
    for (let attempt = 0; prep && attempt < 6; attempt++) {
      if (this.stopped) return 'done';
      const { cand, info } = prep;
      if (longGop.has(cand.url)) transcode = true;
      // Normally the live position. After a mid-program drop, where it stopped (nothing gets skipped; the end is
      // trimmed instead). An item that starts early (the previous file ran short) plays from 0 and may run past
      // its slot until its scheduled end.
      const resumeAt = this.resume?.itemId === item.id ? this.resume.at : null;
      const pos = this.clock(); // where the channel's timeline is: up to READ_AHEAD_SECONDS past now
      // Straight on from the previous program, but not at its guide time: the guide follows the stream, so move
      // this program (and everything after it) to when it really starts. Not on tune-in, which joins part-way.
      if (attempt === 0 && following && resumeAt == null && Math.abs(item.start - pos) > RETIME_MS &&
        (pos < item.start || pos - item.start < MAX_LATE_RETIME_MS) && (await retimeFrom(this.channelId, item.id, pos)) === true) {
        const off = Math.round((item.start - pos) / 1000);
        log.info(`channel ${channel.number}: ${itemLabel(item)} starts ${Math.abs(off)}s ${off > 0 ? 'early' : 'late'}; moved the guide to match`);
        item = store.get('SELECT * FROM epg WHERE id = ?', item.id) || item;
        this.status.item = { ...item, label: itemLabel(item) };
      }
      const startAt = resumeAt ?? Math.max(0, (pos - item.start) / 1000);
      const limit = Math.max(5, (item.end - pos) / 1000);
      // Read ahead just enough to bring the buffer up to its target (a few seconds minimum to start quickly).
      const target = this.leadTarget(info);
      const burst = Math.max(4, Math.min(target, target - this.leadSeconds()));
      if (info.duration && startAt >= info.duration - 3) return 'done'; // we're in the padding after it ended
      this.setStatus({
        state: 'playing',
        stream: { label: cand.label, resolution: cand.resolution, addon: cand.addon, codec: info.video?.codec_name, height: info.video?.height },
        message: '',
      });
      const caps = await ffmpegCaps();
      const subs = caps.subtitles ? subtitlePlan(info.subtitles, channel.options?.subtitles || 'auto') : null;
      if (!caps.subtitles && subtitlePlan(info.subtitles, channel.options?.subtitles || 'auto')) {
        log.warn(`channel ${channel.number}: skipping subtitles, ffmpeg ${caps.version} can't pace them in real time (use ffmpeg 7.x)`);
      }
      if (subs) this.status.stream.subtitles = `${subs.stream.tags?.title || subs.stream.tags?.language || 'track ' + subs.index} (${subs.delivery === 'vtt' ? 'selectable' : 'burned in'})`;
      const hdr = /smpte2084|arib-std-b67/.test(info.video?.color_transfer || '');
      const end = Math.min(info.duration || Infinity, startAt + limit);
      // "Up next" box over the last minute. Copied video is played up to that minute and the rest re-encoded with
      // the box drawn in (a hand-over like a resume); video that's re-encoded anyway just gets the box. HDR stays
      // copied, so it gets no box.
      let upNext = null; // { from: seconds into this run, split: stop the copied run there }
      if (channel.options?.upNextOverlay && caps.drawtext && upNextFont) {
        const from = end - UP_NEXT_SECONDS - startAt;
        const encoding = transcode || subs?.delivery === 'burn';
        if (hdr) {
          if (attempt === 0 && resumeAt == null) log.info(`channel ${channel.number}: ${itemLabel(item)} is HDR; no "Up next" box (it would mean re-encoding)`);
        } else if (this.resume?.upNext && resumeAt != null) upNext = { from: 0, split: false };
        else if (from > 10 && !encoding) upNext = { from, split: true };
        else upNext = { from: Math.max(0, from), split: false };
      }
      const overlay = upNext && !upNext.split ? this.upNextOverlay(item, channel, info, upNext.from) : null;
      if (upNext && !upNext.split && !overlay) upNext = null; // nothing after it in the guide
      const runLimit = upNext?.split ? upNext.from : limit;
      log.info(`channel ${channel.number}: ${resumeAt != null ? 'resuming' : 'playing'} ${itemLabel(item)} from ${Math.round(startAt)}s @ ${info.video?.height || '?'}p` +
        (transcode || overlay ? ', re-encoding video' : '') + (overlay ? `, "Up next" box${upNext.from > 0 ? ` from ${Math.round(startAt + upNext.from)}s` : ''}` : '') +
        (subs ? `, subtitles ${subs.delivery === 'vtt' ? 'as a track' : 'burned in'} (${subs.stream.codec_name}${subs.sdh ? ', SDH' : ''})` : '') +
        (attempt === 0 ? (restored && prep.restored ? ', same stream as before the restart' : waited < 200 ? ', stream was prepared ahead' : `, stream picked in ${(waited / 1000).toFixed(1)}s`) : ''));
      if (this.skipRequested) {
        // Skipped while we were still getting the stream ready.
        this.skipRequested = false;
        return 'skipped';
      }
      // (HDR video stays copied: re-encoding it here would flatten its colours.)
      const copying = !transcode && !overlay && subs?.delivery !== 'burn' && !hdr;
      // Remember where we are every few seconds, so a restart carries on with this very stream.
      const contentAtStart = this.contentTotal;
      this.saveState(item, cand, info, startAt, transcode);
      const saver = setInterval(() => this.saveState(item, cand, info, startAt + (this.contentTotal - contentAtStart), transcode), STATE_SAVE_MS);
      let produced;
      try {
        produced = await this.runFfmpeg(this.mainArgs(cand, info, channel, startAt, runLimit, subs, { transcode, burst, overlay }),
          { vtt: subs?.delivery === 'vtt', maxSegment: copying ? LONG_SEGMENT_SECONDS : 0 });
      } finally {
        clearInterval(saver);
      }
      if (this.stopped) return 'done';
      if (produced.longSegment && !this.skipRequested) {
        // Keyframes too far apart to copy: carry on from the start of the long segment (it was thrown away
        // before anyone saw it) with the video re-encoded to a keyframe every 2s.
        longGop.set(cand.url, Date.now());
        if (longGop.size > 200) longGop.delete(longGop.keys().next().value);
        this.resume = { itemId: item.id, at: startAt + produced.seconds };
        transcode = true;
        log.info(`channel ${channel.number}: ${itemLabel(item)} has keyframes at least ${Math.round(produced.longSegment)}s apart; re-encoding the video from ${Math.round(startAt + produced.seconds)}s`);
        continue;
      }
      if (this.skipRequested) {
        // Someone skipped this program; the guide already has its replacement.
        this.skipRequested = false;
        this.resume = null;
        return 'skipped';
      }
      // The copied part ran up to the last minute: carry on from there with the "Up next" box.
      if (upNext?.split && produced.code === 0 && produced.seconds >= runLimit - 20) {
        this.resume = { itemId: item.id, at: startAt + produced.seconds, upNext: true };
        continue;
      }
      // ffmpeg also exits cleanly when a debrid link dies (it sees an early end of file), so only call it
      // finished if it got to the end of the file or of the slot.
      if (produced.code === 0 && startAt + produced.seconds >= end - 20) {
        this.resume = null;
        return 'done';
      }
      if (produced.code === 0) {
        log.warn(`channel ${channel.number}: ${itemLabel(item)} stopped at ${Math.round(startAt + produced.seconds)}s of ${Math.round(end)}s`);
      }
      if (produced.seconds >= EARLY_FAIL_SECONDS) {
        // Dropped part-way (network, debrid hiccup): pick up from the last second we delivered.
        this.resume = { itemId: item.id, at: startAt + produced.seconds };
        return 'retry';
      }
      // Died right away: the file doesn't remux cleanly (odd codec/container) or the link is dead.
      if (!transcode && subs?.delivery !== 'burn') {
        transcode = true;
        log.warn(`channel ${channel.number}: ${itemLabel(item)} failed to start, trying again with the video re-encoded`);
        continue;
      }
      transcode = false;
      dropPrepared(item, channel, cand.url);
      prep = await prepare();
      if (prep === undefined) return 'failed';
    }
    this.resume = null;
    // No release of this item will play: put another episode in its place, like an unplayable one.
    if (await skipUnplayable(item, channel, { at: this.clock() })) return 'skipped';
    this.setStatus({ state: 'error', message: 'Every candidate stream failed to play' });
    return 'failed';
  }

  /** Write the channel's position and stream to the database (see restoreState). */
  saveState(item, cand, info, position, transcode) {
    try {
      store.run(`INSERT INTO playout_state(channel_id, item_id, video_id, position, stream, transcode, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(channel_id) DO UPDATE SET item_id = excluded.item_id, video_id = excluded.video_id, position = excluded.position,
        stream = excluded.stream, transcode = excluded.transcode, updated_at = excluded.updated_at`,
        this.channelId, item.id, item.video_id, position, JSON.stringify({ cand, info }), transcode ? 1 : 0, Date.now());
    } catch (e) {
      log.debug(`channel ${this.channelId}: could not save the playout state: ${e.message}`);
    }
  }

  /**
   * After a restart: if the channel was playing this very program a short while ago, hand its stream to the
   * prefetch cache so playback starts without an addon lookup or a probe. True when something was restored.
   */
  restoreState(item, channel) {
    const saved = store.get('SELECT * FROM playout_state WHERE channel_id = ?', this.channelId);
    if (!saved || saved.video_id !== item.video_id || Date.now() - saved.updated_at > STATE_MAX_AGE_MS) return false;
    let stream;
    try { stream = JSON.parse(saved.stream); } catch { return false; }
    if (!stream?.cand?.url || !stream.info) return false;
    seedPrepared(item, channel, stream);
    if (saved.transcode) longGop.set(stream.cand.url, Date.now());
    log.info(`channel ${channel.number}: ${itemLabel(item)} was playing before the restart (at ${Math.round(saved.position)}s, ${Math.round((Date.now() - saved.updated_at) / 1000)}s ago); using the same stream`);
    return true;
  }

  /**
   * A generated channel (the weather forecast): one music track at a time over a picture drawn for it, the
   * clock written live in the corner. Runs until the guide item ends.
   */
  async playUtility(item) {
    const channel = store.getChannel(this.channelId);
    const u = utilityOf(channel);
    if (!channel || !u) { this.stop(); return 'failed'; }
    this.setStatus({ state: 'playing', item: { ...item, label: itemLabel(item) }, stream: { label: 'Generated live', resolution: channel.resolution }, message: '' });
    const recent = recentTracks.get(this.channelId) || [];
    let fails = 0;
    while (!this.stopped && !this.skipRequested) {
      const left = (item.end - this.clock()) / 1000;
      if (left < 3) break;
      const track = pickTrack(u.music || 'classical', recent);
      const seconds = Math.min(left, track ? track.duration : 300);
      let frame;
      try {
        frame = await renderUtilityFrame(channel, { nowPlaying: track ? trackLabel(track) : '', dir: this.dir, name: `frame-${this.program + 1}` });
      } catch (e) {
        log.warn(`channel ${channel.number}: ${e.message}`);
        this.setStatus({ state: 'error', message: redact(e.message) });
        if (++fails > 3) return 'failed';
        await this.playSlate(itemLabel(item), redact(e.message), Math.min(60, left));
        continue;
      }
      if (track) { recent.push(track.id); recentTracks.set(this.channelId, recent.slice(-15)); }
      this.status.stream = { label: track ? trackLabel(track) : 'Music is still downloading', resolution: channel.resolution, codec: 'h264', height: frame.height };
      log.info(`channel ${channel.number}: ${itemLabel(item)}: ${track ? trackLabel(track) : 'no music yet'} (${Math.round(seconds)}s)`);
      const target = this.leadTarget(null);
      const burst = Math.max(4, Math.min(target, target - this.leadSeconds()));
      const produced = await this.runFfmpeg(this.utilityArgs(frame, track ? trackPath(track) : null, seconds, burst), { env: { TZ: store.getSettings().timezone } });
      fs.rm(frame.png, { force: true }, () => {});
      if (frame.ticker) fs.rm(frame.ticker.file, { force: true }, () => {});
      if (produced.code !== 0 && produced.seconds < 5 && !this.stopped && !this.skipRequested) {
        if (++fails > 3) { this.setStatus({ state: 'error', message: 'Could not render the channel' }); return 'failed'; }
        await sleep(2000);
      } else fails = 0;
    }
    this.skipRequested = false;
    return 'done';
  }

  /**
   * ffmpeg arguments for one utility track: the still picture, the music, and the live clock in the corner.
   * With `frame.ticker`, a strip of headlines scrolls through the bar: the strip is decoded once and a
   * window-wide crop of it moves across (overlaying the whole strip costs a core; cropping first costs
   * a tenth of one). The crop's starting point follows the wall clock, so the next track carries on from
   * where this one left the strip.
   */
  utilityArgs(frame, audioFile, seconds, burst) {
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-readrate', '1'];
    if (this.capsBurst) args.push('-readrate_initial_burst', String(Math.round(burst)));
    // Only the picture is paced: pacing the music too would hold the tune-in burst back to real time.
    args.push('-loop', '1', '-framerate', '25', '-i', frame.png);
    if (audioFile) args.push('-i', audioFile);
    else args.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo');
    const t = frame.ticker;
    if (t) args.push('-i', t.file);
    const vf = [];
    if (t) {
      const offset = Math.round(((Date.now() / 1000) * t.speed) % t.contentWidth);
      vf.push(`[2:v]loop=loop=-1:size=1:start=0,setpts=N/(25*TB),crop=w=${t.w}:h=${t.h}:x='mod(t*${t.speed}+${offset}\\,${t.contentWidth})':y=0[strip]`);
      vf.push(`[0:v][strip]overlay=x=${t.x}:y=${t.y}:shortest=1[pic]`);
    }
    if (upNextFont && frame.clockBox) {
      const b = frame.clockBox;
      const font = upNextFont.replace(/\\/g, '/').replace(/:/g, '\\:');
      const right = b.x + b.w - Math.round(b.h * 0.35);
      // Two levels of escaping: "\:" separates the function from its format for drawtext's option parser, and
      // the ":" inside the strftime format needs "\\\:" so that one survives into the expansion.
      vf.push(`drawtext=fontfile='${font}':text='%{localtime\\:%-I\\\\\\:%M %p}':fontsize=${Math.round(b.h * 0.34)}:fontcolor=white:x=${right}-tw:y=${b.y + Math.round(b.h * 0.14)}`);
      vf.push(`drawtext=fontfile='${font}':text='%{localtime\\:%A, %B %-d}':fontsize=${Math.round(b.h * 0.17)}:fontcolor=0xc9ced9:x=${right}-tw:y=${b.y + Math.round(b.h * 0.6)}`);
    }
    vf.push('format=yuv420p');
    args.push('-t', seconds.toFixed(2));
    if (t) {
      // The first two entries are labelled graphs; the rest chain from [pic] to the output.
      const [crop, over, ...rest] = vf;
      args.push('-filter_complex', `${crop};${over};[pic]${rest.join(',')}[out]`, '-map', '[out]', '-map', '1:a:0');
    } else args.push('-map', '0:v:0', '-map', '1:a:0', '-vf', vf.join(','));
    if (audioFile && frame.audioGainDb) args.push('-af', `volume=${frame.audioGainDb}dB`);
    args.push('-c:v', 'libx264', '-preset', 'ultrafast', ...(t ? [] : ['-tune', 'stillimage']), '-crf', '20', '-r', '25', '-g', '50', '-keyint_min', '50', '-sc_threshold', '0',
      '-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-ar', '48000', '-sn', '-dn');
    return args;
  }

  /** Commercials from the channel's bundles, as many as it asks for that fit before `next` starts. */
  async playBreak(next) {
    const channel = store.getChannel(this.channelId);
    const count = perBreak(channel);
    if (!count) return;
    const recent = [...(recentAds.get(this.channelId) || [])];
    const clips = pickBreak(clipsFor(channel), count, (next.start - this.clock()) / 1000 - 1, recent);
    if (!clips.length) return;
    prepareStream(next, channel).catch(() => {}); // have the next program ready when the break ends
    this.setStatus({ state: 'break', item: { ...next, label: itemLabel(next) }, stream: null, message: `Commercial break before ${itemLabel(next)}` });
    log.info(`channel ${channel.number}: commercial break before ${itemLabel(next)}: ${clips.map((c) => `${c.bundle}/${c.file}`).join(', ')}`);
    for (const clip of clips) {
      if (this.stopped || this.skipRequested) break;
      const left = (next.start - this.clock()) / 1000;
      if (left < 3) break;
      const file = readyFile(clip);
      if (!fs.existsSync(file)) continue; // deleted while we were deciding
      recent.push(clip.id);
      recentAds.set(this.channelId, recent.slice(-12));
      const target = this.leadTarget(null);
      const burst = Math.max(4, Math.min(target, target - this.leadSeconds()));
      const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-readrate', '1'];
      if (this.capsBurst) args.push('-readrate_initial_burst', String(Math.round(burst)));
      // Clips were converted at ingest, so they copy straight in.
      args.push('-i', file, '-t', Math.min(clip.duration, left).toFixed(2), '-map', '0:v:0', '-map', '0:a:0', '-c', 'copy', '-sn', '-dn');
      await this.runFfmpeg(args);
    }
    // A skip during the break ends the break; it isn't meant for the program after it.
    this.skipRequested = false;
  }

  /**
   * drawtext for the "Up next" box, appearing `from` seconds into the run, with whatever follows `item` in the
   * guide as it stands now. Null when nothing follows it.
   */
  upNextOverlay(item, channel, info, from) {
    const next = store.epgAfter(this.channelId, item.start);
    if (!next) return null;
    const later = store.epgAfter(this.channelId, next.start);
    const textFile = path.join(this.dir, `upnext-${this.program + 1}.txt`);
    fs.writeFileSync(textFile, upNextText(next, later, { label: itemLabel, timeZone: store.getSettings().timezone }));
    // Re-encoded video is at most 1080p (see mainArgs).
    return upNextFilter({ textFile, font: upNextFont, height: Math.min(1080, info.video?.height || 1080), from });
  }

  mainArgs(cand, info, channel, offset, limit, subs, { transcode = false, burst = 20, overlay = null } = {}) {
    const opts = channel.options || {};
    const audioIdx = pickAudio(info.audio, opts.audioLanguage);
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
    args.push(...headerArgs(cand.headers));
    // A read that hangs for 20s counts as a network error, so ffmpeg reconnects instead of waiting forever.
    args.push('-rw_timeout', '20000000', '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_on_network_error', '1',
      '-reconnect_on_http_error', '5xx', '-reconnect_delay_max', '5');
    if (offset > 1) args.push('-ss', offset.toFixed(2));
    args.push('-readrate', '1');
    if (this.capsBurst) args.push('-readrate_initial_burst', String(Math.round(burst)));
    args.push('-i', cand.url, '-t', limit.toFixed(2));
    if (subs?.delivery === 'burn') {
      // Image subtitles: overlay them and re-encode, with a keyframe every 2s so segments stay on size.
      const graph = burnFilter(info.video || {}, subs.stream, subs.index);
      args.push('-filter_complex', overlay ? graph.replace(/\[vout\]$/, `,${overlay}[vout]`) : graph, '-map', '[vout]');
      args.push('-c:v', 'libx264', '-preset', BURN_PRESET, '-crf', '21', '-maxrate', '10M', '-bufsize', '20M',
        '-force_key_frames', 'expr:gte(t,n_forced*2)', '-sc_threshold', '0');
    } else if (transcode || overlay) {
      // Files that won't remux (or to draw the "Up next" box): plain H.264, at most 1080p.
      args.push('-map', '0:v:0', '-vf', `scale=-2:'min(1080,ih)',format=yuv420p${overlay ? `,${overlay}` : ''}`);
      args.push('-c:v', 'libx264', '-preset', BURN_PRESET, '-crf', '21', '-maxrate', '10M', '-bufsize', '20M',
        '-force_key_frames', 'expr:gte(t,n_forced*2)', '-sc_threshold', '0');
    } else {
      args.push('-map', '0:v:0', '-c:v', 'copy');
    }
    if (audioIdx != null) args.push('-map', `0:a:${audioIdx}`);
    if (audioIdx != null) {
      const a = info.audio[audioIdx];
      if (opts.audio === 'copy' || (a.codec_name === 'aac' && (a.channels || 2) <= 2)) args.push('-c:a', 'copy');
      else args.push('-c:a', 'aac', '-b:a', '192k', '-ac', '2');
    }
    // Text subtitles ride along as a WebVTT track, cut in step with the video segments.
    if (subs?.delivery === 'vtt') args.push('-map', `0:s:${subs.index}`, '-c:s', 'webvtt');
    else args.push('-sn');
    args.push('-dn', '-max_muxing_queue_size', '2048');
    return args;
  }

  async playSlate(title, subtitle, seconds) {
    const c = await ffmpegCaps();
    const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, '’').replace(/:/g, '\\:').replace(/%/g, '\\%');
    let vf = null;
    if (c.drawtext && slateFont) {
      const font = slateFont.replace(/\\/g, '/').replace(/:/g, '\\:');
      vf = `drawtext=fontfile='${font}':text='${esc(title)}':fontcolor=white:fontsize=40:x=(w-tw)/2:y=h/2-50,` +
        `drawtext=fontfile='${font}':text='${esc(subtitle)}':fontcolor=0xA0A8B8:fontsize=26:x=(w-tw)/2:y=h/2+20`;
    }
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-re',
      '-f', 'lavfi', '-i', 'color=c=0x111827:s=1280x720:r=25',
      '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
      '-t', String(Math.max(4, Math.round(seconds)))];
    if (vf) args.push('-vf', vf);
    args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'stillimage', '-g', '50', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '64k');
    await this.runFfmpeg(args);
  }

  /** Runs one ffmpeg program into its own HLS playlist and folds its segments into the channel playlist. */
  runFfmpeg(inputArgs, { vtt = false, maxSegment = 0, env = null } = {}) {
    const n = ++this.program;
    // The trailing "_" matters: ffmpeg names WebVTT segments "<playlist name><index>.vtt", i.e. p3_0.vtt.
    const playlist = path.join(this.dir, `p${n}_.m3u8`);
    this.programs.set(n, { vtt });
    // With maxSegment, ffmpeg also reports its progress, so a segment that stays open too long can be told
    // apart from a hung source (ffmpeg keeps the open segment in memory, so its file doesn't grow).
    const args = [...(maxSegment ? ['-progress', 'pipe:2', '-stats_period', '1'] : []), ...inputArgs, '-output_ts_offset', this.contentTotal.toFixed(3),
      '-f', 'hls', '-hls_time', String(SEGMENT_SECONDS), '-hls_list_size', '0', '-hls_segment_type', 'mpegts',
      '-hls_segment_filename', path.join(this.dir, `p${n}_%05d.ts`), playlist];
    log.debug('ffmpeg', args.join(' '));
    return new Promise((resolve) => {
      const proc = spawn(config.ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'], env: env ? { ...process.env, ...env } : process.env });
      this.proc = proc;
      let stderr = '';
      let seen = 0;
      let seconds = 0;
      let firstOfProgram = true;
      let longSegment = 0; // length of a segment over maxSegment; ffmpeg is stopped there
      let longIndex = 0;
      let outTime = -1; // ffmpeg's output position (progress reports), and when it last moved
      let movedAt = Date.now();
      let partial = '';
      proc.stderr.on('data', (d) => {
        const lines = (partial + d).split('\n');
        partial = lines.pop();
        for (const line of lines) {
          const t = line.match(/^out_time_us=(\d+)/);
          if (t) {
            if (Number(t[1]) > outTime) { outTime = Number(t[1]); movedAt = Date.now(); }
          } else if (!/^\w+=\S*\s*$/.test(line)) {
            stderr = (stderr + line + '\n').slice(-4000);
          }
        }
      });
      const ingest = () => {
        if (this.cancelled.has(n) || longSegment) return;
        let text;
        try { text = fs.readFileSync(playlist, 'utf8'); } catch { return; }
        const lines = text.split(/\r?\n/);
        const found = [];
        for (let i = 0; i < lines.length; i++) {
          const m = lines[i].match(/^#EXTINF:([\d.]+)/);
          if (m && lines[i + 1] && !lines[i + 1].startsWith('#')) found.push({ duration: Number(m[1]), name: lines[i + 1].trim() });
        }
        for (const seg of found.slice(seen)) {
          const index = Number(seg.name.match(/_(\d+)\.ts$/)?.[1] ?? 0);
          if (maxSegment && seg.duration > maxSegment) {
            // Never published (and never stretches the playlist's target duration): the caller re-encodes from
            // here, and this segment and anything after it is deleted once ffmpeg has stopped.
            longSegment = seg.duration;
            longIndex = index;
            proc.kill('SIGKILL');
            break;
          }
          // The channel's timeline starts when its first video exists, not when it began looking for it: time
          // spent connecting and seeking would otherwise come out of the players' cushion.
          if (!this.anchored) {
            this.anchored = true;
            this.timeBase = Date.now() - this.contentTotal * 1000;
          }
          this.segments.push({ ...seg, program: n, index, seq: this.nextSeq++, disc: firstOfProgram && this.segments.length > 0, contentStart: this.contentTotal });
          this.contentTotal += seg.duration;
          seconds += seg.duration;
          this.maxTarget = Math.max(this.maxTarget, Math.ceil(seg.duration));
          firstOfProgram = false;
        }
        seen = Math.max(seen, found.length);
        if (seen) this.resolveWaiters();
        this.pruneFiles();
      };
      // Watchdog: segments arrive at least every few seconds while ffmpeg works. If none has for 45s the source
      // has hung; kill ffmpeg so playback picks up again from the last delivered second.
      let lastNew = Date.now();
      let seenAtCheck = 0;
      const poll = setInterval(() => {
        ingest();
        if (seen !== seenAtCheck) { seenAtCheck = seen; lastNew = Date.now(); return; }
        // Still on the same segment well past maxSegment while the source keeps flowing (not hung): the next
        // keyframe is too far off. Treat it like a long segment now rather than wait for the hang check.
        if (maxSegment && !longSegment && !proc.killed && Date.now() - lastNew > (maxSegment + 10) * 1000 && Date.now() - movedAt < 5000) {
          longSegment = (Date.now() - lastNew) / 1000;
          longIndex = seen;
          proc.kill('SIGKILL');
          return;
        }
        if (Date.now() - lastNew > 45000 && !proc.killed) {
          log.warn(`channel ${this.channelId}: no new video for 45s, restarting the stream`);
          proc.kill('SIGKILL');
        }
      }, 1000);
      proc.on('error', (e) => { stderr += e.message; });
      proc.on('close', (code) => {
        clearInterval(poll);
        ingest();
        if (this.proc === proc) this.proc = null;
        if (longSegment) {
          for (const f of fs.readdirSync(this.dir)) {
            const m = f.match(new RegExp(`^p${n}_(\\d+)\\.(?:ts|vtt)$`));
            if (m && Number(m[1]) >= longIndex) fs.rm(path.join(this.dir, f), { force: true }, () => {});
          }
        } else if (code !== 0 && !this.stopped) {
          log.warn(`ffmpeg exited ${code} on channel ${this.channelId}: ${stderr.trim().split('\n').slice(-3).join(' | ')}`);
        }
        resolve({ code, segments: seen, seconds, longSegment });
      });
    });
  }

  /** Delete segments that have scrolled out of the published window (the unpublished buffer is kept). */
  pruneFiles() {
    const cut = this.visibleCount() - WINDOW - 3;
    if (cut <= 0) return;
    for (const seg of this.segments.slice(0, cut)) this.deleteSegmentFiles(seg);
    // Drop bookkeeping for long-gone segments, but remember discontinuities for the sequence counter.
    if (cut > 400) {
      const drop = this.segments.splice(0, cut - 100);
      this.visible -= drop.length;
      this.droppedDisc = (this.droppedDisc || 0) + drop.filter((s) => s.disc).length;
    }
  }

  resolveWaiters() {
    const w = this.waiters;
    this.waiters = [];
    w.forEach((fn) => fn());
  }

  /** Wait until enough segments exist for a player to start. */
  async waitReady(minSegments = 2, timeoutMs = 45000) {
    const until = Date.now() + timeoutMs;
    while (this.visibleCount() < minSegments && !this.stopped && Date.now() < until) {
      await Promise.race([new Promise((r) => this.waiters.push(r)), sleep(1000)]);
    }
    return this.visibleCount() > 0;
  }

  /**
   * Live media playlist. The subtitle playlist mirrors the video one segment for segment (same sequence
   * numbers, durations and discontinuities); programs without a text track just get empty cues.
   */
  playlist(kind = 'video') {
    const published = this.segments.slice(0, this.visibleCount());
    const win = published.slice(-WINDOW);
    const discBefore = (this.droppedDisc || 0) + published.slice(0, published.length - win.length).filter((s) => s.disc).length;
    const target = this.maxTarget; // never shrinks: players expect it to stay put
    const out = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${target}`,
      `#EXT-X-MEDIA-SEQUENCE:${win[0]?.seq ?? 0}`, `#EXT-X-DISCONTINUITY-SEQUENCE:${discBefore}`];
    for (const s of win) {
      if (s.disc) out.push('#EXT-X-DISCONTINUITY');
      out.push(`#EXTINF:${s.duration.toFixed(3)},`, kind === 'subs' ? `sub/p${s.program}_${s.index}.vtt` : s.name);
    }
    return out.join('\n') + '\n';
  }

  /** WebVTT for one segment, with the timestamp map players need to line cues up with the video. */
  async subtitleSegment(name) {
    const m = name.match(/^p(\d+)_(\d+)\.vtt$/);
    const prog = m && this.programs.get(Number(m[1]));
    if (!prog?.vtt) return EMPTY_VTT;
    let text;
    try {
      text = await fs.promises.readFile(path.join(this.dir, `p${m[1]}_${Number(m[2])}.vtt`), 'utf8');
    } catch {
      return EMPTY_VTT;
    }
    const body = text.replace(/^\uFEFF?WEBVTT[^\n]*\n(X-TIMESTAMP-MAP[^\n]*\n)?/, '');
    return `WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:${VTT_MPEGTS_ZERO},LOCAL:00:00:00.000\n${body}`;
  }

  segmentPath(name) {
    if (!/^p\d+_\d+\.ts$/.test(name)) return null;
    return path.join(this.dir, name);
  }
}

// ---------------------------------------------------------------------------

const runners = new Map();

export async function getRunner(channelId) {
  const id = Number(channelId);
  let r = runners.get(id);
  if (!r || r.stopped) {
    const c = await ffmpegCaps();
    if (!c.ok) throw new Error(`ffmpeg not available: ${c.error}`);
    // Another request may have started the channel while we awaited.
    r = runners.get(id);
    if (r && !r.stopped) {
      r.touch();
      return r;
    }
    r = new ChannelRunner(id);
    r.capsBurst = c.burst;
    runners.set(id, r);
    log.info(`channel ${id}: tuning in`);
  }
  r.touch();
  return r;
}

export function peekRunner(channelId) {
  return runners.get(Number(channelId));
}

/**
 * Wall time up to which a running channel has published video: what viewers will see before anything changed
 * now can reach them. Null when the channel isn't running.
 */
export function publishedEdge(channelId) {
  const r = runners.get(Number(channelId));
  if (!r || r.stopped || r.timeBase == null) return null;
  const n = r.visibleCount();
  const last = r.segments[n - 1];
  return last ? r.timeBase + (last.contentStart + last.duration) * 1000 : Date.now();
}

/** Cut a playing channel over to what the guide now says is on (after the current item was replaced). */
export function interruptRunner(channelId) {
  const r = runners.get(Number(channelId));
  if (!r || r.stopped) return false;
  r.skipRequested = true;
  if (r.proc) {
    r.cancelled.add(r.program);
    r.proc.kill('SIGKILL');
  }
  r.dropUnpublished(); // the buffered rest of the skipped program never airs
  return true;
}

export function stopRunner(channelId) {
  const r = runners.get(Number(channelId));
  if (r) { r.stop(); runners.delete(Number(channelId)); }
}

export function runnerStatus() {
  return [...runners.values()].map((r) => ({ channelId: r.channelId, ...r.status, viewers: r.activeViewers(), buffered: Math.max(0, Math.round(r.leadSeconds())), idleFor: Date.now() - r.lastAccess }));
}

// ---------------------------------------------------------------------------
// One stream per viewer IP: tuning in to a channel releases the one that IP was watching before,
// so channel surfing never leaves ffmpeg processes and debrid connections running behind you.

const tunedTo = new Map(); // viewer ip -> channel id it last tuned in to

export function tuneIn(ip, channelId) {
  const id = Number(channelId);
  const prev = tunedTo.get(ip);
  tunedTo.set(ip, id);
  runners.get(id)?.touch(ip);
  if (prev === undefined || prev === id || !store.getSettings().oneStreamPerIp) return;
  const old = runners.get(prev);
  if (!old) return;
  old.viewers.delete(ip);
  if (!old.activeViewers().length) {
    log.info(`channel ${prev}: ${ip} switched to channel ${id}, stopping`);
    stopRunner(prev);
    forgetState(prev);
  }
}

/** The channel stopped because nobody is watching: a later restart needn't carry on where it was. */
function forgetState(channelId) {
  try { store.run('DELETE FROM playout_state WHERE channel_id = ?', Number(channelId)); } catch { /* best effort */ }
}

/** False once this viewer has tuned in to a different channel (when the cap is on). */
export function mayWatch(ip, channelId) {
  if (!store.getSettings().oneStreamPerIp) return true;
  const t = tunedTo.get(ip);
  return t === undefined || t === Number(channelId);
}

export function startReaper() {
  // Clear leftovers from a previous run (only our own ch* folders, in case HLS_DIR is shared).
  fs.mkdirSync(config.hlsDir, { recursive: true });
  for (const d of fs.readdirSync(config.hlsDir)) {
    if (/^ch\d+-[a-z0-9]+$/.test(d)) fs.rmSync(path.join(config.hlsDir, d), { recursive: true, force: true });
  }
  try { store.run('DELETE FROM playout_state WHERE updated_at < ?', Date.now() - STATE_MAX_AGE_MS); } catch { /* best effort */ }
  const t = setInterval(() => {
    for (const [id, r] of runners) {
      if (Date.now() - r.lastAccess > config.idleSeconds * 1000) {
        log.info(`channel ${id}: no viewers, stopping`);
        r.stop();
        runners.delete(id);
        forgetState(id);
      }
    }
  }, 10000);
  t.unref?.();
}
