import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'st-news-'));
const { parseFeed, feedKind, decodeText, checkFeed, feedUrl, feedTag, activeSources, fetchHeadlines, DEFAULT_SOURCES, _test } = await import('../src/news.js');
const { tickerStrip, newsCard, newsLayout, textWidthEm } = await import('../src/newscard.js');
const { utilityConfig, utilityText } = await import('../src/utilities.js');
const { pauseDownloads } = await import('../src/music.js');
pauseDownloads(true);

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:dc="http://purl.org/dc/elements/1.1/" version="2.0"><channel><title>PBS News Hour - The Latest</title><link>https://www.pbs.org/newshour</link>
<item><title><![CDATA[Senate race &amp; what&#8217;s next]]></title><link>https://example.org/1</link><pubDate>Sat, 07 Nov 2026 01:55:51 -0500</pubDate></item>
<item><title>Second story &apos;quoted&apos;</title><link>https://example.org/2</link><pubDate>Fri, 06 Nov 2026 18:55:50 -0500</pubDate></item>
<item><title></title></item>
</channel></rss>`;
const ATOM = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Example Atom</title>
<entry><title>Atom entry one</title><link rel="alternate" href="https://example.org/a1"/><updated>2026-11-07T06:00:00Z</updated></entry>
<entry><title type="html">Atom &lt;b&gt;two&lt;/b&gt;</title><link href="https://example.org/a2"/><published>2026-11-06T06:00:00Z</published></entry></feed>`;
const HTML = '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body>no feed here</body></html>';

const fakeFetch = (routes) => async (url) => {
  const hit = routes[url];
  if (hit === undefined) return { ok: false, status: 404, headers: new Map(), arrayBuffer: async () => new ArrayBuffer(0) };
  if (hit instanceof Error) throw hit;
  return { ok: true, status: 200, headers: new Map(), arrayBuffer: async () => new TextEncoder().encode(hit).buffer };
};

test('RSS and Atom documents are parsed; entities, CDATA and tags are undone', () => {
  assert.equal(feedKind(RSS), 'rss');
  assert.equal(feedKind(ATOM), 'atom');
  assert.equal(feedKind(HTML), null);
  assert.equal(feedKind('<rdf:RDF xmlns="http://purl.org/rss/1.0/"><item><title>x</title></item></rdf:RDF>'), 'rdf');
  const rss = parseFeed(RSS);
  assert.equal(rss.title, 'PBS News Hour - The Latest');
  assert.deepEqual(rss.items.map((i) => i.title), ['Senate race & what’s next', "Second story 'quoted'"]);
  assert.equal(rss.items[0].link, 'https://example.org/1');
  assert.equal(rss.items[0].date, Date.parse('Sat, 07 Nov 2026 01:55:51 -0500'));
  const atom = parseFeed(ATOM);
  assert.equal(atom.title, 'Example Atom');
  assert.deepEqual(atom.items.map((i) => [i.title, i.link]), [['Atom entry one', 'https://example.org/a1'], ['Atom two', 'https://example.org/a2']]);
  assert.throws(() => parseFeed(HTML), /not an RSS or Atom feed/);
  assert.equal(decodeText('A &#x2014; B &nbsp; C &unknown; D'), 'A — B C &unknown; D');
});

test('a feed URL is checked for syntax, then fetched and checked for being a feed', async () => {
  assert.throws(() => feedUrl('not a url'), /not a valid URL/);
  assert.throws(() => feedUrl('ftp://example.org/feed'), /http/);
  assert.equal(feedUrl('  https://example.org/feed.xml '), 'https://example.org/feed.xml');
  const fetchImpl = fakeFetch({ 'https://example.org/rss': RSS, 'https://example.org/page': HTML, 'https://example.org/empty': '<rss version="2.0"><channel><title>Empty</title></channel></rss>' });
  assert.deepEqual(await checkFeed('https://example.org/rss', { fetchImpl }), { url: 'https://example.org/rss', title: 'PBS News Hour - The Latest' });
  await assert.rejects(checkFeed('https://example.org/page', { fetchImpl }), /not an RSS or Atom feed/);
  await assert.rejects(checkFeed('https://example.org/empty', { fetchImpl }), /no items/);
  await assert.rejects(checkFeed('https://example.org/missing', { fetchImpl }), /HTTP 404/);
  assert.equal(feedTag({ url: 'https://example.org/rss', title: 'PBS News Hour - The Latest' }), 'PBS NEWS HOUR');
  assert.equal(feedTag({ url: 'https://www.example.org/rss', title: '' }), 'EXAMPLE.ORG');
});

test('the news settings keep good feeds, drop bad ones and say which, and need at least one source', async () => {
  const fetchImpl = fakeFetch({ 'https://example.org/rss': RSS, 'https://example.org/page': HTML });
  const notes = { fetchImpl };
  const cfg = await utilityConfig('news', { sources: { ap: false, npr: true, pbs: 'false' }, feeds: 'https://example.org/rss\nhttps://example.org/page\nnonsense' }, null, notes);
  assert.deepEqual(cfg.sources, { ap: false, npr: true, pbs: false });
  assert.deepEqual(cfg.feeds, [{ url: 'https://example.org/rss', title: 'PBS News Hour - The Latest' }]);
  assert.deepEqual(notes.rejected.map((r) => [r.url, r.reason]), [['https://example.org/page', 'not an RSS or Atom feed'], ['nonsense', 'not a valid URL']]);
  assert.equal(cfg.music, 'jazz');
  assert.deepEqual(activeSources(cfg).map((s) => s.tag), ['NPR', 'PBS NEWS HOUR']);
  assert.equal(utilityText(cfg).subtitle, 'NPR · PBS NEWS HOUR');
  assert.match(utilityText(cfg).description, /from NPR and PBS NEWS HOUR/);
  // A feed accepted before is kept without being fetched again (the fake 404s anything it doesn't know).
  const again = await utilityConfig('news', { feeds: ['https://example.org/rss'] }, cfg, { fetchImpl: fakeFetch({}) });
  assert.deepEqual(again.feeds, cfg.feeds);
  await assert.rejects(utilityConfig('news', { sources: { ap: false, npr: false, pbs: false }, feeds: [] }, null, notes), /at least one source/);
  // Defaults: every source on, no feeds.
  const def = await utilityConfig('news', {});
  assert.deepEqual(def.sources, { ap: true, npr: true, pbs: true });
  assert.deepEqual(activeSources(def).map((s) => s.tag), ['AP', 'NPR', 'PBS']);
});

test('headlines interleave the sources, strip the AP suffix, drop duplicates and survive a source failing', async () => {
  _test.cache.clear();
  const ap = `<rss version="2.0"><channel><title>AP</title>
    <item><title>Shared story - AP News</title><pubDate>Sat, 07 Nov 2026 10:00:00 GMT</pubDate></item>
    <item><title>AP only story - AP News</title><pubDate>Sat, 07 Nov 2026 09:00:00 GMT</pubDate></item></channel></rss>`;
  const npr = `<rss version="2.0"><channel><title>NPR</title>
    <item><title>Older NPR story</title><pubDate>Sat, 07 Nov 2026 08:00:00 GMT</pubDate></item>
    <item><title>Shared story</title><pubDate>Sat, 07 Nov 2026 11:00:00 GMT</pubDate></item></channel></rss>`;
  const fetchImpl = fakeFetch({ [DEFAULT_SOURCES.ap.url]: ap, [DEFAULT_SOURCES.npr.url]: npr, [DEFAULT_SOURCES.pbs.url]: new Error('connection refused') });
  const cfg = { kind: 'news', sources: { ap: true, npr: true, pbs: true }, feeds: [] };
  const out = await fetchHeadlines(cfg, { fetchImpl, now: 1000 });
  assert.deepEqual(out.map((h) => `${h.tag}: ${h.title}`), ['AP: Shared story', 'NPR: Older NPR story', 'AP: AP only story']);
  // Within the cache window the sources are not fetched again, and a failed one is retried sooner.
  const quiet = await fetchHeadlines(cfg, { fetchImpl: fakeFetch({}), now: 2000 });
  assert.equal(quiet.length, 3);
  assert.ok(_test.cache.get(DEFAULT_SOURCES.pbs.url).error);
});

test('the ticker strip repeats its start so the scroll wraps, and the card is valid SVG', () => {
  const heads = [{ tag: 'AP', title: 'One headline that is fairly long for a test' }, { tag: 'NPR', title: 'Two' }];
  const s = tickerStrip(heads, { height: 92, windowWidth: 1650 });
  assert.ok(s.contentWidth > 1650 && s.width >= s.contentWidth + 1650, `${s.contentWidth} ${s.width}`);
  assert.match(s.svg, /<svg [^>]*width="\d+" height="92"/);
  assert.equal((s.svg.match(/One headline/g) || []).length >= 2, true, 'the first headline appears again after the end');
  // The empty case still produces a strip.
  const none = tickerStrip([], { windowWidth: 1650 });
  assert.match(none.svg, /on their way/);
  assert.ok(textWidthEm('Wide MW') > textWidthEm('illi ll'));
  const L = newsLayout(1920, 1080);
  assert.deepEqual([L.ticker.x, L.ticker.w, L.barH], [270, 1650, 92]);
  const card = newsCard({ credit: 'A & B (© Someone)', nowPlaying: 'Blues for Mundy · Airmen of Note', sources: ['AP', 'NPR'] });
  assert.match(card, /A &amp; B/);
  assert.match(card, /HEADLINES/);
  assert.match(card, /AP · NPR/);
  assert.doesNotMatch(card, /url\(#bg\)"\/>\n<rect x="0" y="0"/); // transparent unless opaque
  assert.match(newsCard({ opaque: true }), /fill="url\(#bg\)"/);
});
