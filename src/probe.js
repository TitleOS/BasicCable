import { execFile } from 'node:child_process';
import { config } from './config.js';

export function headerArgs(headers) {
  if (!headers || !Object.keys(headers).length) return [];
  return ['-headers', Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('')];
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
