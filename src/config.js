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
  timezone: env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  // How far ahead the guide is materialized.
  horizonHours: Number(env.GUIDE_HOURS || 48),
  // Stop a channel's ffmpeg after nobody has requested its playlist for this long.
  idleSeconds: Number(env.IDLE_SECONDS || 60),
  logLevel: env.LOG_LEVEL || 'info',
};

const levels = { debug: 10, info: 20, warn: 30, error: 40 };
function logAt(level, args) {
  if (levels[level] < (levels[config.logLevel] ?? 20)) return;
  const ts = new Date().toISOString();
  (level === 'error' ? console.error : console.log)(`${ts} ${level.toUpperCase().padEnd(5)}`, ...args);
}
export const log = {
  debug: (...a) => logAt('debug', a),
  info: (...a) => logAt('info', a),
  warn: (...a) => logAt('warn', a),
  error: (...a) => logAt('error', a),
};
