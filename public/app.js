// StreamTube web UI — no build step, no framework.

const $view = document.getElementById('view');
const state = { info: null, offset: 0, tz: undefined, view: null, timers: [] };
const MIN = 60000;
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// ---------------------------------------------------------------- helpers

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'selected' || k === 'disabled') el[k] = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'content-type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function toast(msg, error = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast' + (error ? ' error' : '');
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, error ? 6000 : 2500);
}

async function busy(btn, fn) {
  const label = btn?.textContent;
  if (btn) { btn.disabled = true; btn.replaceChildren(h('span', { class: 'spin' }), ' ', label); }
  try {
    return await fn();
  } catch (e) {
    toast(e.message, true);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = label; }
  }
}

const now = () => Date.now() + state.offset;
const fmtTime = (ms, opts = {}) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZone: state.tz, ...opts });
const fmtDay = (ms) => new Date(ms).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', timeZone: state.tz });
function dur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${mm}:${String(ss).padStart(2, '0')}`;
}
const poster = (src, cls = 'ph') => (src ? h('img', { src, alt: '', loading: 'lazy', onerror: (e) => e.target.replaceWith(h('div', { class: cls })) }) : h('div', { class: cls }));
function every(ms, fn) { fn(); state.timers.push(setInterval(fn, ms)); }

function openModal(...content) {
  const m = document.getElementById('modal');
  document.getElementById('modal-card').replaceChildren(...content);
  m.hidden = false;
}
function closeModal() { document.getElementById('modal').hidden = true; }
document.getElementById('modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

function stremioLink(channelId) {
  return `stremio:///detail/tv/${encodeURIComponent(`streamtube:${channelId}`)}/${encodeURIComponent(`streamtube:${channelId}`)}`;
}

// ---------------------------------------------------------------- clock

function startClock() {
  const t = document.getElementById('clock-time');
  const d = document.getElementById('clock-date');
  const tick = () => {
    t.textContent = fmtTime(now(), { second: '2-digit' });
    d.textContent = `${fmtDay(now())} · ${state.tz || ''}`;
  };
  tick();
  setInterval(tick, 1000);
}

// ---------------------------------------------------------------- guide

async function viewGuide() {
  const wrap = h('div', {});
  $view.replaceChildren(h('h1', {}, 'Guide'), h('p', { class: 'sub' }, 'What is on right now, live. Click a program for details and the stream it would pick.'), wrap);
  let data;
  const load = async () => {
    const t = now();
    data = await api(`/api/guide?from=${t - 30 * MIN}&to=${t + 8 * 60 * MIN}`);
    state.offset = data.serverTime - Date.now();
    render();
  };
  const render = () => {
    if (!data.channels.length) {
      wrap.replaceChildren(h('div', { class: 'empty' }, 'No channels yet. ', h('a', { href: '#/channels/new' }, 'Create your first channel'), '.'));
      return;
    }
    wrap.replaceChildren(nowStrip(data), epgGrid(data));
  };
  await load();
  state.timers.push(setInterval(load, MIN));
}

function nowStrip(data) {
  const strip = h('div', { class: 'now-strip' });
  for (const c of data.channels.filter((x) => x.enabled)) {
    const t = now();
    const cur = c.items.find((i) => i.start <= t && i.end > t);
    const next = c.items.find((i) => i.start >= (cur ? cur.end : t));
    const bar = h('i');
    const times = h('div', { class: 'times' });
    const card = h('div', { class: 'now-card', onclick: () => cur && showProgram(c, cur) },
      poster(cur?.poster),
      h('div', { class: 'body' },
        h('div', { class: 'ch' }, h('b', {}, c.number), c.name, c.live ? h('span', { class: 'badge live', title: c.live.stream?.label || c.live.message || '' }, c.live.state === 'playing' ? 'STREAMING' : c.live.state.toUpperCase()) : null),
        h('div', { class: 'title' }, cur ? cur.title : 'Off air'),
        h('div', { class: 'ep' }, cur && cur.season != null ? `S${String(cur.season).padStart(2, '0')}E${String(cur.episode).padStart(2, '0')} · ${cur.episode_title || ''}` : cur ? 'Movie' : ''),
        h('div', { class: 'progress' }, bar), times,
        h('div', { class: 'next' }, next ? `Next ${fmtTime(next.start)} · ${next.label}` : '')));
    const tick = () => {
      if (!cur) return;
      const n = now();
      bar.style.width = `${Math.min(100, ((n - cur.start) / (cur.end - cur.start)) * 100)}%`;
      times.replaceChildren(h('span', {}, `${dur(n - cur.start)} in`), h('span', {}, `${dur(cur.end - n)} left`));
    };
    every(1000, tick);
    strip.append(card);
  }
  return strip;
}

