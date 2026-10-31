import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'st-picker-'));
const { parseResolution, resolutionOrder, rankStreams, addonBase } = await import('../src/picker.js');

const s = (name, title, extra = {}) => ({ name, title, url: `https://cdn.example/${encodeURIComponent(title)}`, ...extra });

test('parseResolution reads common labels', () => {
  assert.equal(parseResolution('Torrentio\n4k'), 2160);
  assert.equal(parseResolution('Show.S01E01.2160p.WEB'), 2160);
  assert.equal(parseResolution('[RD+] Torrentio\n1080p'), 1080);
  assert.equal(parseResolution('Show 720p HDTV'), 720);
  assert.equal(parseResolution('Show 480p'), 480);
  assert.equal(parseResolution('Show REMUX AVC DTS-HD MA'), null);
});

test('resolutionOrder: target first, then next lower (or higher)', () => {
  assert.deepEqual(resolutionOrder(1080, 'lower'), [1080, 720, 576, 480, 1440, 2160]);
  assert.deepEqual(resolutionOrder(1080, 'higher'), [1080, 1440, 2160, 720, 576, 480]);
  assert.deepEqual(resolutionOrder(2160, 'lower'), [2160, 1440, 1080, 720, 576, 480]);
});

const streams = [
  s('[RD download] Torrentio\n1080p', 'Show 1080p uncached'),
  { name: 'Torrentio\n1080p', title: 'Show 1080p torrent', infoHash: 'a'.repeat(40) },
  s('[RD+] Torrentio\n2160p', 'Show 2160p WEB-DL'),
  s('[RD+] Torrentio\n720p', 'Show 720p WEB-DL'),
  s('[RD+] Torrentio\n480p', 'Show 480p DVDRip'),
  s('[RD+] Torrentio\n1080p', 'Show 1080p HDCAM'),
];

test('rankStreams uses only cached direct links and skips junk', () => {
  const ranked = rankStreams(streams, { resolution: 1080, fallback: 'lower', options: {} });
  assert.deepEqual(ranked.map((r) => r.resolution), [720, 480, 2160]);
});

test('rankStreams picks the exact target when available', () => {
  const ranked = rankStreams([...streams, s('[RD+] Torrentio\n1080p', 'Show 1080p BluRay')], { resolution: 1080, fallback: 'lower', options: {} });
  assert.equal(ranked[0].resolution, 1080);
  assert.match(ranked[0].label, /BluRay/);
});

test('rankStreams falls back upwards when asked', () => {
  const ranked = rankStreams(streams, { resolution: 1080, fallback: 'higher', options: {} });
  assert.equal(ranked[0].resolution, 2160);
});

test('rankStreams deprioritises Dolby Vision and honours excluded keywords', () => {
  const list = [s('[RD+] T\n2160p', 'Show 2160p DV'), s('[RD+] T\n2160p', 'Show 2160p HDR10 x265')];
  assert.match(rankStreams(list, { resolution: 2160, options: {} })[0].label, /HDR10/);
  assert.equal(rankStreams(list, { resolution: 2160, options: { excludeKeywords: ['x265'] } }).length, 1);
});

test('addonBase strips manifest and stremio scheme', () => {
  assert.equal(addonBase('stremio://torrentio.strem.fun/realdebrid=abc/manifest.json'), 'https://torrentio.strem.fun/realdebrid=abc');
  assert.equal(addonBase('https://x.example/abc/manifest.json/'), 'https://x.example/abc');
});

test('preferred keywords (e.g. Superfan) win over resolution, then resolution decides among them', () => {
  const list = [
    s('[RD+] T\n1080p', 'The.Office.US.S02E01.1080p.WEB-DL'),
    s('[RD+] T\n720p', 'The.Office.US.S02E01.Superfan.Episodes.720p.PCOK.WEB-DL'),
    s('[RD+] T\n480p', 'The Office S02E01 SUPERFAN 480p'),
  ];
  const ranked = rankStreams(list, { resolution: 1080, fallback: 'lower', options: {} }, ['Superfan']);
  assert.deepEqual(ranked.map((r) => r.resolution), [720, 480, 1080]);
  assert.equal(ranked[0].preferred, true);
  assert.equal(ranked[2].preferred, false);
  // Without preferences the plain 1080p release is first again.
  assert.equal(rankStreams(list, { resolution: 1080, options: {} })[0].resolution, 1080);
});

