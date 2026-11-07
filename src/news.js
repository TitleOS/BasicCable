// Headlines for the news channel: RSS and Atom feeds read with a small parser (no dependency), checked when a
// feed is added, refreshed while the channel is on air; and Bing's picture of the day for the background.

import fs from 'node:fs';
import path from 'node:path';
import { config, log, VERSION } from './config.js';

const UA = { 'user-agent': `BasicCable/${VERSION} (+https://github.com/TitleOS/BasicCable)` };
const FEED_TIMEOUT_MS = 10000;
const FEED_MAX_BYTES = 2 * 1048576;
const HEADLINES_TTL = 10 * 60 * 1000;
const BING_TTL = 6 * 3600e3;
export const MAX_FEEDS = 12;
export const PER_SOURCE = 10;
export const MAX_HEADLINES = 36;

/**
 * The sources offered by default. AP stopped publishing feeds, so its headlines come through Google News
 * limited to apnews.com; the titles carry " - AP News", which is stripped.
 */
export const DEFAULT_SOURCES = {
  ap: { name: 'Associated Press', tag: 'AP', url: 'https://news.google.com/rss/search?q=site:apnews.com&hl=en-US&gl=US&ceid=US:en', strip: / - AP News$/ },
  npr: { name: 'NPR', tag: 'NPR', url: 'https://feeds.npr.org/1001/rss.xml' },
  pbs: { name: 'PBS News Hour', tag: 'PBS', url: 'https://www.pbs.org/newshour/feeds/rss/headlines' },
};

// ---------------------------------------------------------------------------
// parsing

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', ndash: '–', mdash: '—', hellip: '…', copy: '©' };

/** Named and numeric entities to characters; tags dropped; whitespace folded. */
export function decodeText(s) {
  let t = String(s ?? '');
  const cdata = t.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  if (cdata) t = cdata[1];
  t = t.replace(/<[^>]*>/g, '');
  t = t.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
  t = t.replace(/<[^>]*>/g, ''); // markup that was escaped (Atom's type="html" titles)
  return t.replace(/\s+/g, ' ').trim();
}

function tagContent(block, name) {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? m[1] : '';
}

/** What kind of feed a document is: 'rss', 'atom', 'rdf' or null. */
export function feedKind(xml) {
  const head = String(xml || '').slice(0, 4096).replace(/<!--[\s\S]*?-->/g, '').replace(/^﻿/, '');
  if (/^\s*(<\?xml[^>]*\?>\s*)?(<!DOCTYPE[^>]*>\s*)?<rss[\s>]/i.test(head)) return 'rss';
  if (/^\s*(<\?xml[^>]*\?>\s*)?(<!DOCTYPE[^>]*>\s*)?<feed[\s>]/i.test(head)) return 'atom';
  if (/^\s*(<\?xml[^>]*\?>\s*)?<rdf:RDF[\s>]/i.test(head)) return 'rdf';
  return null;
}

/** Parse an RSS 2.0, RSS 1.0 (RDF) or Atom document into { title, items: [{ title, link, date }] }. */
export function parseFeed(xml) {
  const kind = feedKind(xml);
  if (!kind) throw new Error('not an RSS or Atom feed');
  const doc = String(xml);
  const items = [];
  const itemTag = kind === 'atom' ? 'entry' : 'item';
  const re = new RegExp(`<${itemTag}(?:\\s[^>]*)?>([\\s\\S]*?)</${itemTag}>`, 'gi');
  let m;
  while ((m = re.exec(doc)) && items.length < 60) {
    const block = m[1];
    const title = decodeText(tagContent(block, 'title'));
    if (!title) continue;
    let link = '';
    if (kind === 'atom') {
      const l = block.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*>/i);
      link = l ? decodeText(l[1]) : '';
    } else link = decodeText(tagContent(block, 'link')) || (block.match(/<link\b[^>]*href=["']([^"']+)["']/i) || [])[1] || '';
    const dateText = tagContent(block, 'pubDate') || tagContent(block, 'published') || tagContent(block, 'updated') || tagContent(block, 'dc:date');
    const date = dateText ? Date.parse(decodeText(dateText)) || null : null;
    items.push({ title, link, date });
  }
  // The feed's own title is the first <title> outside any item.
  const headEnd = doc.search(new RegExp(`<${itemTag}[\\s>]`, 'i'));
  const head = headEnd > 0 ? doc.slice(0, headEnd) : doc;
  const title = decodeText(tagContent(head, 'title'));
  return { kind, title, items };
}