function epgGrid(data) {
  const px = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--px-per-min')) || 6;
  const from = data.from, to = data.to;
  const width = ((to - from) / MIN) * px;
  const x = (ms) => ((ms - from) / MIN) * px;

  const ticks = h('div', { class: 'epg-ticks', style: { width: `${width}px` } });
  const first = Math.ceil(from / (30 * MIN)) * 30 * MIN;
  for (let t = first; t < to; t += 30 * MIN) ticks.append(h('span', { style: { left: `${x(t)}px` } }, fmtTime(t)));

  const rows = data.channels.map((c) => {
    const track = h('div', { class: 'epg-track', style: { width: `${width}px` } });
    for (const it of c.items) {
      const left = Math.max(0, x(it.start));
      const right = Math.min(width, x(it.end));
      if (right <= left) continue;
      const t = now();
      const cls = ['prog', it.origin === 'slot' && 'slot', it.end <= t && 'past', it.start <= t && it.end > t && 'on'].filter(Boolean).join(' ');
      track.append(h('div', {
        class: cls, style: { left: `${left}px`, width: `${right - left - 3}px` }, title: `${fmtTime(it.start)}–${fmtTime(it.end)} ${it.label}`,
        onclick: () => showProgram(c, it),
      }, h('b', {}, it.title), h('small', {}, `${fmtTime(it.start)} · ${it.season != null ? `S${it.season}E${it.episode} ${it.episode_title}` : 'Movie'}${it.truncated ? ' · cut short' : ''}`)));
    }
    return h('div', { class: 'epg-row' },
      h('div', { class: 'epg-chan', onclick: () => { location.hash = `#/channels/${c.id}`; } },
        h('span', { class: 'num' }, c.number),
        h('div', { style: { minWidth: 0 } }, h('div', { class: 'nm' }, c.name), h('small', {}, `${c.resolution}p${c.enabled ? '' : ' · disabled'}`))),
      track);
  });

  const line = h('div', { class: 'now-line' });
  const inner = h('div', { class: 'epg-inner', style: { width: `calc(var(--chan-col) + ${width}px)` } },
    h('div', { class: 'epg-head' }, h('div', { class: 'corner' }, fmtDay(now())), ticks), ...rows, line);
  const scroll = h('div', { class: 'epg-scroll' }, inner);
  every(1000, () => {
    const chanCol = rows[0]?.firstChild.offsetWidth || 190;
    line.style.left = `${chanCol + x(now())}px`;
  });
  requestAnimationFrame(() => { scroll.scrollLeft = Math.max(0, x(now()) - 60); });
  return h('div', { class: 'epg' }, scroll);
}

async function showProgram(channel, it) {
  const candBox = h('div', {});
  const t = now();
  const live = it.start <= t && it.end > t;
  openModal(
    h('div', { class: 'prog-detail' },
      it.poster ? h('img', { src: it.poster, alt: '' }) : null,
      h('div', { style: { flex: 1, minWidth: 0 } },
        h('div', { class: 'muted' }, `Channel ${channel.number} · ${channel.name}`),
        h('h2', { style: { margin: '4px 0' } }, it.label),
        h('div', { class: 'row muted' }, `${fmtDay(it.start)} · ${fmtTime(it.start)}–${fmtTime(it.end)}`,
          h('span', { class: 'badge' }, it.origin === 'slot' ? 'time slot' : 'auto-fill'),
          it.truncated ? h('span', { class: 'badge warn' }, 'cut short') : null,
          live ? h('span', { class: 'badge live' }, `LIVE · ${dur(t - it.start)} in`) : null),
        h('p', {}, it.description || ''),
        h('div', { class: 'row' },
          h('a', { class: 'btn primary', href: stremioLink(channel.id) }, 'Open in Stremio'),
          h('button', { class: 'btn', onclick: (e) => busy(e.currentTarget, () => loadCandidates(channel, it, candBox, true)) }, 'Which stream would play?'),
          h('button', { class: 'btn ghost', onclick: closeModal }, 'Close')))),
    candBox);
}

async function loadCandidates(channel, it, box, fresh) {
  const d = await api(`/api/channels/${channel.id}/streams?item=${it.id}${fresh ? '&fresh=1' : ''}`);
  if (d.error) return box.replaceChildren(h('p', { class: 'muted' }, d.error));
  if (!d.candidates.length) return box.replaceChildren(h('p', { class: 'muted' }, 'No cached debrid streams were found for this item. It will show a "couldn\'t play" slate.'));
  box.replaceChildren(
    h('h3', { style: { marginTop: '16px' } }, `Ranked streams (target ${d.target}p, then ${d.fallback === 'higher' ? 'higher' : 'lower'} first)`),
    h('table', { class: 'cands' }, d.candidates.map((c, i) => h('tr', { class: i === 0 ? 'pick' : '' },
      h('td', {}, i === 0 ? '▶' : i + 1),
      h('td', {}, c.resolution ? `${c.resolution}p` : '?'),
      h('td', {}, c.cached ? h('span', { class: 'badge ok' }, 'cached') : ''),
      h('td', {}, c.label)))));
}

