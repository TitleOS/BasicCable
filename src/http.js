import fs from 'node:fs';
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
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    ...headers,
  });
  res.end(payload);
}

export async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 1024 * 1024) throw new HttpError(413, 'Body too large');
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
  const proto = (req.headers['x-forwarded-proto'] || '').split(',')[0] || (req.socket.encrypted ? 'https' : 'http');
  const host = (req.headers['x-forwarded-host'] || req.headers.host || `localhost:${config.port}`).split(',')[0];
  return `${proto}://${host}`;
}

export function checkAuth(req) {
  if (!config.adminPassword) return true;
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const [, pass] = Buffer.from(h.slice(6), 'base64').toString('utf8').split(/:(.*)/s);
  return pass === config.adminPassword;
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
};

export function serveStatic(root, req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.normalize(path.join(root, rel));
  if (!file.startsWith(path.normalize(root))) return false;
  let stat;
  try { stat = fs.statSync(file); } catch { return false; }
  if (!stat.isFile()) return false;
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'content-length': stat.size, 'cache-control': 'no-cache' });
  if (req.method === 'HEAD') return res.end(), true;
  fs.createReadStream(file).pipe(res);
  return true;
}
