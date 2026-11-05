import path from 'node:path';
import os from 'node:os';

const env = process.env;

export const config = {
  port: Number(env.PORT || 7000),
  host: env.HOST || '0.0.0.0',
  // Public URL other devices on the LAN use to reach this container, e.g. http://192.168.1.50:7000.
  // When empty, it is derived from the Host header of each request (which is what Stremio used to install the addon).
  baseUrl: (env.BASE_URL || '').replace(/\/+$/, ''),
  dataDir: env.DATA_DIR || path.resolve('data'),
  hlsDir: env.HLS_DIR || path.join(os.tmpdir(), 'streamtube-hls'),
  ffmpeg: env.FFMPEG_PATH || 'ffmpeg',
  ffprobe: env.FFPROBE_PATH || 'ffprobe',
  adminPassword: env.ADMIN_PASSWORD || '',
  // Use X-Forwarded-For for viewer IPs (only when StreamTube sits behind your own reverse proxy).
  trustProxy: /^(1|true|yes)$/i.test(env.TRUST_PROXY || ''),
  timezone: env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  // How far ahead the guide is materialized.
  horizonHours: Number(env.GUIDE_HOURS || 48),
  // Stop a channel's ffmpeg after nobody has requested its playlist for this long.
  idleSeconds: Number(env.IDLE_SECONDS || 60),
  // How far ahead of real time each watched channel reads from debrid, as a buffer against slow reads. Capped
  // per channel at READ_AHEAD_MB of segments and at a quarter of the free space in HLS_DIR.
  readAheadSeconds: Number(env.READ_AHEAD_SECONDS ?? 120),
  readAheadMB: Number(env.READ_AHEAD_MB || 300),
  logLevel: env.LOG_LEVEL || 'info',
};

/**
 * Logs get pasted into bug reports, and stream addon URLs carry debrid keys in their path (as do debrid links,
 * which ffmpeg names in its errors). Keep each URL's host and drop the rest, plus any user:password@.
 */
export function redact(text) {
  return String(text).replace(/\b(https?:\/\/)(?:[^\s/?#@'"]*@)?([^\s/?#'"]+?)([/?#][^\s'"]*?)?([:;,.)\]]*)(?=[\s'"]|$)/gi,
    (_m, scheme, host, rest, tail) => `${scheme}${host}${rest ? '/…' : ''}${tail}`);
}

const levels = { debug: 10, info: 20, warn: 30, error: 40 };
function logAt(level, args) {
  if (levels[level] < (levels[config.logLevel] ?? 20)) return;
  const ts = new Date().toISOString();
  const safe = args.map((a) => (a instanceof Error ? redact(a.stack || a.message) : typeof a === 'string' ? redact(a) : a));
  (level === 'error' ? console.error : console.log)(`${ts} ${level.toUpperCase().padEnd(5)}`, ...safe);
}
export const log = {
  debug: (...a) => logAt('debug', a),
  info: (...a) => logAt('info', a),
  warn: (...a) => logAt('warn', a),
  error: (...a) => logAt('error', a),
};