// ---------------------------------------------------------------- channels

async function viewChannels(id) {
  const channels = await api('/api/channels');
  if (!id && channels.length) id = String(channels[0].id);
  const list = h('div', { class: 'chan-list' },
    channels.map((c) => h('a', { class: `chan-item${String(c.id) === id ? ' active' : ''}`, href: `#/channels/${c.id}` },
      h('span', { class: 'num' }, c.number), h('span', {}, c.name), c.enabled ? null : h('span', { class: 'badge' }, 'off'))),
    h('a', { class: `chan-item${id === 'new' ? ' active' : ''}`, href: '#/channels/new' }, h('span', { class: 'num' }, '+'), 'New channel'));
  const editor = h('div', {});
  $view.replaceChildren(h('h1', {}, 'Channels'), h('p', { class: 'sub' }, 'Each channel has an auto-fill pool (plays whenever no slot is active) and optional weekly time slots.'),
    h('div', { class: 'split' }, list, editor));
  if (!id || id === 'new') return editor.append(channelForm(null));
  const ch = channels.find((c) => String(c.id) === id);
  if (!ch) return editor.append(h('div', { class: 'empty' }, 'Channel not found.'));
  editor.append(channelForm(ch), poolPanel(ch), slotsPanel(ch), dangerPanel(ch));
}

