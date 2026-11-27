import { execFile } from 'node:child_process';
import { config } from './config.js';

export function headerArgs(headers) {
  if (!headers || !Object.keys(headers).length) return [];
  return ['-headers', Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('')];
}

/** "00:31:27.928000000" (Matroska's per-track DURATION tag) in seconds; null when it isn't one. */
function clockSeconds(t) {
  const m = /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(String(t ?? '').trim());
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}

function trackSeconds(s) {
  const tag = Object.entries(s.tags || {}).find(([k]) => /^duration(-|$)/i.test(k))?.[1];
  return Number(s.duration) || clockSeconds(tag);
}

/**
 * How long a file plays. The container's length, unless it runs well past every picture and sound track: a
 * subtitle track with a broken length tag stretches it (a Peacock release of The Office claimed 1193 hours
 * for a 31-minute episode, from its subtitle track alone). Then the longest picture or sound track counts.
 */
export function mediaDuration(format, streams) {
  const total = Number(format?.duration) || null;
  const tracks = (streams || []).filter((s) => s.codec_type === 'video' || s.codec_type === 'audio').map(trackSeconds).filter((n) => n > 0);
  if (!tracks.length) return total;
  const longest = Math.max(...tracks);
  return total && total <= longest + 60 ? total : longest;
}

/** ffprobe a remote file: duration plus its tracks. Also our "does this debrid link work" check. */
export function probe(url, headers) {
  return new Promise((resolve) => {
    const args = ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-rw_timeout', '20000000', ...headerArgs(headers), url];
    execFile(config.ffprobe, args, { timeout: 30000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        const j = JSON.parse(stdout);
        const streams = j.streams || [];
        if (!streams.some((s) => s.codec_type === 'video')) return resolve(null);
        const duration = mediaDuration(j.format, streams);
        const size = Number(j.format?.size);
        // A corrected length means the container's bit rate was worked out from the wrong one as well.
        const bitrate = duration !== (Number(j.format?.duration) || null) && size && duration
          ? size * 8 / duration
          : Number(j.format?.bit_rate) || (size && duration ? size * 8 / duration : null);
        resolve({
          container: j.format?.format_name || '',
          duration,
          bitrate,
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
