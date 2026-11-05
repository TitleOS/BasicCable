import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'st-http-'));
const { redact } = await import('../src/config.js');
const { sameOrigin } = await import('../src/http.js');

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