function channelForm(ch) {
  const c = ch || { name: '', number: '', logo: '', resolution: state.info?.defaultResolution || 1080, fallback: 'lower', fill_mode: 'shuffle', round_minutes: 5, enabled: 1, options: {} };
  const o = { avoidDolbyVision: true, audio: 'aac', audioLanguage: 'eng', excludeKeywords: [], ...c.options };
  const f = {
    name: h('input', { type: 'text', value: c.name, placeholder: 'e.g. Sitcoms' }),
    number: h('input', { type: 'number', min: 1, value: c.number, placeholder: 'auto' }),
    logo: h('input', { type: 'url', value: c.logo, placeholder: 'optional image URL' }),
    resolution: h('select', {}, (state.info?.resolutions || [2160, 1440, 1080, 720, 576, 480]).map((r) => h('option', { value: r, selected: r === c.resolution }, r === 2160 ? '2160p (4K)' : `${r}p`))),
    fallback: h('select', {}, h('option', { value: 'lower', selected: c.fallback !== 'higher' }, 'Next lower resolution first'), h('option', { value: 'higher', selected: c.fallback === 'higher' }, 'Next higher resolution first')),
    fill_mode: h('select', {},
      h('option', { value: 'shuffle', selected: c.fill_mode === 'shuffle' }, 'Shuffle shows, episodes in order'),
      h('option', { value: 'sequential', selected: c.fill_mode === 'sequential' }, 'Rotate shows in order, episodes in order'),
      h('option', { value: 'random', selected: c.fill_mode === 'random' }, 'Random episodes')),
    round_minutes: h('select', {}, [0, 1, 5, 10, 15, 30].map((m) => h('option', { value: m, selected: m === c.round_minutes }, m ? `Round up to ${m} min` : 'Exact runtime'))),
    audioLanguage: h('input', { type: 'text', value: o.audioLanguage, maxlength: 3, placeholder: 'eng' }),
    audio: h('select', {}, h('option', { value: 'aac', selected: o.audio !== 'copy' }, 'Convert to stereo AAC (most compatible)'), h('option', { value: 'copy', selected: o.audio === 'copy' }, 'Pass through original audio')),
    excludeKeywords: h('input', { type: 'text', value: (o.excludeKeywords || []).join(', '), placeholder: 'e.g. HEVC, x265, REMUX' }),
    avoidDolbyVision: h('input', { type: 'checkbox', checked: o.avoidDolbyVision !== false }),
    includeSpecials: h('input', { type: 'checkbox', checked: !!o.includeSpecials }),
    enabled: h('input', { type: 'checkbox', checked: !!c.enabled }),
  };
  const save = async (btn) => busy(btn, async () => {
    const body = {
      name: f.name.value, logo: f.logo.value, resolution: Number(f.resolution.value), fallback: f.fallback.value,
      fill_mode: f.fill_mode.value, round_minutes: Number(f.round_minutes.value), enabled: f.enabled.checked,
      options: {
        audioLanguage: f.audioLanguage.value, audio: f.audio.value, excludeKeywords: f.excludeKeywords.value,
        avoidDolbyVision: f.avoidDolbyVision.checked, includeSpecials: f.includeSpecials.checked,
      },
    };
    if (f.number.value) body.number = Number(f.number.value);
    const saved = ch ? await api(`/api/channels/${ch.id}`, { method: 'PUT', body }) : await api('/api/channels', { method: 'POST', body });
    toast(ch ? 'Channel saved' : 'Channel created — now add some shows');
    if (ch) route(); else location.hash = `#/channels/${saved.id}`;
  });
  const field = (label, el, hint) => h('label', { class: 'field' }, label, el, hint ? h('span', { class: 'hint' }, hint) : null);
  return h('div', { class: 'panel' },
    h('h2', {}, ch ? `${c.number} · ${c.name}` : 'New channel'),
    h('div', { class: 'grid-form' },
      field('Name', f.name), field('Channel number', f.number), field('Logo', f.logo),
      field('Target resolution', f.resolution, 'The picker matches this first'),
      field('If the target isn\'t available', f.fallback),
      field('Auto-fill order', f.fill_mode),
      field('Slot length', f.round_minutes, 'Padding absorbs runtime differences'),
      field('Audio language', f.audioLanguage, 'ISO 639-2, e.g. eng, spa, jpn'),
      field('Audio', f.audio),
      field('Skip streams containing', f.excludeKeywords, 'Comma separated')),
    h('div', { class: 'row', style: { marginTop: '14px' } },
      h('label', { class: 'check' }, f.enabled, 'Enabled'),
      h('label', { class: 'check' }, f.avoidDolbyVision, 'Avoid Dolby Vision-only releases'),
      h('label', { class: 'check' }, f.includeSpecials, 'Include specials (season 0)'),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn primary', onclick: (e) => save(e.currentTarget) }, ch ? 'Save' : 'Create channel')));
}

// --- title search (used for the pool and for slots)
function titlePicker(onPick, { allowWildcard = true, pickLabel = 'Add' } = {}) {
  let mode = 'search';
  let type = 'all';
  const input = h('input', { type: 'text', placeholder: 'Search shows and movies…', style: { flex: 1, minWidth: '200px' } });
  const typeSel = h('select', {}, h('option', { value: 'all' }, 'Shows & movies'), h('option', { value: 'series' }, 'Shows'), h('option', { value: 'movie' }, 'Movies'));
  const out = h('div', {});
  const go = h('button', { class: 'btn' }, 'Search');
  const modeSeg = h('div', { class: 'seg' });
  const setMode = (m) => {
    mode = m;
    modeSeg.replaceChildren(
      h('button', { class: m === 'search' ? 'on' : '', onclick: () => setMode('search') }, 'Search'),
      allowWildcard ? h('button', { class: m === 'wildcard' ? 'on' : '', onclick: () => setMode('wildcard') }, 'Wildcard') : null);
    input.placeholder = m === 'search' ? 'Search shows and movies…' : 'Pattern, e.g. Star Trek*  or  *Batman*';
    go.textContent = m === 'search' ? 'Search' : 'Preview matches';
    out.replaceChildren(m === 'wildcard' ? h('p', { class: 'hint' }, '* matches anything, ? matches one character. New titles that match are picked up automatically each day.') : '');
  };
  setMode('search');
  const run = () => busy(go, async () => {
    const q = input.value.trim();
    if (!q) return;
    type = typeSel.value;
    if (mode === 'search') {
      const { results } = await api(`/api/search?q=${encodeURIComponent(q)}&type=${type}`);
      out.replaceChildren(results.length ? h('div', { class: 'results' }, results.map((r) => h('div', { class: 'result' },
        poster(r.poster),
        h('div', { class: 'body' },
          h('div', { class: 'name' }, r.name),
          h('div', { class: 'muted', style: { fontSize: '12px' } }, `${r.type === 'series' ? 'Show' : 'Movie'}${r.releaseInfo ? ` · ${r.releaseInfo}` : ''}`),
          h('button', { class: 'btn small', onclick: (e) => busy(e.currentTarget, () => onPick({ kind: r.type, ref: r.id, name: r.name, poster: r.poster })) }, pickLabel))))) : h('p', { class: 'muted' }, 'Nothing found.'));
    } else {
      const types = type === 'all' ? 'series,movie' : type;
      const { results } = await api(`/api/wildcard?pattern=${encodeURIComponent(q)}&types=${types}`);
      out.replaceChildren(
        h('div', { class: 'row', style: { marginTop: '10px' } },
          h('b', {}, `${results.length} match${results.length === 1 ? '' : 'es'} for "${q}"`),
          h('span', { class: 'spacer' }),
          h('button', { class: 'btn primary small', disabled: !results.length, onclick: (e) => busy(e.currentTarget, () => onPick({ kind: 'wildcard', ref: q, name: q, options: { types: types.split(',') } })) }, `${pickLabel} wildcard`)),
        h('div', { class: 'results' }, results.map((r) => h('div', { class: 'result' }, poster(r.poster),
          h('div', { class: 'body' }, h('div', { class: 'name' }, r.name), h('div', { class: 'muted', style: { fontSize: '12px' } }, r.releaseInfo || ''))))));
    }
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
  go.addEventListener('click', run);
  return h('div', {}, h('div', { class: 'row' }, modeSeg, input, typeSel, go), out);
}

function sourceCard(ch, s) {
  const remove = (btn) => busy(btn, async () => { await api(`/api/channels/${ch.id}/sources/${s.id}`, { method: 'DELETE' }); toast(`Removed ${s.name}`); route(); });
  const kindLabel = { series: 'Show', movie: 'Movie', wildcard: 'Wildcard' }[s.kind];
  let extra = null;
  if (s.kind === 'wildcard') {
    const excluded = new Set(s.options.excluded || []);
    const resolved = s.options.resolved || [];
    extra = h('div', {},
      h('div', { class: 'muted', style: { fontSize: '12px' } }, `${resolved.length - resolved.filter((r) => excluded.has(r.id)).length} of ${resolved.length} titles active · ${(s.options.types || ['series']).join(' & ')}`),
      h('div', { class: 'matches' }, resolved.map((r) => h('label', { class: 'check' },
        h('input', {
          type: 'checkbox', checked: !excluded.has(r.id),
          onchange: async (e) => {
            if (e.target.checked) excluded.delete(r.id); else excluded.add(r.id);
            try { await api(`/api/channels/${ch.id}/sources/${s.id}`, { method: 'PUT', body: { excluded: [...excluded] } }); toast('Schedule updated'); } catch (err) { toast(err.message, true); }
          },
        }), r.name))),
      h('button', { class: 'btn small ghost', style: { marginTop: '4px' }, onclick: (e) => busy(e.currentTarget, async () => { await api(`/api/channels/${ch.id}/sources/${s.id}`, { method: 'PUT', body: { refresh: true } }); route(); }) }, 'Re-scan matches'));
  }
  return h('div', { class: 'source' },
    s.kind === 'wildcard' ? h('div', { class: 'ph' }, '*') : poster(s.poster),
    h('div', { class: 'body' },
      h('div', { class: 'row', style: { flexWrap: 'nowrap' } }, h('div', { class: 'name', style: { flex: 1 } }, s.name), h('span', { class: 'badge' }, kindLabel)),
      extra,
      h('button', { class: 'btn small danger ghost', onclick: (e) => remove(e.currentTarget) }, 'Remove')));
}

function poolPanel(ch) {
  const add = async (spec) => {
    await api(`/api/channels/${ch.id}/sources`, { method: 'POST', body: spec });
    toast(`Added ${spec.name}`);
    route();
  };
  return h('div', { class: 'panel' },
    h('h2', {}, 'Auto-fill pool'),
    h('p', { class: 'hint', style: { marginTop: '-6px', marginBottom: '12px' } }, 'Fills every hour that has no time slot. Shows play their episodes in order and remember where they left off.'),
    ch.sources.length ? h('div', { class: 'sources' }, ch.sources.map((s) => sourceCard(ch, s))) : h('div', { class: 'empty' }, 'The pool is empty. Search below to add shows, movies or a wildcard.'),
    h('div', { style: { marginTop: '16px' } }, titlePicker(add)));
}

function slotsPanel(ch) {
  const daysCell = (days) => {
    const on = new Set(String(days).split(',').map(Number));
    return h('div', { class: 'days' }, DAY_NAMES.map((d, i) => h('span', { class: on.has(i + 1) ? 'on' : '' }, d[0])));
  };
  const endOf = (s) => {
    const [hh, mm] = s.start.split(':').map(Number);
    const total = hh * 60 + mm + s.minutes;
    return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}${total >= 1440 ? ' (+1)' : ''}`;
  };
  const del = (btn, s) => busy(btn, async () => { await api(`/api/channels/${ch.id}/slots/${s.id}`, { method: 'DELETE' }); toast('Slot removed'); route(); });
  return h('div', { class: 'panel' },
    h('div', { class: 'row' }, h('h2', { style: { margin: 0 } }, 'Time slots'), h('span', { class: 'spacer' }),
      h('button', { class: 'btn primary', onclick: () => slotEditor(ch) }, 'Add slot')),
    h('p', { class: 'hint', style: { marginBottom: '12px' } }, `Weekly blocks that always air the same thing, like "Weeknights 8:00 PM: Modern Family". Times are in ${state.tz}.`),
    ch.slots.length ? h('table', { class: 'slots' },
      h('tr', {}, h('th', {}, 'Days'), h('th', {}, 'Time'), h('th', {}, 'Plays'), h('th', {}, 'Order'), h('th', {})),
      ch.slots.map((s) => h('tr', {},
        h('td', {}, daysCell(s.days)),
        h('td', {}, `${s.start}–${endOf(s)}`, h('div', { class: 'muted', style: { fontSize: '12px' } }, `${s.minutes} min`)),
        h('td', {}, s.content.name, ' ', h('span', { class: 'badge' }, { series: 'Show', movie: 'Movie', wildcard: 'Wildcard', pool: 'Pool' }[s.content.kind])),
        h('td', {}, s.content.kind === 'movie' ? '—' : s.play_order === 'random' ? 'Random' : 'In order'),
        h('td', { style: { textAlign: 'right', whiteSpace: 'nowrap' } },
          h('button', { class: 'btn small ghost', onclick: () => slotEditor(ch, s) }, 'Edit'),
          h('button', { class: 'btn small ghost danger', onclick: (e) => del(e.currentTarget, s) }, 'Delete'))))) : h('div', { class: 'empty' }, 'No slots — the whole day is auto-filled from the pool.'));
}

function slotEditor(ch, slot) {
  const s = slot || { days: '1,2,3,4,5', start: '20:00', minutes: 60, content: null, play_order: 'sequential' };
  const on = new Set(String(s.days).split(',').map(Number));
  const dayBoxes = DAY_NAMES.map((d, i) => h('input', { type: 'checkbox', checked: on.has(i + 1), value: i + 1 }));
  const setDays = (arr) => dayBoxes.forEach((b, i) => { b.checked = arr.includes(i + 1); });
  const start = h('input', { type: 'time', value: s.start, step: 300 });
  const minutes = h('input', { type: 'number', min: 5, max: 1440, step: 5, value: s.minutes, style: { width: '110px' } });
  const order = h('select', {}, h('option', { value: 'sequential', selected: s.play_order !== 'random' }, 'Episodes in order'), h('option', { value: 'random', selected: s.play_order === 'random' }, 'Random episodes'));
  let content = s.content;
  const chosen = h('div', { class: 'row' });
  const showChosen = () => chosen.replaceChildren(h('b', {}, 'Plays: '), content ? h('span', {}, content.name, ' ', h('span', { class: 'badge' }, content.kind)) : h('span', { class: 'muted' }, 'nothing picked yet'),
    h('button', { class: 'btn small', onclick: () => { content = { kind: 'pool', ref: '', name: 'Channel auto-fill pool' }; showChosen(); } }, 'Use the auto-fill pool'));
  showChosen();
  const picker = titlePicker(async (spec) => { content = spec; showChosen(); toast(`Picked ${spec.name}`); }, { pickLabel: 'Pick' });
  const save = (btn) => busy(btn, async () => {
    const body = { days: dayBoxes.filter((b) => b.checked).map((b) => Number(b.value)), start: start.value, minutes: Number(minutes.value), content, play_order: order.value };
    if (slot) await api(`/api/channels/${ch.id}/slots/${slot.id}`, { method: 'PUT', body });
    else await api(`/api/channels/${ch.id}/slots`, { method: 'POST', body });
    closeModal();
    toast('Slot saved, guide rebuilt');
    route();
  });
  openModal(
    h('h2', {}, slot ? 'Edit time slot' : 'New time slot'),
    h('div', { class: 'day-picker' }, dayBoxes.map((b, i) => h('label', {}, b, h('span', {}, DAY_NAMES[i])))),
    h('div', { class: 'row', style: { margin: '8px 0 14px' } },
      h('button', { class: 'btn small ghost', onclick: () => setDays([1, 2, 3, 4, 5]) }, 'Weekdays'),
      h('button', { class: 'btn small ghost', onclick: () => setDays([6, 7]) }, 'Weekends'),
      h('button', { class: 'btn small ghost', onclick: () => setDays([1, 2, 3, 4, 5, 6, 7]) }, 'Every day')),
    h('div', { class: 'row', style: { marginBottom: '14px' } },
      h('label', { class: 'field' }, 'Starts at', start),
      h('label', { class: 'field' }, 'Length (minutes)', minutes),
      h('label', { class: 'field' }, 'Order', order)),
    chosen,
    h('div', { style: { margin: '12px 0' } }, picker),
    h('div', { class: 'row' }, h('span', { class: 'spacer' }),
      h('button', { class: 'btn ghost', onclick: closeModal }, 'Cancel'),
      h('button', { class: 'btn primary', onclick: (e) => save(e.currentTarget) }, 'Save slot')));
}

function dangerPanel(ch) {
  return h('div', { class: 'panel row' },
    h('a', { class: 'btn', href: stremioLink(ch.id) }, 'Open in Stremio'),
    h('button', { class: 'btn', onclick: (e) => busy(e.currentTarget, async () => { await api(`/api/channels/${ch.id}/rebuild`, { method: 'POST' }); toast('Upcoming guide rebuilt'); }) }, 'Rebuild upcoming guide'),
    h('span', { class: 'spacer' }),
    h('button', {
      class: 'btn danger', onclick: (e) => {
        if (!confirm(`Delete channel ${ch.number} "${ch.name}"? Its schedule is removed too.`)) return;
        busy(e.currentTarget, async () => { await api(`/api/channels/${ch.id}`, { method: 'DELETE' }); toast('Channel deleted'); location.hash = '#/channels'; });
      },
    }, 'Delete channel'));
}

// ---------------------------------------------------------------- settings

async function viewSettings() {
  const s = await api('/api/settings');
  const addons = h('textarea', { placeholder: 'https://torrentio.strem.fun/realdebrid=YOUR_KEY/manifest.json' }, (s.streamAddons || []).join('\n'));
  const meta = h('input', { type: 'url', value: s.metaAddon, style: { width: '100%' } });
  const tz = h('input', { type: 'text', value: s.timezone, list: 'tzlist' });
  const tzlist = h('datalist', { id: 'tzlist' }, (Intl.supportedValuesOf?.('timeZone') || []).map((z) => h('option', { value: z })));
  const pub = h('input', { type: 'url', value: s.publicUrl, placeholder: `${location.origin}`, style: { width: '100%' } });
  const res = h('select', {}, [2160, 1440, 1080, 720, 576, 480].map((r) => h('option', { value: r, selected: r === s.defaultResolution }, `${r}p`)));
  const testOut = h('div', {});
  const test = (btn) => busy(btn, async () => {
    const urls = addons.value.split('\n').map((x) => x.trim()).filter(Boolean);
    if (!urls.length) return toast('Add an addon URL first', true);
    testOut.replaceChildren();
    for (const url of urls) {
      try {
        const r = await api('/api/test-addon', { method: 'POST', body: { url } });
        testOut.append(h('div', { class: 'panel', style: { background: 'var(--panel-2)' } },
          h('div', { class: 'row' }, h('b', {}, r.name || r.base), r.playable ? h('span', { class: 'badge ok' }, `${r.playable} playable`) : h('span', { class: 'badge warn' }, 'nothing playable')),
          h('div', { class: 'muted', style: { fontSize: '12px' } }, `Test title Modern Family S01E01: ${r.total} streams, ${r.withUrl} with direct links, ${r.playable} cached & usable.`),
          r.hint ? h('p', { class: 'hint' }, r.hint) : null,
          r.error ? h('p', { class: 'hint' }, r.error) : null,
          r.sample?.map((x) => h('div', { style: { fontSize: '12px' } }, `▶ ${x.resolution || '?'}p ${x.cached ? '(cached) ' : ''}${x.label}`))));
      } catch (e) {
        testOut.append(h('div', { class: 'panel' }, h('b', {}, url.replace(/\/\/([^/]+)\/.*/, '//$1/…')), h('p', { class: 'hint' }, e.message)));
      }
    }
  });
  const save = (btn) => busy(btn, async () => {
    await api('/api/settings', { method: 'PUT', body: { streamAddons: addons.value, metaAddon: meta.value, timezone: tz.value, publicUrl: pub.value, defaultResolution: Number(res.value) } });
    state.info = await api('/api/info');
    state.tz = state.info.timezone;
    toast('Settings saved');
  });
  $view.replaceChildren(
    h('h1', {}, 'Settings'), h('p', { class: 'sub' }, 'Stored in the container\'s data volume.'),
    h('div', { class: 'panel' },
      h('h2', {}, 'Debrid stream addons'),
      h('p', { class: 'hint', style: { marginTop: '-6px', marginBottom: '10px' } },
        'Paste the manifest URL of each Stremio addon you have configured with your debrid service (Torrentio, Comet, MediaFusion, AIOStreams, Jackettio…), one per line. ',
        'Your debrid key is already part of that URL. StreamTube asks all of them and only uses cached, direct links.'),
      addons,
      h('div', { class: 'row', style: { marginTop: '10px' } }, h('button', { class: 'btn', onclick: (e) => test(e.currentTarget) }, 'Test addons')),
      testOut),
    h('div', { class: 'panel' },
      h('div', { class: 'grid-form' },
        h('label', { class: 'field' }, 'Timezone for schedules', tz, tzlist),
        h('label', { class: 'field' }, 'Default resolution for new channels', res)),
      h('label', { class: 'field', style: { marginTop: '12px' } }, 'Public URL of this server (optional)', pub,
        h('span', { class: 'hint' }, 'Leave empty to use whatever address Stremio used to install the addon. Set it if you use a reverse proxy.')),
      h('label', { class: 'field', style: { marginTop: '12px' } }, 'Metadata addon', meta,
        h('span', { class: 'hint' }, 'Used for search, episode lists and runtimes. Cinemeta is what Stremio itself uses.'))),
    h('div', { class: 'row' }, h('span', { class: 'spacer' }), h('button', { class: 'btn primary', onclick: (e) => save(e.currentTarget) }, 'Save settings')));
}

// ---------------------------------------------------------------- connect

async function viewConnect() {
  const i = await api('/api/info');
  const copyRow = (label, value, extra) => h('div', { style: { marginBottom: '14px' } },
    h('div', { class: 'muted', style: { fontSize: '12px', marginBottom: '4px' } }, label),
    h('div', { class: 'copy' }, h('input', { type: 'text', value, readonly: true, onclick: (e) => e.target.select() }),
      h('button', { class: 'btn', onclick: async () => { try { await navigator.clipboard.writeText(value); toast('Copied'); } catch { toast('Select the text and copy it manually', true); } } }, 'Copy'), extra));
  const local = /\/\/(localhost|127\.0\.0\.1)/.test(i.manifestUrl);
  $view.replaceChildren(
    h('h1', {}, 'Connect'), h('p', { class: 'sub' }, 'Add StreamTube to Stremio or any IPTV player.'),
    h('div', { class: 'panel' },
      h('h2', {}, 'Stremio'),
      local ? h('p', { class: 'hint', style: { color: 'var(--warn)' } }, 'You opened this page via localhost, so this URL only works on this machine. Open the web UI through the server\'s LAN address (or set the Public URL in Settings) to get a link other devices can use.') : null,
      copyRow('Addon manifest URL', i.manifestUrl, i.manifestUrl.startsWith('https://') ? h('a', { class: 'btn primary', href: i.manifestUrl.replace(/^https:\/\//, 'stremio://') }, 'Install') : null),
      i.manifestUrl.startsWith('https://') ? null : h('p', { class: 'hint' }, 'To install, copy this URL, open Stremio → Addons, paste it into the search box at the top and press Install. (A one-click link only works for https addresses.)'),
      h('p', { class: 'hint' }, 'Channels appear under Discover → TV → StreamTube. Opening a channel joins whatever is on, at the current point in the episode. The "Start over" stream plays the current program from the beginning.'),
      h('p', { class: 'hint' }, 'Stremio desktop, Android and Android TV accept a plain http:// LAN address. Stremio Web (web.stremio.com) requires https — put StreamTube behind a reverse proxy with a certificate if you use it there.')),
    h('div', { class: 'panel' },
      h('h2', {}, 'IPTV players (VLC, Kodi, TiviMate, Jellyfin, Plex…)'),
      copyRow('M3U playlist', i.m3uUrl),
      copyRow('XMLTV guide', i.epgUrl)),
    h('div', { class: 'panel' },
      h('h2', {}, 'Server'),
      h('div', { class: 'muted' }, `ffmpeg: ${i.ffmpeg.ok ? `${i.ffmpeg.version}${i.ffmpeg.burst ? '' : ' (old version: tuning in is slower)'}` : `not found — ${i.ffmpeg.error}`}`),
      h('div', { class: 'muted' }, `Timezone: ${i.timezone}`)));
}

// ---------------------------------------------------------------- router

async function route() {
  state.timers.forEach(clearInterval);
  state.timers = [];
  const [view, arg] = location.hash.replace(/^#\/?/, '').split('/');
  const v = view || 'guide';
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === v));
  try {
    if (v === 'channels') await viewChannels(arg);
    else if (v === 'settings') await viewSettings();
    else if (v === 'connect') await viewConnect();
    else await viewGuide();
  } catch (e) {
    $view.replaceChildren(h('div', { class: 'empty' }, `Something went wrong: ${e.message}`));
  }
}

(async function init() {
  try {
    state.info = await api('/api/info');
    state.offset = state.info.serverTime - Date.now();
    state.tz = state.info.timezone;
  } catch (e) {
    toast(e.message, true);
  }
  startClock();
  window.addEventListener('hashchange', route);
  route();
})();
