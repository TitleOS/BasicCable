import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDays, parseClock, parseDuration, minutesBetween, parseTitleSpec, normTitle, parseResolution } from '../src/nl.js';

test('parseDays understands words, names, ranges and numbers', () => {
  assert.deepEqual(parseDays('weekdays'), [1, 2, 3, 4, 5]);
  assert.deepEqual(parseDays('weeknights'), [1, 2, 3, 4, 5]);
  assert.deepEqual(parseDays('weekends'), [6, 7]);
  assert.deepEqual(parseDays('daily'), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(parseDays('Mon-Fri'), [1, 2, 3, 4, 5]);
  assert.deepEqual(parseDays('friday to sunday'), [5, 6, 7]);
  assert.deepEqual(parseDays('mon, wed and fri'), [1, 3, 5]);
  assert.deepEqual(parseDays(['Tuesdays', 'thurs']), [2, 4]);
  assert.deepEqual(parseDays([6, 7]), [6, 7]);
  assert.throws(() => parseDays('someday'), /Unknown day/);
});

test('parseClock reads 12- and 24-hour times', () => {
  assert.equal(parseClock('8pm'), '20:00');
  assert.equal(parseClock('8:30 PM'), '20:30');
  assert.equal(parseClock('12am'), '00:00');
  assert.equal(parseClock('12pm'), '12:00');
  assert.equal(parseClock('20:00'), '20:00');
  assert.equal(parseClock('0830'), '08:30');
  assert.equal(parseClock('noon'), '12:00');
  assert.equal(parseClock('midnight'), '00:00');
  assert.throws(() => parseClock('25:00'));
});

test('parseDuration and minutesBetween', () => {
  assert.equal(parseDuration(90), 90);
  assert.equal(parseDuration('1h30m'), 90);
  assert.equal(parseDuration('1.5 hours'), 90);
  assert.equal(parseDuration('45 minutes'), 45);
  assert.equal(minutesBetween('20:00', '21:00'), 60);
  assert.equal(minutesBetween('22:00', '01:00'), 180);
});

test('parseTitleSpec handles prefixes, years, ids and wildcards', () => {
  assert.deepEqual(parseTitleSpec('movie: Heat (1995)'), { query: 'Heat', types: ['movie'], year: 1995, imdb: null, wildcard: false });
  assert.deepEqual(parseTitleSpec('Battlestar Galactica 2004'), { query: 'Battlestar Galactica', types: null, year: 2004, imdb: null, wildcard: false });
  assert.equal(parseTitleSpec('tt0386676').imdb, 'tt0386676');
  assert.deepEqual(parseTitleSpec('movies: Batman*'), { query: 'Batman*', types: ['movie'], year: null, imdb: null, wildcard: true });
  assert.equal(parseTitleSpec('Blade Runner 2049').year, 2049); // ambiguous but harmless: search still finds it by name
  assert.equal(normTitle('The Office (US)'), 'the office us');
});

test('parseResolution', () => {
  assert.equal(parseResolution('4K'), 2160);
  assert.equal(parseResolution('1080p'), 1080);
  assert.equal(parseResolution('720'), 720);
  assert.throws(() => parseResolution('8k'));
});
