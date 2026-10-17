// A fake debrid-enabled Stremio stream addon for local testing.
// Serves one local video file (with HTTP Range support, like a debrid CDN) for every title.
//   SAMPLE_FILE=/path/to/video.mkv node test/mock-addon.js   -> http://localhost:7099/manifest.json
import http from 'node:http';
import fs from 'node:fs';

const file = process.env.SAMPLE_FILE;
const port = Number(process.env.MOCK_PORT || 7099);
// Real debrid addons take a few seconds to answer; MOCK_DELAY_MS imitates that.
const delay = Number(process.env.MOCK_DELAY_MS || 0);
// Video ids (comma separated) that only get unusable results: uncached or torrent-only.
const unplayable = new Set((process.env.MOCK_UNPLAYABLE || '').split(',').map((s) => s.trim()).filter(Boolean));
// MOCK_BROKEN=1 adds a top-ranked "Superfan" release that passes the file check but then only returns HTTP 500,
// like a debrid link that dies as playback starts.
const broken = process.env.MOCK_BROKEN === '1';
let brokenHits = 0;
if (!file || !fs.existsSync(file)) {
  console.error('Set SAMPLE_FILE to a video file');
  process.exit(1);
}

http.createServer((req, res) => {
  const base = `http://${req.headers.host}`;
  const url = new URL(req.url, base);
  if (url.pathname === '/manifest.json') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ id: 'mock.debrid', version: '1.0.0', name: 'Mock Debrid', resources: ['stream'], types: ['movie', 'series'], catalogs: [] }));
  }
  const m = url.pathname.match(/^\/stream\/(\w+)\/(.+)\.json$/);
  if (m) {
    const id = decodeURIComponent(m[2]);
    const streams = [
      { name: '[RD download] Mock\n1080p', title: `uncached ${id} 1080p`, url: `${base}/video.mkv?uncached=1` },
      { name: 'Mock\n1080p', title: 'torrent only', infoHash: 'a'.repeat(40) },
      { name: '[RD+] Mock\n2160p', title: `Show ${id} 2160p DV HDR`, url: `${base}/video.mkv?q=2160` },
      { name: '[RD+] Mock\n720p', title: `Show ${id} 720p WEB-DL 💾 400 MB`, url: `${base}/video.mkv?q=720` },
      { name: '[RD+] Mock\n1080p', title: `Show ${id} 1080p BluRay 💾 1.2 GB`, url: `${base}/video.mkv?q=1080` },
      { name: '[RD+] Mock\n720p', title: `Show ${id} Superfan Episodes 720p WEB-DL 💾 900 MB`, url: `${base}/video.mkv?q=superfan` },
    ];
    return setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (broken) streams.unshift({ name: '[RD+] Mock\n1080p', title: `Show ${id} Superfan 1080p BROKEN`, url: `${base}/video.mkv?q=broken` });
      res.end(JSON.stringify({ streams: unplayable.has(id) ? streams.slice(0, 2) : streams }));
    }, delay);
  }
  if (url.pathname === '/video.mkv' && url.searchParams.get('q') === 'broken' && ++brokenHits > 4) {
    res.writeHead(500).end('broken');
    return;
  }
  if (url.pathname === '/video.mkv') {
    const size = fs.statSync(file).size;
    const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
    if (range) {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      res.writeHead(206, { 'content-type': 'video/x-matroska', 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 });
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { 'content-type': 'video/x-matroska', 'accept-ranges': 'bytes', 'content-length': size });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(file).pipe(res);
  }
  res.writeHead(404).end();
}).listen(port, () => console.log(`mock debrid addon on http://localhost:${port}/manifest.json`));
