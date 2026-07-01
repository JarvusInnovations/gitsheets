// Locale-collation parity: the declarative `sort = true` path is evaluated by a
// NATIVE ICU collator in the Rust core (gitsheets_core::collator), NOT the boa
// engine. boa is built without `Intl`, so its `localeCompare` falls back to
// code-unit comparison and diverges from V8 / node:vm on non-ASCII / mixed-case
// input (e.g. ["B","a"]: node sorts to ["a","B"], boa leaves ["B","a"]). This is
// THE gate that the native collator matches V8's `localeCompare` byte-exactly.
//
// `collatorSort` is the exact function `Sheet::normalize_record` applies for a
// `sort = true` field, so asserting it against node's `localeCompare` proves the
// wired normalization path is both native and parity-exact.
//
// Requires the addon built first (`npm run build:debug`). Run: `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { collatorSort } = require('../binding.cjs');

// The exact options the JS oracle (`buildSorter` in sheet.ts) passes, and the
// locale-default (`undefined` → en-US in Node). This is the reference order the
// native collator must reproduce byte-for-byte.
const OPTS = { sensitivity: 'base', ignorePunctuation: true, numeric: true };
function v8Sort(arr) {
  return [...arr].sort((a, b) => a.localeCompare(b, undefined, OPTS));
}

// The headline divergence: code-unit order puts 'B' (0x42) before 'a' (0x61);
// V8 base-folds case so 'a' < 'B'. boa got this wrong; the native collator must
// not.
test('boa-divergent cases match V8 localeCompare exactly', () => {
  assert.deepEqual(collatorSort(['B', 'a']), ['a', 'B']);
  assert.deepEqual(collatorSort(['é', 'e', 'z']), ['é', 'e', 'z']);
  assert.deepEqual(collatorSort(['10', '2', '1']), ['1', '2', '10']);
  assert.deepEqual(collatorSort(['file10', 'file2', 'file1']), ['file1', 'file2', 'file10']);
  assert.deepEqual(collatorSort(['coop', 'co-op', 'co op']), ['coop', 'co-op', 'co op']);
  // Each of these also matches node's own localeCompare reference.
  for (const arr of [
    ['B', 'a'],
    ['é', 'e', 'z'],
    ['10', '2', '1'],
    ['file10', 'file2', 'file1'],
  ]) {
    assert.deepEqual(collatorSort(arr), v8Sort(arr));
  }
});

// A curated fixture spanning accents, case, ligatures, fullwidth digits, CJK
// numerals, Cyrillic/Greek, punctuation, whitespace, numeric strings, and
// duplicates (to exercise stability).
const CURATED = [
  'B', 'a', 'é', 'e', 'z', 'apple', 'Apple', '10', '2', 'ä', 'Z', 'café', 'cafe',
  'naïve', 'naive', 'Müller', 'Mueller', 'résumé', 'resume', 'co-op', 'coop', 'co op',
  'file2', 'file10', 'file1', 'File1', 'ñ', 'n', 'Ñ', 'ç', 'ö', 'ø', 'Straße',
  'strasse', 'ß', '!bang', '#hash', '@at', '_under', '-dash', '100', '99', 'α', 'β',
  'Привет', 'привет', '1.5', '1.10', '1.2', 'v1.2.10', 'v1.2.2', '', ' ', '.', '...',
  'a.b', 'ab', 'Hello, World', 'hello world', 'ﬁle', 'file', 'ﬀ', 'ff', '①', 'Ⅻ',
  '😀a', 'a😀', 'Łódź', 'lodz', 'Æsop', 'aesop', '3', '30', '300', '3a', 'A3', '２',
  '５', 'tag-a', 'tag_a', 'tag a', 'taga', '北京', '東京', 'tokyo', 'ABC', 'abc', 'aBc',
  // duplicates for stability
  'é', 'e', 'Apple', 'apple', 'B', 'b', '2', '10',
];

test('curated fixture matches V8 localeCompare exactly', () => {
  assert.deepEqual(collatorSort(CURATED), v8Sort(CURATED));
});

// Randomized breadth: deterministic LCG over a Unicode pool, several arrays.
test('randomized fixtures match V8 localeCompare exactly', () => {
  let rng = 0x2bad4c0d;
  const rand = () => ((rng = (Math.imul(rng, 1103515245) + 12345) & 0x7fffffff) / 0x7fffffff);
  const pool = [...'abcAB0129 .-_éèäöüçñßﬁα北😀ZzＡ５①'];
  let total = 0;
  for (let t = 0; t < 50; t++) {
    const arr = [];
    const n = 2 + Math.floor(rand() * 30);
    for (let i = 0; i < n; i++) {
      let len = 1 + Math.floor(rand() * 6);
      let s = '';
      for (let j = 0; j < len; j++) s += pool[Math.floor(rand() * pool.length)];
      arr.push(s);
    }
    assert.deepEqual(collatorSort(arr), v8Sort(arr), `randomized array #${t}: ${JSON.stringify(arr)}`);
    total += arr.length;
  }
  console.log(`  randomized parity: 50 arrays, ${total} strings, exact match`);
});
