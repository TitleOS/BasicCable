import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mediaDuration } from '../src/probe.js';

// The Office S09E08 "Superfan" Peacock release, as ffprobe reported it: the subtitle track's length tag
// (1193 hours) became the file's length, while picture and sound run 31:28.
const peacock = {
  format: { duration: '4296725.095000', size: '1217156299', bit_rate: '2266' },
  streams: [
    { codec_type: 'video', tags: { DURATION: '00:31:27.928000000' } },
    { codec_type: 'audio', tags: { DURATION: '00:31:27.957000000' } },
    { codec_type: 'audio', tags: { DURATION: '00:31:27.936000000' } },
    { codec_type: 'subtitle', duration: '4296725.095000', tags: { DURATION: '1193:32:05.09500000' } },
  ],
};

test('a broken subtitle length does not stretch the file', () => {
  assert.equal(Math.round(mediaDuration(peacock.format, peacock.streams) * 1000), 1887957);
});

test('the container length is kept when the tracks agree with it', () => {
  const streams = [
    { codec_type: 'video', tags: { DURATION: '00:31:21.380000000' } },
    { codec_type: 'audio', tags: { DURATION: '00:31:21.344000000' } },
    { codec_type: 'subtitle', tags: { DURATION: '00:30:43.967000000' } },
  ];
  assert.equal(mediaDuration({ duration: '1881.380000' }, streams), 1881.38);
  // MP4 tracks carry their length as a number rather than a tag; a little over is normal.
  assert.equal(mediaDuration({ duration: '1300.5' }, [{ codec_type: 'video', duration: '1290.0' }]), 1300.5);
});

test('tagged per-language durations and missing data', () => {
  assert.equal(mediaDuration({ duration: '99999' }, [{ codec_type: 'video', tags: { 'DURATION-eng': '00:22:00.000000000' } }]), 1320);
  assert.equal(mediaDuration({ duration: '1320' }, [{ codec_type: 'video' }]), 1320);
  assert.equal(mediaDuration({}, [{ codec_type: 'video', tags: { DURATION: '00:22:00.5' } }]), 1320.5);
  assert.equal(mediaDuration({}, []), null);
});
