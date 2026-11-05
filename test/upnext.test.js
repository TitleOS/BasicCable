import { test } from 'node:test';
import assert from 'node:assert/strict';
import { upNextText, upNextFilter } from '../src/upnext.js';

const label = (i) => i.label;

test('the box lists the next program and the one after, at their guide times', () => {
  const next = { start: Date.UTC(2026, 10, 5, 2, 30), label: 'Modern Family S02E03 · The Kiss' };
  const later = { start: Date.UTC(2026, 10, 5, 3, 0), label: 'The Office S04E01 · Fun Run' };
  assert.equal(upNextText(next, later, { label, timeZone: 'America/Chicago' }),
    'UP NEXT · 8:30 PM\nModern Family S02E03 · The Kiss\nTHEN · 9:00 PM\nThe Office S04E01 · Fun Run');
  assert.equal(upNextText(next, null, { label, timeZone: 'UTC' }), 'UP NEXT · 2:30 AM\nModern Family S02E03 · The Kiss');
});

test('long titles are cut to fit the box', () => {
  const next = { start: 0, label: 'Star Wars: The Clone Wars S03E10 · Heroes on Both Sides (1)' };
  const line = upNextText(next, null, { label, timeZone: 'UTC' }).split('\n')[1];
  assert.ok(line.length <= 46 && line.endsWith('…'), line);
});

test('the filter sizes the box to the picture and can wait before showing it', () => {
  const f = upNextFilter({ textFile: 'C:\\tmp\\up next.txt', font: '/fonts/x.ttf', height: 1080, from: 90 });
  assert.match(f, /^drawtext=fontfile='\/fonts\/x\.ttf':textfile='C\\:\/tmp\/up next\.txt':expansion=none:fontsize=28:/);
  assert.match(f, /box=1:boxcolor=black@0\.6/);
  assert.match(f, /x=w-tw-\d+:y=h-th-\d+/);
  assert.match(f, /:enable='gte\(t,90\.00\)'$/);
  assert.doesNotMatch(upNextFilter({ textFile: 't', font: 'f', height: 720 }), /enable/);
  assert.match(upNextFilter({ textFile: 't', font: 'f', height: 720 }), /fontsize=19:/);
});
