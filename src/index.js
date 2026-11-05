import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, log } from './config.js';
import { Router, send, serveStatic, checkAuth, clientIp, sameOrigin, HttpError } from './http.js';
import { registerAddon } from './addon.js';
import { registerApi } from './api.js';
import { startScheduler } from './scheduler.js';
import { startReaper, ffmpegCaps, runnerStatus, stopRunner } from './playout.js';
import { startPrefetcher } from './prefetch.js';
import { mcpHandler } from './mcp.js';
import { repairGuide } from './repair.js';
import { prerenderArt } from './art.js';
import { startHistory } from './history.js';
import { startCommercials } from './commercials.js';
import { store } from './db.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const router = new Router();
registerAddon(router);
registerApi(router);
router.get('/health', (req, res) => send(res, 200, { ok: true }));

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://local');
  const pathname = url.pathname;
  // Log what clients ask for (Stremio, IPTV players), but not segment/health/UI noise unless it went wrong,
  // so a player hitting a missing segment or a refused request shows up.
  const noisy = /^\/(live\/[^/]+\/(p\d|sub\/|video\.m3u8|subs\.m3u8)|health|api\/|app\.js|style\.css|icon\.svg|logo\/)/.test(pathname) || pathname === '/';
  const t0 = Date.now();
  res.on('finish', () => {
    if (noisy && res.statusCode < 400) return;
    const line = `${req.method} ${req.url} ${res.statusCode} ${Date.now() - t0}ms · ${clientIp(req)} · ${req.headers['user-agent'] || '-'}`;
    if (res.statusCode >= 400) log.warn(line);
    else log.info(line);
  });
  // The admin API and MCP hold debrid keys and can change everything: only pages StreamTube served itself may
  // call them from a browser, so another website open on the same network can't read or drive them. Everything
  // else (the Stremio addon, live streams, playlists, art) is open to any origin, as Stremio Web and web
  // players need.
  const admin = pathname === '/mcp' || pathname.startsWith('/api/');
  if (admin && !sameOrigin(req)) return send(res, 403, { error: 'Origin not allowed' });
  if (!admin) {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', '*');
  }
  if (pathname === '/mcp') {
    // MCP endpoint for assistants (Claude Code etc.). Same password as the web UI when one is set.
    if (!checkAuth(req)) return send(res, 401, { error: 'Authentication required' }, { 'www-authenticate': 'Basic realm="StreamTube"' });
    return mcpHandler(req, res);
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
  if (['0.0.0.0', '::', ''].includes(config.host) && !config.adminPassword) {
    log.warn('Listening on all network interfaces with no ADMIN_PASSWORD: anyone who can reach this port can change ' +
      'channels and settings, including your stream addon URLs. Set ADMIN_PASSWORD. The Stremio addon and live ' +
      'streams stay open by design, so if you expose StreamTube to the internet, put it behind a reverse proxy ' +
      'that adds TLS and access control.');
  }
  log.info(`Data dir: ${config.dataDir} · timezone ${config.timezone}`);
  if (!caps.ok) log.error(`ffmpeg not found (${caps.error}); live playback will not work`);
  else log.info(`ffmpeg ${caps.version}${caps.burst ? '' : ' (no initial burst support, tuning in will be slower)'}`);
  startReaper();
  startHistory();
  startCommercials();
  startScheduler();
  startPrefetcher();
  // Clean up any guide items an older build stretched too far.
  setTimeout(() => repairGuide().catch((e) => log.error('guide repair failed:', e)), 3000).unref?.();
  setTimeout(() => prerenderArt(store.listChannels()), 1000).unref?.();
});

function shutdown() {
  for (const r of runnerStatus()) stopRunner(r.channelId);
  server.close();
  setTimeout(() => process.exit(0), 500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
