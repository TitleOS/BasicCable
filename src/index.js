import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, log } from './config.js';
import { Router, send, serveStatic, checkAuth, HttpError } from './http.js';
import { registerAddon } from './addon.js';
import { registerApi } from './api.js';
import { startScheduler } from './scheduler.js';
import { startReaper, ffmpegCaps, runnerStatus, stopRunner } from './playout.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const router = new Router();
registerAddon(router);
registerApi(router);
router.get('/health', (req, res) => send(res, 200, { ok: true }));

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://local');
  const pathname = url.pathname;
  // Log what clients ask for (Stremio, IPTV players), but not segment/health/UI noise.
  if (!/^\/(live\/[^/]+\/(p\d|sub\/|video\.m3u8|subs\.m3u8)|health|api\/|app\.js|style\.css|icon\.svg|logo\/)/.test(pathname) && pathname !== '/') {
    const t0 = Date.now();
    res.on('finish', () => log.info(`${req.method} ${req.url} ${res.statusCode} ${Date.now() - t0}ms · ${req.headers['user-agent'] || '-'}`));
  }
  if (req.method === 'OPTIONS') return send(res, 204, '');
  try {
    const m = router.match(req.method, pathname);
    if (m) {
      if (m.route.auth && !checkAuth(req)) {
        return send(res, 401, { error: 'Authentication required' }, { 'www-authenticate': 'Basic realm="StreamTube"' });
      }
      await m.route.handler(req, res, m.params);
      return;
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      const isUi = !pathname.startsWith('/api/');
      if (isUi && config.adminPassword && !checkAuth(req) && pathname !== '/icon.svg') {
        return send(res, 401, 'Authentication required', { 'www-authenticate': 'Basic realm="StreamTube"' });
      }
      if (serveStatic(publicDir, req, res, pathname)) return;
    }
    throw new HttpError(404, 'Not found');
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) log.error(`${req.method} ${pathname}:`, e);
    else log.debug(`${req.method} ${pathname}: ${status} ${e.message}`);
    send(res, status, { error: e.message });
  }
});

server.listen(config.port, config.host, async () => {
  const caps = await ffmpegCaps();
  log.info(`StreamTube listening on http://${config.host}:${config.port}`);
  log.info(`Data dir: ${config.dataDir} · timezone ${config.timezone}`);
  if (!caps.ok) log.error(`ffmpeg not found (${caps.error}); live playback will not work`);
  else log.info(`ffmpeg ${caps.version}${caps.burst ? '' : ' (no initial burst support, tuning in will be slower)'}`);
  startReaper();
  startScheduler();
});

function shutdown() {
  for (const r of runnerStatus()) stopRunner(r.channelId);
  server.close();
  setTimeout(() => process.exit(0), 500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
