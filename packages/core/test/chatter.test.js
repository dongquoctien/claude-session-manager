import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseChatter } from '../src/chatter.js';

test('parses a clean JSON object into per-language arrays', () => {
  const json = JSON.stringify({
    en: ['Ship it.', 'This bug is a rabbit hole.'],
    ko: ['커밋하자.', '이 버그 또 뭐야.'],
    ja: ['とりあえずマージ。', 'またテスト落ちた。'],
    vi: ['Xong sớm đi cà phê.', 'Bug này lằng nhằng phết.'],
  });
  const out = parseChatter(json);
  assert.deepEqual(Object.keys(out).sort(), ['en', 'ja', 'ko', 'vi']);
  assert.equal(out.en.length, 2);
  assert.equal(out.vi[0], 'Xong sớm đi cà phê.');
});

test('extracts the JSON block even with surrounding noise', () => {
  const noisy = 'Sure! Here you go:\n```json\n{"en":["Ship it."]}\n```\nHope that helps.';
  const out = parseChatter(noisy);
  assert.ok(out, 'should still parse');
  assert.deepEqual(out.en, ['Ship it.']);
});

test('drops empty and over-long lines, trims whitespace', () => {
  const json = JSON.stringify({
    en: ['  Trim me  ', '', '   ', 'x'.repeat(100), 'Keep this'],
  });
  const out = parseChatter(json);
  assert.deepEqual(out.en, ['Trim me', 'Keep this']);
});

test('ignores non-array / non-string values', () => {
  const json = JSON.stringify({ en: ['ok'], ko: 'not-an-array', ja: [1, 2, null, 'real'] });
  const out = parseChatter(json);
  assert.deepEqual(out.en, ['ok']);
  assert.equal(out.ko, undefined, 'string value rejected');
  assert.deepEqual(out.ja, ['real'], 'non-strings filtered out');
});

test('returns null when no usable language survives', () => {
  assert.equal(parseChatter('{"en":[],"ko":["", "   "]}'), null);
  assert.equal(parseChatter('{"foo":["bar"]}'), null, 'unknown keys ignored');
});

test('returns null for unparseable / empty input', () => {
  assert.equal(parseChatter('no json here'), null);
  assert.equal(parseChatter(''), null);
  assert.equal(parseChatter('{ broken'), null);
  assert.equal(parseChatter(null), null);
  assert.equal(parseChatter(undefined), null);
});

test('caps each language to a reasonable batch size', () => {
  // 200 lines in → cap kicks in at MAX_PER_LANG (50 — bumped from 20 so the
  // live pool can give the UI a wider variety set).
  const many = Array.from({ length: 200 }, (_, i) => `line ${i}`);
  const out = parseChatter(JSON.stringify({ en: many }));
  assert.ok(out.en.length <= 50, `capped, got ${out.en.length}`);
  assert.equal(out.en.length, 50);
});