// ---------------------------------------------------------------------------
// fetching

async function fetchText(url, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(url, { headers: { ...UA, accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5' }, signal: AbortSignal.timeout(FEED_TIMEOUT_MS), redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const len = Number(res.headers.get('content-length') || 0);
  if (len > FEED_MAX_BYTES) throw new Error('feed is larger than 2 MB');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > FEED_MAX_BYTES) throw new Error('feed is larger than 2 MB');
  return buf.toString('utf8');
}

/** The URL's syntax, before anything is fetched: http(s), with a host. Returns the normalised URL or throws. */
export function feedUrl(input) {
  const s = String(input || '').trim();
  let u;
  try { u = new URL(s); } catch { throw new Error('not a valid URL'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('must start with http:// or https://');
  if (!u.hostname) throw new Error('not a valid URL');
  return u.href;
}

/**
 * Check a feed the user added: the URL must parse, answer, and be an RSS or Atom document with at least one
 * item. Resolves to { url, title } or throws with a reason.
 */
export async function checkFeed(input, { fetchImpl } = {}) {
  const url = feedUrl(input);
  let xml;
  try {
    xml = await fetchText(url, { fetchImpl });
  } catch (e) {
    throw new Error(e.name === 'TimeoutError' ? 'did not answer within 10 seconds' : e.message);
  }
  const feed = parseFeed(xml); // throws "not an RSS or Atom feed"
  if (!feed.items.length) throw new Error('the feed has no items');
  return { url, title: (feed.title || new URL(url).hostname).slice(0, 60) };
}

/** A short tag for a custom feed in the ticker: "BBC News" -> "BBC NEWS", at most 14 characters. */
export function feedTag(feed) {
  const t = String(feed.title || '').replace(/\s*[-–|:].*$/, '').trim() || new URL(feed.url).hostname.replace(/^www\./, '');
  return t.slice(0, 14).toUpperCase();
}

/** The sources a news config reads: the enabled defaults, then the user's own feeds. */
export function activeSources(cfg) {
  const out = [];
  for (const [key, def] of Object.entries(DEFAULT_SOURCES)) if (cfg.sources?.[key] !== false) out.push({ key, name: def.name, tag: def.tag, url: def.url, strip: def.strip });
  for (const f of cfg.feeds || []) out.push({ key: f.url, name: f.title || f.url, tag: feedTag(f), url: f.url });
  return out;
}

const cache = new Map(); // url -> { at, items, error }

/**
 * Headlines for a config, newest first within each source and the sources interleaved, each a
 * { tag, title, link, date }. Sources are fetched in parallel and cached 10 minutes; one that fails keeps its
 * last headlines.
 */
export async function fetchHeadlines(cfg, { fetchImpl, now = Date.now() } = {}) {
  const sources = activeSources(cfg);
  await Promise.all(sources.map(async (s) => {
    const hit = cache.get(s.url);
    if (hit && now - hit.at < HEADLINES_TTL) return;
    try {
      const feed = parseFeed(await fetchText(s.url, { fetchImpl }));
      const items = feed.items.map((it) => ({ ...it, title: s.strip ? it.title.replace(s.strip, '') : it.title })).filter((it) => it.title);
      items.sort((a, b) => (b.date || 0) - (a.date || 0));
      cache.set(s.url, { at: now, items: items.slice(0, PER_SOURCE), error: null });
    } catch (e) {
      log.warn(`news: ${s.name}: ${e.message}`);
      cache.set(s.url, { at: now - HEADLINES_TTL + 60000, items: hit?.items || [], error: e.message }); // try again in a minute
    }
  }));
  // The sources take turns, each giving its next headline that hasn't been shown by another.
  const lists = sources.map((s) => ({ s, items: [...(cache.get(s.url)?.items || [])] }));
  const out = [];
  const seen = new Set();
  let added = true;
  while (added && out.length < MAX_HEADLINES) {
    added = false;
    for (const { s, items } of lists) {
      while (items.length) {
        const it = items.shift();
        const key = it.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ tag: s.tag, source: s.name, title: it.title, link: it.link, date: it.date });
        added = true;
        break;
      }
      if (out.length >= MAX_HEADLINES) break;
    }
  }
  return out;
}

/** What each source last did, for the web UI: [{ name, url, ok, error, count, at }]. */
export function sourceStatus(cfg) {
  return activeSources(cfg).map((s) => {
    const hit = cache.get(s.url);
    return { key: s.key, name: s.name, url: s.url, checked: !!hit, error: hit?.error || null, count: hit?.items.length || 0 };
  });
}

// ---------------------------------------------------------------------------
// Bing's picture of the day

export const BING_DIR = path.join(config.dataDir, 'news', 'bing');
const BING_LIST = 'https://www.bing.com/HPImageArchive.aspx?format=js&idx=0&n=8&mkt=en-US';
let bing = { at: 0, images: [] }; // [{ file, credit, title }]
let bingPromise = null;

/**
 * The latest Bing pictures of the day (up to 8), downloaded once each into DATA_DIR/news/bing. Resolves to
 * [{ file, credit, title }]; an empty list when Bing is unreachable and nothing was kept.
 */
export async function bingImages({ fetchImpl = fetch, now = Date.now() } = {}) {
  if (bing.images.length && now - bing.at < BING_TTL) return bing.images;
  if (!bingPromise) {
    bingPromise = (async () => {
      fs.mkdirSync(BING_DIR, { recursive: true });
      const res = await fetchImpl(BING_LIST, { headers: UA, signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const list = (await res.json()).images || [];
      const images = [];
      for (const im of list) {
        const id = (im.urlbase || im.url || '').match(/id=([\w.-]+)/)?.[1];
        if (!id) continue;
        const file = path.join(BING_DIR, `${id.replace(/[^\w.-]/g, '_')}.jpg`);
        if (!fs.existsSync(file)) {
          try {
            const r = await fetchImpl(`https://www.bing.com${im.urlbase}_1920x1080.jpg`, { headers: UA, signal: AbortSignal.timeout(30000) });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const buf = Buffer.from(await r.arrayBuffer());
            if (buf.length < 10000 || buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error('not a JPEG');
            fs.writeFileSync(`${file}.part`, buf);
            fs.renameSync(`${file}.part`, file);
          } catch (e) {
            log.warn(`news: Bing picture ${id}: ${e.message}`);
            continue;
          }
        }
        images.push({ file, credit: String(im.copyright || '').trim(), title: String(im.title || '').trim() });
      }
      // Keep only the pictures still in the list.
      const keep = new Set(images.map((i) => path.basename(i.file)));
      for (const f of fs.readdirSync(BING_DIR)) if (!keep.has(f) && /\.(jpg|part)$/.test(f)) fs.rmSync(path.join(BING_DIR, f), { force: true });
      if (images.length) bing = { at: now, images };
      return images;
    })().catch((e) => {
      log.warn(`news: Bing pictures unavailable (${e.message})${bing.images.length ? '; using the ones kept' : ''}`);
      bing.at = now - BING_TTL + 15 * 60000; // try again in 15 minutes
      return bing.images;
    }).finally(() => { bingPromise = null; });
  }
  return bingPromise;
}

/** The pictures already on disk, without asking Bing: what survives a restart while the list is fetched. */
export function keptBingImages() {
  try {
    return fs.readdirSync(BING_DIR).filter((f) => f.endsWith('.jpg')).map((f) => ({ file: path.join(BING_DIR, f), credit: '', title: '' }));
  } catch { return []; }
}

export const _test = { cache, resetBing: () => { bing = { at: 0, images: [] }; } };