test('prefetch lookups are spaced 3 to 30 seconds apart', async () => {
  const { staggerDelay } = await import('../src/prefetch.js');
  assert.equal(staggerDelay(0), 3000);
  assert.equal(staggerDelay(1), 30000);
  for (let i = 0; i < 100; i++) {
    const d = staggerDelay();
    assert.ok(d >= 3000 && d <= 30000, `delay ${d}`);
  }
});

test('blacklisted release words (whole words) and CAM/TVSYNC releases are never used', () => {
  const list = [
    s('[RD+] T\n2160p', 'Star Wars (1977) [2160p] [4K] [BluRay] [5.1] [YTS.MX]'),
    s('[RD+] T\n1080p', 'Star.Wars.1977.1080p.BluRay.x264-YIFY'),
    s('[RD+] T\n1080p', 'Star Wars 1977 1080p TVSYNC'),
    s('[RD+] T\n1080p', 'Star Wars 1977 1080p TV-Sync AAC'),
    s('[RD+] T\n1080p', 'Star.Wars.1977.HQCAM.1080p'),
    s('[RD+] T\n1080p', 'Star.Wars.Knights.1977.1080p.BluRay-GROUP'),
  ];
  const ranked = rankStreams(list, { resolution: 1080, options: {} }, [], ['YIFY', 'YTS']);
  assert.equal(ranked.length, 1);
  assert.match(ranked[0].label, /Knights/, '"YTS" must not match inside "Knights"');
  // Without a blacklist only the CAM/TVSYNC ones go.
  assert.equal(rankStreams(list, { resolution: 1080, options: {} }).length, 3);
});

test('HDR preferences reorder releases of the same resolution only', () => {
  const list = [
    s('[RD+] T\n2160p', 'Movie 2160p WEB-DL SDR'),
    s('[RD+] T\n2160p', 'Movie 2160p HLG'),
    s('[RD+] T\n2160p', 'Movie 2160p HDR10+ x265'),
    s('[RD+] T\n2160p', 'Movie 2160p DV'),
    s('[RD+] T\n1080p', 'Movie 1080p HDR'),
  ];
  const order = (options) => rankStreams(list, { resolution: 2160, options }).map((r) => `${r.resolution}:${r.hdr || 'sdr'}`);
  assert.deepEqual(order({}), ['2160:sdr', '2160:hlg', '2160:hdr10', '2160:dv', '1080:hdr10']);
  assert.deepEqual(order({ preferHdr: true }), ['2160:hlg', '2160:hdr10', '2160:sdr', '2160:dv', '1080:hdr10']);
  assert.deepEqual(order({ preferHdr10: true }), ['2160:hdr10', '2160:sdr', '2160:hlg', '2160:dv', '1080:hdr10']);
  assert.deepEqual(order({ preferHdr: true, preferHdr10: true }), ['2160:hdr10', '2160:hlg', '2160:sdr', '2160:dv', '1080:hdr10']);
  // Dolby Vision counts as HDR once the channel stops avoiding it.
  assert.deepEqual(order({ preferHdr: true, avoidDolbyVision: false }), ['2160:hlg', '2160:hdr10', '2160:dv', '2160:sdr', '1080:hdr10']);
  // "HDRip" is a rip name, not HDR.
  assert.equal(rankStreams([s('[RD+] T\n720p', 'Movie HDRip 720p')], { resolution: 720, options: {} })[0].hdr, null);
});

