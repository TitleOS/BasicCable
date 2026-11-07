import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'st-http-'));
process.env.ADMIN_PASSWORD = 'correct horse';
delete process.env.TRUST_PROXY;
delete process.env.BASE_URL;
const { redact } = await import('../src/config.js');
const { sameOrigin, trustedHost, authorize, baseUrl, _resetAuthFailures } = await import('../src/http.js');

test('log lines keep a URL\'s host and lose its path, query and credentials', () => {
  assert.equal(redact('HTTP 500 for https://addon.example/realdebrid=SECRETKEY/stream/series/tt1.json'), 'HTTP 500 for https://addon.example/…');
  assert.equal(redact('https://cdn.example/dl/abc?token=XYZ: Server returned 403 Forbidden'), 'https://cdn.example/…: Server returned 403 Forbidden');
  assert.equal(redact('fetch http://user:pass@host.example:8080/x failed'), 'fetch http://host.example:8080/… failed');
  assert.equal(redact('listening on http://0.0.0.0:7000'), 'listening on http://0.0.0.0:7000');
  assert.equal(redact('"https://a.example/k" and \'https://b.example?key=1\''), '"https://a.example/…" and \'https://b.example/…\'');
});

test('only pages Basic Cable served may call the admin API from a browser', () => {
  const req = (origin, host = 'tv.lan:7000', extra = {}) => ({ headers: { host, ...(origin ? { origin } : {}), ...extra } });
  assert.equal(sameOrigin(req(null)), true, 'no Origin: curl, MCP clients, Stremio');
  assert.equal(sameOrigin(req('http://tv.lan:7000')), true);
  assert.equal(sameOrigin(req('https://evil.example')), false);
  assert.equal(sameOrigin(req('http://tv.lan:7001')), false, 'another port is another origin');
  assert.equal(sameOrigin(req('null')), false, 'sandboxed pages and file:// send "null"');
  // A proxy that rewrites Host: the forwarded host only counts with TRUST_PROXY.
  assert.equal(sameOrigin(req('https://tv.example.com', 'basiccable:7000', { 'x-forwarded-host': 'tv.example.com' })), false);
});

test('without a password, only host names an outside website cannot point at us reach the admin API', () => {
  const req = (host) => ({ headers: host ? { host } : {} });
  for (const ok of ['10.0.1.13:25377', '192.168.1.50', '[::1]:7000', '[fd00::5]:7000', 'localhost:7000', 'graygoo:7000',
    'tv.lan', 'tv.lcars.lan:7000', 'nas.local', 'box.home.arpa', 'basiccable.internal', 'tv.lan.', undefined]) {
    assert.equal(trustedHost(req(ok)), true, ok);
  }
  for (const bad of ['evil.example:7000', 'attacker.com', '10.0.1.13.nip.io', 'lan.evil.example', 'local.example.com']) {
    assert.equal(trustedHost(req(bad)), false, bad);
  }
});

test('wrong passwords lock an IP out for a while; a missing password does not count', () => {
  _resetAuthFailures();
  const basic = (pw) => `Basic ${Buffer.from(`any:${pw}`).toString('base64')}`;
  const req = (ip, authorization) => ({ headers: authorization ? { authorization } : {}, socket: { remoteAddress: ip } });
  const t0 = 1_000_000;
  for (let i = 0; i < 20; i++) assert.equal(authorize(req('10.0.0.9'), t0).result, 'denied', 'no credentials yet');
  for (let i = 0; i < 9; i++) assert.equal(authorize(req('10.0.0.9', basic('guess' + i)), t0 + i).result, 'denied');
  const locked = authorize(req('10.0.0.9', basic('guess9')), t0 + 10);
  assert.equal(locked.result, 'locked');
  assert.ok(locked.justLocked);
  assert.equal(authorize(req('10.0.0.9', basic('correct horse')), t0 + 60_000).result, 'locked', 'even the right password waits');
  assert.equal(authorize(req('10.0.0.10', `Bearer correct horse`), t0 + 60_000).result, 'ok', 'other IPs are unaffected');
  assert.equal(authorize(req('10.0.0.9', basic('correct horse')), t0 + 16 * 60_000).result, 'ok', 'lockout expires');
  // Failures spread out over more than the window never add up to a lockout.
  for (let i = 0; i < 30; i++) assert.equal(authorize(req('10.0.0.11', basic('x')), t0 + i * 2 * 60_000).result, 'denied');
});

test('forwarded host and protocol are only used with TRUST_PROXY', () => {
  const req = { headers: { host: '10.0.1.13:25377', 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https' }, socket: {} };
  assert.equal(baseUrl(req), 'http://10.0.1.13:25377');
});
