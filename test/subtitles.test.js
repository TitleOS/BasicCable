import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickSubtitle, subtitlePlan, burnFilter } from '../src/subtitles.js';

const sub = (codec, language, title, disposition = {}) => ({
  codec_type: 'subtitle', codec_name: codec, tags: { ...(language ? { language } : {}), ...(title ? { title } : {}) }, disposition,
});

test('prefers an English SDH track', () => {
  const subs = [sub('subrip', 'eng', 'English'), sub('subrip', 'spa'), sub('subrip', 'eng', 'English SDH')];
  assert.equal(pickSubtitle(subs).index, 2);
});

test('recognises SDH from the hearing-impaired flag', () => {
  const subs = [sub('subrip', 'eng'), sub('subrip', 'eng', null, { hearing_impaired: 1 })];
  assert.equal(pickSubtitle(subs).index, 1);
});

test('otherwise takes the first English or unlabelled track', () => {
  assert.equal(pickSubtitle([sub('subrip', 'fre'), sub('subrip', 'eng'), sub('subrip', 'eng', 'English (2)')]).index, 1);
  assert.equal(pickSubtitle([sub('subrip', 'fre'), sub('subrip', 'und'), sub('subrip', 'eng')]).index, 1);
  assert.equal(pickSubtitle([sub('subrip', 'ger'), sub('ass', null)]).index, 1);
});

test('skips forced-only tracks, foreign tracks and unsupported formats', () => {
  assert.equal(pickSubtitle([sub('subrip', 'eng', 'Forced')]), null);
  assert.equal(pickSubtitle([sub('subrip', 'eng', null, { forced: 1 }), sub('subrip', 'eng')]).index, 1);
  assert.equal(pickSubtitle([sub('subrip', 'jpn'), sub('dvb_teletext', 'eng')]), null);
});

test('SDH outranks an earlier plain English track even when it is an image track', () => {
  const pick = pickSubtitle([sub('subrip', 'eng', 'English'), sub('hdmv_pgs_subtitle', 'eng', 'English (SDH)')]);
  assert.equal(pick.index, 1);
  assert.equal(pick.kind, 'bitmap');
});

test('delivery depends on mode and format', () => {
  const text = [sub('subrip', 'eng')];
  const image = [sub('hdmv_pgs_subtitle', 'eng')];
  assert.equal(subtitlePlan(text, 'auto').delivery, 'vtt');
  assert.equal(subtitlePlan(image, 'auto').delivery, 'burn');
  assert.equal(subtitlePlan(text, 'soft').delivery, 'vtt');
  assert.equal(subtitlePlan(image, 'soft'), null);
  assert.equal(subtitlePlan(text, 'off'), null);
  assert.equal(subtitlePlan([], 'auto'), null);
  // "Selectable only" falls back to a text track when the SDH track is an image.
  const mixed = [sub('subrip', 'eng', 'English'), sub('hdmv_pgs_subtitle', 'eng', 'English SDH')];
  assert.equal(subtitlePlan(mixed, 'auto').index, 1);
  assert.equal(subtitlePlan(mixed, 'soft').index, 0);
});

test('burnFilter scales the subtitle canvas to the video width and bottom-aligns it', () => {
  // 2.39:1 1080p encode with a 1920x1080 PGS canvas.
  const f = burnFilter({ width: 1920, height: 804 }, { width: 1920, height: 1080 }, 0);
  assert.match(f, /\[0:s:0\]scale=1920:1080\[subs\]/);
  assert.match(f, /overlay=x=0:y=-276/);
  // 4K is brought down to 1080p before burning in.
  const g = burnFilter({ width: 3840, height: 2160 }, { width: 1920, height: 1080 }, 2);
  assert.match(g, /\[0:v:0\]scale=1920:1080\[base\]/);
  assert.match(g, /\[0:s:2\]scale=1920:1080\[subs\]/);
  assert.match(g, /overlay=x=0:y=0/);
});