test('an addon answering with only a notice counts as failed, and a partial outage is never "unplayable"', async () => {
  const http = await import('node:http');
  const { store } = await import('../src/db.js');
  const { findStreams, isNoticeOnly } = await import('../src/picker.js');
  assert.equal(isNoticeOnly([{ name: '[TB] Torrentio', title: '⚠️ Rate limit exceeded, try again later' }]), true);
  assert.equal(isNoticeOnly([{ name: '[TB] Torrentio', title: 'Too many requests', url: 'https://x/notice.mp4' }]), true);
  assert.equal(isNoticeOnly([{ name: '[TB+] Torrentio\n1080p', title: 'Obscure.Movie.1080p.mkv', url: 'https://x/a.mkv' }]), false);
  assert.equal(isNoticeOnly([]), false);

  let torrentio = 'notice';
  let comet = 'empty';
  const hits = { t: 0, c: 0 };
  const server = http.createServer((req, res) => {
    const isT = req.url.startsWith('/t/');
    hits[isT ? 't' : 'c']++;
    const mode = isT ? torrentio : comet;
    const streams = mode === 'notice' ? [{ name: '[TB] Torrentio', title: '⚠️ Rate limit exceeded' }]
      : mode === 'good' ? [{ name: '[TB+] X\n2160p', title: 'Movie.2160p.HDR.mkv', url: 'https://cdn.example/a.mkv' }] : [];
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ streams }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  store.saveSettings({ streamAddons: [`${base}/t/manifest.json`, `${base}/c/manifest.json`] });
  const channel = { id: 901, resolution: 2160, options: {} };
  const item = { type: 'movie', video_id: 'tt3748528' };
  try {
    // Torrentio rate-limited, Comet has nothing: an outage to retry, not a title to skip.
    await assert.rejects(() => findStreams(item, channel), /addons? failed .*trying again later/);
    // Comet has something: use it, but don't keep this partial answer for hours.
    comet = 'good';
    assert.equal((await findStreams(item, channel)).length, 1);
    const before = hits.t;
    await findStreams(item, channel);
    assert.equal(hits.t, before + 1, 'asked the addons again: the partial answer was not cached');
    // Both healthy: cached as usual.
    torrentio = 'good';
    await findStreams(item, channel);
    const after = hits.t;
    await findStreams(item, channel);
    assert.equal(hits.t, after, 'a full answer is cached');
  } finally {
    server.close();
    store.saveSettings({ streamAddons: [] });
  }
});

test('findStreams drops releases that name another title the server plays', async () => {
  const http = await import('node:http');
  const { store } = await import('../src/db.js');
  const { findStreams } = await import('../src/picker.js');
  const ch = store.createChannel({ name: 'HoloNet test' });
  store.addSource(ch.id, { kind: 'series', ref: 'tt0361243', name: 'Star Wars: Clone Wars' });
  store.addSource(ch.id, { kind: 'series', ref: 'tt0458290', name: 'Star Wars: The Clone Wars' });
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ streams: [
      { name: '[TB⚡] Comet 1080p', description: '📄 Star.Wars.The.Clone.Wars.S01E05.Rookies.1080p.WEB-DL.mkv', url: 'https://cdn.example/tcw.mkv',
        behaviorHints: { filename: 'Star.Wars.The.Clone.Wars.S01E05.Rookies.1080p.WEB-DL.mkv' } },
      { name: '[TB+] Torrentio\n1080p', title: 'Star.Wars.Clone.Wars.2003.1080p\nStar Wars Clone Wars (2003) 1080p - Episode 5.mkv', url: 'https://cdn.example/cw.mkv',
        behaviorHints: { filename: 'Star Wars Clone Wars (2003) 1080p - Episode 5.mkv' } },
    ] }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  store.saveSettings({ streamAddons: [`http://127.0.0.1:${server.address().port}/manifest.json`] });
  try {
    const cw = await findStreams({ type: 'series', meta_id: 'tt0361243', video_id: 'tt0361243:1:5', title: 'Star Wars: Clone Wars' }, { id: 902, resolution: 1080, options: {} });
    assert.deepEqual(cw.map((c) => c.url), ['https://cdn.example/cw.mkv']);
    const tcw = await findStreams({ type: 'series', meta_id: 'tt0458290', video_id: 'tt0458290:1:5', title: 'Star Wars: The Clone Wars' }, { id: 902, resolution: 1080, options: {} });
    assert.deepEqual(tcw.map((c) => c.url), ['https://cdn.example/tcw.mkv']);
  } finally {
    server.close();
    store.saveSettings({ streamAddons: [] });
    store.deleteChannel(ch.id);
  }
});
