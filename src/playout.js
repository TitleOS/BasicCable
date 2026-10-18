import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { config, log } from './config.js';
import { store } from './db.js';
import { headerArgs } from './probe.js';
import { prepareStream, dropPrepared, skipUnplayable, preparedFor } from './prefetch.js';
import { buildChannel, itemLabel } from './scheduler.js';
import { subtitlePlan, burnFilter } from './subtitles.js';

// Read-ahead: ffmpeg reads up to READ_AHEAD_SECONDS ahead of real time, but each segment only appears in the
// live playlist when its moment in the schedule arrives. Viewers stay on real time and in step with the guide,
// while a slow or stalled debrid read drains the server's buffer instead of their screen.
//
// 6s segments: players start ~3 segments behind the live edge (~18s of their own cushion). The playlist lists
// ~60s, so a player that stalls carries on where it was instead of being pushed out of the window.
const SEGMENT_SECONDS = 6;
const WINDOW = 10; // segments listed in the live playlist
const PREROLL_SECONDS = 18; // published straight away on tune-in, so players can start
const EARLY_FAIL_SECONDS = 15; // ffmpeg dying before producing this much video means the file is the problem
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BURN_PRESET = process.env.SUBTITLE_BURN_PRESET || 'veryfast';
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

class ChannelRunner {
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
    while (!this.stopped) {
      const now = this.clock();
      let item = store.epgAt(this.channelId, now);
      if (item && lastItem && item.id === lastItem.id) item = store.epgAfter(this.channelId, lastItem.start);
      if (!item) {
        buildChannel(this.channelId).catch(() => {});
        this.setStatus({ state: 'offair', item: null, stream: null, message: 'Nothing scheduled' });
        await this.playSlate('Nothing scheduled on this channel', 'Add shows in the StreamTube web interface', 30);
        continue;
      }
      if (item.id !== failItem) { failItem = item.id; fails = 0; }
      const result = await this.playItem(item);
      if (this.stopped) break;
      if (result === 'done') { lastItem = item; continue; }
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

  async playItem(item) {
    const channel = store.getChannel(this.channelId);
    if (!channel) { this.stop(); return 'failed'; }
    this.setStatus({ state: 'resolving', item: { ...item, label: itemLabel(item) }, stream: null, message: '' });

    // Normally the prefetcher has already picked and probed a file, so this returns at once.
    const t0 = Date.now();
    const prepare = async () => {
      try {
        return await prepareStream(item, channel);
      } catch (e) {
        this.setStatus({ state: 'error', message: e.message });
        log.warn(`channel ${channel.number}: ${e.message}`);
        return undefined;
      }
    };
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

    // Warm up whatever comes next so the hand-over is quick.
    const next = store.epgAfter(this.channelId, item.start);
    if (next) prepareStream(next, channel).catch(() => {});

    let transcode = false;
    for (let attempt = 0; prep && attempt < 6; attempt++) {
      if (this.stopped) return 'done';
      const { cand, info } = prep;
      // Normally the live position. After a mid-program drop, where it stopped (nothing gets skipped; the end is
      // trimmed instead). An item that starts early (the previous file ran short) plays from 0 and may run past
      // its slot until its scheduled end.
      const resumeAt = this.resume?.itemId === item.id ? this.resume.at : null;
      const pos = this.clock(); // where the channel's timeline is: up to READ_AHEAD_SECONDS past now
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
      log.info(`channel ${channel.number}: ${resumeAt != null ? 'resuming' : 'playing'} ${itemLabel(item)} from ${Math.round(startAt)}s @ ${info.video?.height || '?'}p` +
        (transcode ? ', re-encoding video' : '') +
        (subs ? `, subtitles ${subs.delivery === 'vtt' ? 'as a track' : 'burned in'} (${subs.stream.codec_name}${subs.sdh ? ', SDH' : ''})` : '') +
        (attempt === 0 ? (waited < 200 ? ', stream was prepared ahead' : `, stream picked in ${(waited / 1000).toFixed(1)}s`) : ''));
      if (this.skipRequested) {
        // Skipped while we were still getting the stream ready.
        this.skipRequested = false;
        return 'skipped';
      }
      const produced = await this.runFfmpeg(this.mainArgs(cand, info, channel, startAt, limit, subs, { transcode, burst }), { vtt: subs?.delivery === 'vtt' });
      if (this.stopped) return 'done';
      if (this.skipRequested) {
        // Someone skipped this program; the guide already has its replacement.
        this.skipRequested = false;
        this.resume = null;
        return 'skipped';
      }
      // ffmpeg also exits cleanly when a debrid link dies (it sees an early end of file), so only call it
      // finished if it got to the end of the file or of the slot.
      const end = Math.min(info.duration || Infinity, startAt + limit);
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

  mainArgs(cand, info, channel, offset, limit, subs, { transcode = false, burst = 20 } = {}) {
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
      args.push('-filter_complex', burnFilter(info.video || {}, subs.stream, subs.index), '-map', '[vout]');
      args.push('-c:v', 'libx264', '-preset', BURN_PRESET, '-crf', '21', '-maxrate', '10M', '-bufsize', '20M',
        '-force_key_frames', 'expr:gte(t,n_forced*2)', '-sc_threshold', '0');
    } else if (transcode) {
      // Fallback for files that won't remux: plain H.264, at most 1080p.
      args.push('-map', '0:v:0', '-vf', "scale=-2:'min(1080,ih)',format=yuv420p");
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
  runFfmpeg(inputArgs, { vtt = false } = {}) {
    const n = ++this.program;
    // The trailing "_" matters: ffmpeg names WebVTT segments "<playlist name><index>.vtt", i.e. p3_0.vtt.
    const playlist = path.join(this.dir, `p${n}_.m3u8`);
    this.programs.set(n, { vtt });
    const args = [...inputArgs, '-output_ts_offset', this.contentTotal.toFixed(3),
      '-f', 'hls', '-hls_time', String(SEGMENT_SECONDS), '-hls_list_size', '0', '-hls_segment_type', 'mpegts',
      '-hls_segment_filename', path.join(this.dir, `p${n}_%05d.ts`), playlist];
    log.debug('ffmpeg', args.join(' '));
    return new Promise((resolve) => {
      const proc = spawn(config.ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      this.proc = proc;
      let stderr = '';
      let seen = 0;
      let seconds = 0;
      let firstOfProgram = true;
      proc.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
      const ingest = () => {
        if (this.cancelled.has(n)) return;
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
        if (seen !== seenAtCheck) { seenAtCheck = seen; lastNew = Date.now(); }
        else if (Date.now() - lastNew > 45000 && !proc.killed) {
          log.warn(`channel ${this.channelId}: no new video for 45s, restarting the stream`);
          proc.kill('SIGKILL');
        }
      }, 1000);
      proc.on('error', (e) => { stderr += e.message; });
      proc.on('close', (code) => {
        clearInterval(poll);
        ingest();
        if (this.proc === proc) this.proc = null;
        if (code !== 0 && !this.stopped) log.warn(`ffmpeg exited ${code} on channel ${this.channelId}: ${stderr.trim().split('\n').slice(-3).join(' | ')}`);
        resolve({ code, segments: seen, seconds });
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
  }
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
  const t = setInterval(() => {
    for (const [id, r] of runners) {
      if (Date.now() - r.lastAccess > config.idleSeconds * 1000) {
        log.info(`channel ${id}: no viewers, stopping`);
        r.stop();
        runners.delete(id);
      }
    }
  }, 10000);
  t.unref?.();
}
