import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'st-titles-'));
const { normalizeTitle, parseReleaseTitle, streamReleaseTitle, yearRange, namesOtherTitle } = await import('../src/titlematch.js');

test('parseReleaseTitle reads the title (and year) off release and file names', () => {
  const t = (s) => { const r = parseReleaseTitle(s); return r && `${r.name}|${r.year ?? ''}`; };
  assert.equal(t('Star Wars Clone Wars (2003) 1080p - Episode 1.mkv'), 'star wars clone wars|2003');
  assert.equal(t('Star.Wars.The.Clone.Wars.S01e05.Ita.Eng.1080p.h265.10bit.SubS-Me7alh.mkv'), 'star wars the clone wars|');
  assert.equal(t('Star.Wars-The.Clone.Wars.S01E01-Ambush.1080p.BRRip.Opus51.x265.10bit-CAIRN.mkv'), 'star wars the clone wars|');
  assert.equal(t('Star Wars The Clone Wars - 1x01 - Ambush   [DarkDream].mkv'), 'star wars the clone wars|');
  assert.equal(t('📄 Star.Wars.The.Clone.Wars.-.S01E05.-.PGor.-.(HD-Rip.1080i).Rookies.mkv'), 'star wars the clone wars|');
  assert.equal(t('Star Wars Clone Wars [2003] Volume 01.mkv'), 'star wars clone wars|2003');
  assert.equal(t('[QxR] Heat.1995.1080p.BluRay.mkv'), 'heat|1995');
  assert.equal(t('2001.A.Space.Odyssey.1968.2160p.mkv'), '2001 a space odyssey|1968');
  assert.equal(t('Blade.Runner.2049.2017.1080p.mkv'), 'blade runner 2049|2017');
  assert.equal(t('Blade Runner 2049 (2017) 2160p'), 'blade runner 2049|2017');
  assert.equal(t('1917.1080p.WEB.mkv'), '1917|');
  assert.equal(t('Doctor.Who.2023.S01E08.1080p.mkv'), 'doctor who|2023');
  assert.equal(t('Kill.Bill.Vol.2.2004.1080p.mkv'), 'kill bill vol 2|2004');
  assert.equal(t('S01E01 Ambush.mkv'), null);
  assert.equal(t('Episode 1 Ambush.mkv'), null);
  assert.equal(normalizeTitle('Star Wars: Clone Wars'), 'star wars clone wars');
  assert.equal(normalizeTitle("Marvel's Agents of S.H.I.E.L.D."), 'marvels agents of s h i e l d');
  assert.equal(normalizeTitle('Thunderbolts*'), 'thunderbolts');
  assert.equal(normalizeTitle('The Office'), 'office');
});

test('streamReleaseTitle prefers the file name, then a file line, then the torrent name', () => {
  // Torrentio: torrent name, then file name.
  assert.equal(streamReleaseTitle({ title: 'Star Wars The Clone Wars (2008) S01 1080p BluRay AV1 Opus [GRAV1TY]\nS01E01 Ambush.mkv\n👤 60 💾 350.44 MB',
    behaviorHints: { filename: 'S01E01 Ambush.mkv' } }).name, 'star wars the clone wars');
  // A pack named after one show holding another's file: the file decides.
  assert.equal(streamReleaseTitle({ title: 'Star Wars Clone Wars Collection\nStar.Wars.The.Clone.Wars.S01E01.mkv' }).name, 'star wars the clone wars');
  assert.equal(streamReleaseTitle({ description: '📄 Star.Wars.The.Clone.Wars.S01e01.mkv\n📹 hevc • 10bit\n💾 433.0 MB' }).name, 'star wars the clone wars');
});

test('yearRange reads Cinemeta release info', () => {
  assert.deepEqual(yearRange('2003–2005'), [2003, 2005]);
  assert.deepEqual(yearRange('1995'), [1995, 1995]);
  assert.deepEqual(yearRange('2023–'), [2023, new Date().getFullYear()]);
  assert.equal(yearRange(''), null);
});

test('namesOtherTitle: the 2003 Clone Wars and The Clone Wars are told apart', () => {
  const known = new Map([
    ['star wars clone wars', new Set(['tt0361243'])],
    ['star wars the clone wars', new Set(['tt0458290'])],
    ['doctor who', new Set(['tt0436992', 'tt31433814'])],
    ['storage wars', new Set(['tt1785123'])],
    ['storage wars texas', new Set(['tt2128211'])],
  ]);
  const cw2003 = { id: 'tt0361243', names: ['star wars clone wars'], years: [2003, 2005] };
  const tcw = { id: 'tt0458290', names: ['star wars the clone wars'], years: [2008, 2020] };
  const file = (f) => ({ title: `Some pack\n${f}`, behaviorHints: { filename: f } });
  // Comet's answer for the 2003 show: The Clone Wars files.
  assert.equal(namesOtherTitle({ description: '📄 Star.Wars.The.Clone.Wars.S01E05.Rookies.1080p.WEB-DL.mkv' }, cw2003, known), true);
  assert.equal(namesOtherTitle(file('Star Wars Clone Wars (2003) 1080p - Episode 1.mkv'), cw2003, known), false);
  assert.equal(namesOtherTitle(file('Star Wars - Clone Wars - Volume 1 (2003) [4K].mkv'), cw2003, known), false);
  // And the other way round.
  assert.equal(namesOtherTitle(file('Star Wars Clone Wars (2003) 1080p - Episode 1.mkv'), tcw, known), true);
  assert.equal(namesOtherTitle(file('Star Wars The Clone Wars (2008) - S01E01 - Ambush.mkv'), tcw, known), false);
  // Unknown or unreadable names are kept: only a clear match to another title drops a release.
  assert.equal(namesOtherTitle(file('1.mp4'), cw2003, known), false);
  assert.equal(namesOtherTitle(file('Звездные Войны Войны Клонов 2003.mkv'), cw2003, known), false);
  assert.equal(namesOtherTitle(file('Storage.Wars.Texas.S02E05.mkv'), { id: 'tt1785123', names: ['storage wars'], years: [2010, 2023] }, known), true);
  // Namesakes go by year.
  const who2005 = { id: 'tt0436992', names: ['doctor who'], years: [2005, 2022] };
  assert.equal(namesOtherTitle(file('Doctor.Who.2023.S01E08.1080p.mkv'), who2005, known), true);
  assert.equal(namesOtherTitle(file('Doctor.Who.2005.S10E01.1080p.mkv'), who2005, known), false);
  assert.equal(namesOtherTitle(file('Doctor.Who.S10E01.1080p.mkv'), who2005, known), false);
});
