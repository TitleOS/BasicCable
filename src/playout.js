import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { config, log } from './config.js';
import { store } from './db.js';
import { findStreams, forgetStream } from './picker.js';
import { buildChannel, itemLabel } from './scheduler.js';
import { subtitlePlan, burnFilter } from './subtitles.js';

const WINDOW = 6; // segments listed in the live playlist
const KEEP_FILES = 30; // segment files kept on disk per channel
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BURN_PRESET = process.env.SUBTITLE_BURN_PRESET || 'veryfast';
const EMPTY_VTT = 'WEBVTT\n\n';

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

function headerArgs(headers) {
  if (!headers || !Object.keys(headers).length) return [];
  return ['-headers', Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('')];
}

/** ffprobe a remote file: duration plus audio tracks. Also our "does this debrid link work" check. */
export function probe(url, headers) {
  return new Promise((resolve) => {
    const args = ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-rw_timeout', '20000000', ...headerArgs(headers), url];
    execFile(config.ffprobe, args, { timeout: 30000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        const j = JSON.parse(stdout);
        const streams = j.streams || [];
        if (!streams.some((s) => s.codec_type === 'video')) return resolve(null);
        resolve({
          duration: Number(j.format?.duration) || null,
          video: streams.find((s) => s.codec_type === 'video'),
          audio: streams.filter((s) => s.codec_type === 'audio'),
          subtitles: streams.filter((s) => s.codec_type === 'subtitle'),
        });
      } catch {
        resolve(null);
      }
    });
  });
}

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
    this.programs = new Map(); // program number -> { vtt: bool, firstPts: Promise<number> }
    this.nextSeq = 0;
    this.program = 0;
    this.lastAccess = Date.now();
    this.stopped = false;
    this.proc = null;
    this.status = { state: 'starting', item: null, stream: null, since: Date.now(), message: '' };
    this.waiters = [];
    this.loop = this.run().catch((e) => log.error(`runner ${this.channelId} crashed:`, e));
  }

  touch() { this.lastAccess = Date.now(); }

  stop() {
    this.stopped = true;
    if (this.proc) this.proc.kill('SIGKILL');
    this.resolveWaiters();
    setTimeout(() => fs.rm(this.dir, { recursive: true, force: true }, () => {}), 2000);
  }

  setStatus(s) { this.status = { ...this.status, ...s, since: Date.now() }; }

  async run() {
    let lastItem = null;
    let fails = 0;
    let failItem = null;
    while (!this.stopped) {
      const now = Date.now();
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
      fails++;
      if (result === 'retry' && fails <= 3) continue; // link dropped mid-item: rejoin at the live offset
      // Keep the channel alive with a slate, retrying every minute, giving up on the item after a few tries.
      const remaining = item.end - Date.now();
      const slateMs = fails > 3 ? remaining : Math.min(remaining, 60000);
      if (slateMs > 3000) await this.playSlate(`Couldn't play ${itemLabel(item)}`, this.status.message || 'No working stream found', slateMs / 1000);
      if (fails > 3) lastItem = item;
    }
  }

  async playItem(item) {
    const channel = store.getChannel(this.channelId);
    if (!channel) { this.stop(); return 'failed'; }
    this.setStatus({ state: 'resolving', item: { ...item, label: itemLabel(item) }, stream: null, message: '' });

    let candidates;
    try {
      candidates = await findStreams(item, channel);
    } catch (e) {
      this.setStatus({ state: 'error', message: e.message });
      log.warn(`channel ${channel.number}: ${e.message}`);
      return 'failed';
    }
    if (!candidates.length) {
      this.setStatus({ state: 'error', message: 'No cached debrid stream found' });
      return 'failed';
    }

    // Warm the cache for whatever comes next so the hand-over is quick.
    const next = store.epgAfter(this.channelId, item.start);
    if (next) findStreams(next, channel).catch(() => {});

    for (const cand of candidates.slice(0, 5)) {
      if (this.stopped) return 'done';
      const info = await probe(cand.url, cand.headers);
      if (!info) {
        log.info(`channel ${channel.number}: stream did not probe, trying next (${cand.label.slice(0, 80)})`);
        forgetStream(item, channel, cand.url);
        continue;
      }
      if (info.duration && info.duration < 90 && item.end - item.start > 5 * 60000) {
        // Debrid "downloading" placeholder clips are short; skip them.
        forgetStream(item, channel, cand.url);
        continue;
      }
      // Resolving and probing took a while; compute the live position now. An item that starts early
      // (the previous file ran short) plays from 0 and may run past its slot until its scheduled end.
      const startAt = Math.max(0, (Date.now() - item.start) / 1000);
      const limit = Math.max(5, (item.end - Date.now()) / 1000);
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
      log.info(`channel ${channel.number}: playing ${itemLabel(item)} from ${Math.round(startAt)}s @ ${info.video?.height || '?'}p` +
        (subs ? `, subtitles ${subs.delivery === 'vtt' ? 'as a track' : 'burned in'} (${subs.stream.codec_name}${subs.sdh ? ', SDH' : ''})` : ''));
      const produced = await this.runFfmpeg(this.mainArgs(cand, info, channel, startAt, limit, subs), { vtt: subs?.delivery === 'vtt' });
      if (this.stopped) return 'done';
      if (produced.code === 0) return 'done';
      if (produced.segments > 0) return 'retry';
      forgetStream(item, channel, cand.url);
    }
    this.setStatus({ state: 'error', message: 'Every candidate stream failed to play' });
    return 'failed';
  }

  mainArgs(cand, info, channel, offset, limit, subs) {
    const opts = channel.options || {};
    const audioIdx = pickAudio(info.audio, opts.audioLanguage);
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
    args.push(...headerArgs(cand.headers));
    args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5');
    if (offset > 1) args.push('-ss', offset.toFixed(2));
    args.push('-readrate', '1');
    if (this.capsBurst) args.push('-readrate_initial_burst', '10');
    args.push('-i', cand.url, '-t', limit.toFixed(2));
    if (subs?.delivery === 'burn') {
      // Image subtitles: overlay them and re-encode, with a keyframe every 2s so segments stay ~4s.
      args.push('-filter_complex', burnFilter(info.video || {}, subs.stream, subs.index), '-map', '[vout]');
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
    const args = [...inputArgs,
      '-f', 'hls', '-hls_time', '4', '-hls_list_size', '0', '-hls_segment_type', 'mpegts',
      '-hls_segment_filename', path.join(this.dir, `p${n}_%05d.ts`), playlist];
    log.debug('ffmpeg', args.join(' '));
    return new Promise((resolve) => {
      const proc = spawn(config.ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      this.proc = proc;
      let stderr = '';
      let seen = 0;
      let firstOfProgram = true;
      proc.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
      const ingest = () => {
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
          this.segments.push({ ...seg, program: n, index, seq: this.nextSeq++, disc: firstOfProgram && this.segments.length > 0 });
          firstOfProgram = false;
        }
        seen = Math.max(seen, found.length);
        if (seen) this.resolveWaiters();
        this.pruneFiles();
      };
      const poll = setInterval(ingest, 1000);
      proc.on('error', (e) => { stderr += e.message; });
      proc.on('close', (code) => {
        clearInterval(poll);
        ingest();
        if (this.proc === proc) this.proc = null;
        if (code !== 0 && !this.stopped) log.warn(`ffmpeg exited ${code} on channel ${this.channelId}: ${stderr.trim().split('\n').slice(-3).join(' | ')}`);
        resolve({ code, segments: seen });
      });
    });
  }

  pruneFiles() {
    const keep = this.segments.length - KEEP_FILES;
    if (keep <= 0) return;
    for (const seg of this.segments.slice(0, keep)) {
      if (seg.deleted) continue;
      seg.deleted = true;
      fs.rm(path.join(this.dir, seg.name), { force: true }, () => {});
      if (this.programs.get(seg.program)?.vtt) fs.rm(path.join(this.dir, `p${seg.program}_${seg.index}.vtt`), { force: true }, () => {});
    }
    // Drop bookkeeping for long-gone segments, but remember discontinuities for the sequence counter.
    if (this.segments.length > 500) {
      const drop = this.segments.splice(0, this.segments.length - 200);
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
    while (this.segments.length < minSegments && !this.stopped && Date.now() < until) {
      await Promise.race([new Promise((r) => this.waiters.push(r)), sleep(1000)]);
    }
    return this.segments.length > 0;
  }

  /**
   * Live media playlist. The subtitle playlist mirrors the video one segment for segment (same sequence
   * numbers, durations and discontinuities); programs without a text track just get empty cues.
   */
  playlist(kind = 'video') {
    const win = this.segments.slice(-WINDOW);
    const discBefore = (this.droppedDisc || 0) + this.segments.slice(0, this.segments.length - win.length).filter((s) => s.disc).length;
    const target = Math.max(4, ...win.map((s) => Math.ceil(s.duration)));
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
    const pts = await this.programStartPts(Number(m[1]));
    const body = text.replace(/^\uFEFF?WEBVTT[^\n]*\n(X-TIMESTAMP-MAP[^\n]*\n)?/, '');
    return `WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:${pts},LOCAL:00:00:00.000\n${body}`;
  }

  /** MPEG-TS timestamp (90 kHz) where a program's WebVTT time zero lands, read from its first segment. */
  programStartPts(n) {
    const prog = this.programs.get(n);
    if (!prog.firstPts) {
      const first = path.join(this.dir, `p${n}_00000.ts`);
      prog.firstPts = new Promise((resolve) => {
        execFile(config.ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts,dts',
          '-read_intervals', '%+#1', '-of', 'json', first], { timeout: 10000 }, (err, stdout) => {
          let pts = 126000; // ffmpeg's MPEG-TS muxer starts at 1.4s by default
          try { pts = Number(JSON.parse(stdout).packets[0].dts) || pts; } catch { /* keep default */ }
          resolve(pts);
        });
      });
    }
    return prog.firstPts;
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

export function stopRunner(channelId) {
  const r = runners.get(Number(channelId));
  if (r) { r.stop(); runners.delete(Number(channelId)); }
}

export function runnerStatus() {
  return [...runners.values()].map((r) => ({ channelId: r.channelId, ...r.status, idleFor: Date.now() - r.lastAccess }));
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
