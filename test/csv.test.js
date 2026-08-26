import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseCsv, toCsv } from '../src/csv.js';

test('parses a simple table', () => {
  const { headers, rows } = parseCsv('a,b\n1,2\n3,4\n');
  assert.deepEqual(headers, ['a', 'b']);
  assert.deepEqual(rows, [
    { a: '1', b: '2' },
    { a: '3', b: '4' },
  ]);
});

test('handles quoted fields with commas, quotes and newlines', () => {
  const csv = 'name,note\n"M&T Bank Stadium, Baltimore, MD","he said ""hi""\nsecond line"\n';
  const { rows } = parseCsv(csv);
  assert.equal(rows[0].name, 'M&T Bank Stadium, Baltimore, MD');
  assert.equal(rows[0].note, 'he said "hi"\nsecond line');
});

test('handles CRLF and a UTF-8 BOM', () => {
  const { headers, rows } = parseCsv('﻿a,b\r\n1,2\r\n');
  assert.deepEqual(headers, ['a', 'b']);
  assert.equal(rows[0].a, '1');
});

test('ignores trailing blank lines', () => {
  const { rows } = parseCsv('a,b\n1,2\n\n');
  assert.equal(rows.length, 1);
});

test('missing trailing columns become empty strings', () => {
  const { rows } = parseCsv('a,b,c\n1,2\n');
  assert.deepEqual(rows[0], { a: '1', b: '2', c: '' });
});

test('round-trips through toCsv', () => {
  const csv = toCsv(['a', 'b'], [['plain', 'has,comma'], ['has "quote"', 'line\nbreak']]);
  const { rows } = parseCsv(csv);
  assert.equal(rows[0].b, 'has,comma');
  assert.equal(rows[1].a, 'has "quote"');
  assert.equal(rows[1].b, 'line\nbreak');
});
