import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { config } from './config.js';
import { store } from './db.js';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export class Router {
  constructor() { this.routes = []; }
  add(method, pattern, handler, { auth = false } = {}) {
    // "/api/channels/:id" -> /^\/api\/channels\/(?<id>[^/]+)$/
    const re = new RegExp('^' + pattern.replace(/[.]/g, '\\.').replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$');
    this.routes.push({ method, re, handler, auth });
  }
  get(p, h, o) { this.add('GET', p, h, o); }
  post(p, h, o) { this.add('POST', p, h, o); }
  put(p, h, o) { this.add('PUT', p, h, o); }
  delete(p, h, o) { this.add('DELETE', p, h, o); }
  match(method, pathname) {
    for (const r of this.routes) {
      if (r.method !== method && !(method === 'HEAD' && r.method === 'GET')) continue;
      const m = pathname.match(r.re);
      if (m) return { route: r, params: Object.fromEntries(Object.entries(m.groups || {}).map(([k, v]) => [k, decodeURIComponent(v)])) };
    }
    return null;
  }
}

export function send(res, status, body, headers = {}) {
  if (res.headersSent) return;
  const isBuf = Buffer.isBuffer(body) || typeof body === 'string';
  const payload = isBuf ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': isBuf ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    ...headers,
  });
  res.end(payload);
}

export async function readJson(req, maxBytes = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > maxBytes) throw new HttpError(413, 'Body too large');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

/** The URL other devices should use to reach us. */
export function baseUrl(req) {
  const configured = (store.getSettings().publicUrl || config.baseUrl || '').replace(/\/+$/, '');
  if (configured) return configured;
  const fwd = (name) => (config.trustProxy && String(req.headers[name] || '').split(',')[0].trim()) || '';
  const proto = fwd('x-forwarded-proto') || (req.socket?.encrypted ? 'https' : 'http');
  const host = fwd('x-forwarded-host') || req.headers.host || `localhost:${config.port}`;
  return `${proto}://${host}`;
}

/** The viewer's IP. Behind a reverse proxy, set TRUST_PROXY=1 so X-Forwarded-For is used instead of the proxy's IP. */
export function clientIp(req) {
  const fwd = config.trustProxy && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return (fwd || req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
}

const samePassword = (given) => {
  const a = crypto.createHash('sha256').update(String(given ?? '')).digest();
  const b = crypto.createHash('sha256').update(config.adminPassword).digest();
  return crypto.timingSafeEqual(a, b);
};

/** Whether the request carries the admin password (always true when none is set). */
export function checkAuth(req) {
  if (!config.adminPassword) return true;
  const h = req.headers.authorization || '';
  // "Bearer <password>" is easier to put in an MCP client's config than Basic auth.
  if (h.startsWith('Bearer ')) return samePassword(h.slice(7).trim());
  if (!h.startsWith('Basic ')) return false;
  const [, pass] = Buffer.from(h.slice(6), 'base64').toString('utf8').split(/:(.*)/s);
  return samePassword(pass);
}

// Wrong passwords per client IP. After MAX_FAILURES within FAILURE_WINDOW_MS, that IP is refused for LOCKOUT_MS.
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const LOCKOUT_MS = 15 * 60 * 1000;
const failures = new Map(); // ip -> { count, first, lockedUntil }

/**
 * checkAuth with a limit on guessing: 'ok', 'denied' (no or wrong password) or 'locked' (too many wrong
 * passwords from this IP lately; `retryAfter` is in seconds). Requests without credentials, like a browser's
 * first request before it asks for the password, don't count as failures.
 */
export function authorize(req, now = Date.now()) {
  if (!config.adminPassword) return { result: 'ok' };
  const ip = clientIp(req);
  const f = failures.get(ip);
  if (f?.lockedUntil > now) return { result: 'locked', retryAfter: Math.ceil((f.lockedUntil - now) / 1000) };
  if (checkAuth(req)) {
    failures.delete(ip);
    return { result: 'ok' };
  }
  if (!req.headers.authorization) return { result: 'denied' };
  const cur = f && now - f.first < FAILURE_WINDOW_MS && !f.lockedUntil ? f : { count: 0, first: now, lockedUntil: 0 };
  cur.count++;
  if (cur.count >= MAX_FAILURES) cur.lockedUntil = now + LOCKOUT_MS;
  failures.delete(ip); // re-insert so the map stays in least-recently-failed order for pruning
  failures.set(ip, cur);
  if (failures.size > 10000) failures.delete(failures.keys().next().value);
  if (cur.lockedUntil) return { result: 'locked', retryAfter: Math.ceil(LOCKOUT_MS / 1000), justLocked: true };
  return { result: 'denied' };
}

export function _resetAuthFailures() { failures.clear(); }

// Host names that only resolve inside a home network, so an outside website can't point its own name at us.
const PRIVATE_SUFFIX = /(^|\.)(localhost|local|lan|home|internal|intranet|localdomain|corp|private|home\.arpa|test)$/i;

/**
 * Whether the Host header names this server in a way an outside website can't borrow: an IP address,
 * localhost, a single-label name ("graygoo"), a name under a home-network suffix (.lan, .local, .home.arpa...),
 * or the host of the Public URL / BASE_URL. Requests without a Host header pass (browsers always send one).
 */
export function trustedHost(req) {
  const raw = req.headers.host;
  if (!raw) return true;
  let hostname;
  try { hostname = new URL(`http://${raw}`).hostname; } catch { return false; }
  hostname = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (net.isIP(hostname) || !hostname.includes('.') || PRIVATE_SUFFIX.test(hostname)) return true;
  for (const u of [store.getSettings().publicUrl, config.baseUrl]) {
    try { if (u && new URL(u).hostname.toLowerCase() === hostname.toLowerCase()) return true; } catch { /* not a URL */ }
  }
  return false;
}

/**
 * Whether a browser request comes from a page Basic Cable served itself. Requests without an Origin header
 * (curl, MCP clients, Stremio) pass. Behind a reverse proxy that rewrites Host, the forwarded host (with
 * TRUST_PROXY) or the configured public URL count too.
 */
export function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  let host;
  try { host = new URL(origin).host; } catch { return false; }
  const allowed = [req.headers.host];
  if (config.trustProxy) allowed.push(String(req.headers['x-forwarded-host'] || '').split(',')[0].trim());
  for (const u of [store.getSettings().publicUrl, config.baseUrl]) {
    try { if (u) allowed.push(new URL(u).host); } catch { /* not a URL */ }
  }
  return allowed.includes(host);
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
};

/** For the web UI's pages: only its own scripts, no framing by other sites, no referrer to poster hosts. */
const UI_HEADERS = {
  'content-security-policy': "default-src 'self'; img-src * data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; " +
    "object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'x-frame-options': 'DENY',
};

export function serveStatic(root, req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.normalize(path.join(root, rel));
  if (!file.startsWith(path.normalize(root))) return false;
  let stat;
  try { stat = fs.statSync(file); } catch { return false; }
  if (!stat.isFile()) return false;
  const ext = path.extname(file);
  res.writeHead(200, {
    'content-type': MIME[ext] || 'application/octet-stream', 'content-length': stat.size, 'cache-control': 'no-cache',
    ...(ext === '.html' ? UI_HEADERS : {}),
  });
  if (req.method === 'HEAD') return res.end(), true;
  fs.createReadStream(file).pipe(res);
  return true;
}
