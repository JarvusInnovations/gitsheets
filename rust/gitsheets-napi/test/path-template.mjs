// Path-template parity: the Rust `renderPathsBatch` (native fields + boa engine
// for expressions) must render identically to the production JS renderer
// (`_ref-path-template.mjs`, whose expression components evaluate through
// `node:vm`). This is the path-rendering half of the engine parity gate.
//
// Requires the addon built first (`npm run build:debug`). Run: `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { refRender } from './_ref-path-template.mjs';

const require = createRequire(import.meta.url);
const { renderPathsBatch, PathTemplateError } = require('../binding.cjs');

// A corpus of (template, record) cases. Expression cases use getUTC* (TZ-
// independent) so the boa-vs-node:vm comparison is deterministic across
// machines; getFullYear (local-time) is exercised separately and reported.
const CORPUS = [
  ['${{ slug }}', { slug: 'jane' }],
  ['${{ domain }}/${{ username }}', { domain: 'af.mil', username: 'grandma' }],
  // Multi-variable per segment (#105).
  ['${{ year }}/${{ status }}--${{ id }}', { year: 2026, status: 'active', id: 12345 }],
  // Integer + boolean field stringification.
  ['${{ n }}/${{ flag }}', { n: 42, flag: true }],
  // Literal prefix/suffix around an expression.
  ['user-${{ id }}.draft', { id: 7 }],
  // Expression: string methods.
  ['${{ slug.toLowerCase() }}', { slug: 'HELLO-World' }],
  ['${{ name.toUpperCase() }}/${{ slug }}', { name: 'jane', slug: 'x' }],
  // Expression: partition by date-parts (TZ-independent UTC accessors).
  [
    '${{ publishedAt.getUTCFullYear() }}/${{ publishedAt.getUTCMonth() }}/${{ slug }}',
    { publishedAt: new Date('2026-03-09T12:00:00Z'), slug: 'post' },
  ],
  // Expression: arithmetic / string building.
  ['shard-${{ id % 4 }}/${{ id }}', { id: 39 }],
  ['${{ (slug || legacyId) }}', { slug: 'realslug', legacyId: 'abc' }],
  // Recursive (field/**) component — value contains slashes.
  ['${{ contentPath/** }}', { contentPath: 'docs/guides/intro' }],
  // Date-bucket references (UTC-deterministic, rendered natively on both
  // sides — chrono in the core, UTC accessors in the reference renderer).
  ['${{ publishedAt: YYYY }}/${{ slug }}', { publishedAt: new Date('2026-03-09T12:00:00Z'), slug: 'post' }],
  ['${{ publishedAt: YYYY/MM }}/${{ slug }}', { publishedAt: new Date('2026-03-09T12:00:00Z'), slug: 'post' }],
  ['${{ publishedAt: YYYY/MM/DD }}/${{ slug }}', { publishedAt: new Date('2026-03-09T12:00:00Z'), slug: 'post' }],
  ['${{ publishedAt: YYYY/WW }}/${{ slug }}', { publishedAt: new Date('2026-03-09T12:00:00Z'), slug: 'post' }],
  // Offset instant lands on the UTC date (next day) on both sides.
  ['${{ d: YYYY/MM/DD }}', { d: new Date('2025-12-31T23:30:00-05:00') }],
  // ISO week-based-year boundaries: Jan 1 in W53 of the prior ISO year,
  // late December in W01 of the next.
  ['${{ d: YYYY/WW }}', { d: new Date('2027-01-01T00:00:00Z') }],
  ['${{ d: YYYY/WW }}', { d: new Date('2024-12-30T00:00:00Z') }],
  // ISO 8601 string inputs: date-only, offset-less (face value), offset.
  ['${{ d: YYYY/MM/DD }}', { d: '2026-03-09' }],
  ['${{ d: YYYY/MM/DD }}', { d: '2026-03-09T23:59:59' }],
  ['${{ d: YYYY/MM/DD }}', { d: '2025-12-31T23:30:00-05:00' }],
  // Bucket as the entire path (daily-rollup identity) + dotted field.
  ['${{ day: YYYY/MM/DD }}', { day: '2026-03-09' }],
  ['${{ meta.publishedAt: YYYY/MM }}/${{ slug }}', { meta: { publishedAt: '2026-03-09' }, slug: 'post' }],
];

test('renderPathsBatch matches the node:vm reference renderer across the corpus', () => {
  const comparisons = [];
  for (const [template, record] of CORPUS) {
    const expected = refRender(template, record);
    const [actual] = renderPathsBatch(template, [record]);
    comparisons.push({ template, expected, actual });
    assert.equal(actual, expected, `template ${JSON.stringify(template)}`);
  }
  // Surface the comparison so the parity is visible in test output.
  console.log('\n  path-template parity (rust === node:vm):');
  for (const c of comparisons) {
    console.log(`    ${c.actual === c.expected ? 'OK ' : 'DIFF'}  ${c.template}  ->  ${c.actual}`);
  }
});

test('a whole batch renders in one FFI crossing', () => {
  const records = [{ slug: 'a' }, { slug: 'b' }, { slug: 'c' }];
  assert.deepEqual(renderPathsBatch('${{ slug }}', records), ['a', 'b', 'c']);
});

test('missing field fails identically (path_render_failed)', () => {
  const record = { other: 'x' };
  assert.throws(() => refRender('${{ slug }}', record), (e) => e.code === 'path_render_failed');
  assert.throws(
    () => renderPathsBatch('${{ slug }}', [record]),
    (err) => {
      assert.ok(err instanceof PathTemplateError, 'typed PathTemplateError');
      assert.equal(err.code, 'path_render_failed');
      return true;
    },
  );
});

test('invalid character fails identically (path_invalid_chars)', () => {
  const record = { slug: 'a:b' };
  assert.throws(() => refRender('${{ slug }}', record), (e) => e.code === 'path_invalid_chars');
  assert.throws(
    () => renderPathsBatch('${{ slug }}', [record]),
    (err) => {
      assert.equal(err.code, 'path_invalid_chars');
      return true;
    },
  );
});

test('a slash in a non-recursive segment fails identically', () => {
  const record = { slug: 'a/b' };
  assert.throws(() => refRender('${{ slug }}', record), (e) => e.code === 'path_invalid_chars');
  assert.throws(() => renderPathsBatch('${{ slug }}', [record]), (e) => e.code === 'path_invalid_chars');
});

test('local-time Date methods read UTC in the engine, whatever the process TZ', () => {
  // specs/rust-core.md "Determinism rule for definition snippets" (#362): the
  // realm's local offset is pinned to UTC, so getHours/getFullYear are the
  // UTC values on every host. (The reference renderer above is plain
  // `node:vm`, which reads the host zone — hence UTC-only corpus cases. The
  // production host shim, packages/gitsheets/src/sandbox.ts, is diffed
  // against the engine in the package suite.)
  const record = { publishedAt: new Date('2026-03-09T02:00:00Z') };
  const [hours] = renderPathsBatch('${{ publishedAt.getHours() }}', [record]);
  const [year] = renderPathsBatch('${{ publishedAt.getFullYear() }}', [record]);
  console.log(`\n  engine local-time: getHours=${hours} getFullYear=${year} (TZ=${process.env.TZ ?? 'system'})`);
  assert.equal(hours, '2');
  assert.equal(year, '2026');
});

test('a path expression reading the clock fails the render', () => {
  for (const expr of ['Date.now()', 'Math.random()', 'new Date().getTime()']) {
    assert.throws(
      () => renderPathsBatch(`\${{ ${expr} }}`, [{}]),
      (e) => e.code === 'path_render_failed' && e.message.includes('not available in a gitsheets snippet'),
      expr,
    );
  }
});

// --- Date-bucket cases beyond the render corpus ---

test('date-bucket rendering is pinned to expected UTC values', () => {
  // Belt and braces beyond ref parity: assert the exact expected paths so a
  // shared bug in both implementations can't hide.
  const cases = [
    ['${{ d: YYYY/MM/DD }}', { d: new Date('2026-03-09T12:00:00Z') }, '2026/03/09'],
    ['${{ d: YYYY/WW }}', { d: new Date('2027-01-01T00:00:00Z') }, '2026/53'],
    ['${{ d: YYYY/WW }}', { d: new Date('2024-12-30T00:00:00Z') }, '2025/01'],
    ['${{ d: YYYY/MM/DD }}', { d: new Date('2025-12-31T23:30:00-05:00') }, '2026/01/01'],
    ['${{ d: YYYY/MM }}', { d: '2026-01-02' }, '2026/01'],
  ];
  for (const [template, record, expected] of cases) {
    assert.deepEqual(renderPathsBatch(template, [record]), [expected], template);
  }
});

test('an unknown date-bucket format fails identically (config_invalid)', () => {
  for (const bad of ['YYYY-MM', 'MM/DD', 'YYYY/MM/DD/HH', 'yyyy']) {
    const template = `\${{ d: ${bad} }}/\${{ slug }}`;
    assert.throws(() => refRender(template, { d: '2026-03-09', slug: 'x' }), (e) => e.code === 'config_invalid');
    assert.throws(() => renderPathsBatch(template, [{ d: '2026-03-09', slug: 'x' }]), (e) => e.code === 'config_invalid');
  }
});

test('a non-standalone date bucket fails identically (config_invalid)', () => {
  for (const template of ['posts-${{ d: YYYY }}', '${{ d: YYYY }}${{ slug }}']) {
    assert.throws(() => refRender(template, { d: '2026-03-09', slug: 'x' }), (e) => e.code === 'config_invalid');
    assert.throws(() => renderPathsBatch(template, [{ d: '2026-03-09', slug: 'x' }]), (e) => e.code === 'config_invalid');
  }
});

test('a wrong-typed or unparseable bucket value fails identically (path_render_failed)', () => {
  for (const d of [42, true, 'not-a-date', '2026-02-30']) {
    assert.throws(() => refRender('${{ d: YYYY }}', { d }), (e) => e.code === 'path_render_failed');
    assert.throws(() => renderPathsBatch('${{ d: YYYY }}', [{ d }]), (e) => e.code === 'path_render_failed');
  }
});

test('a missing bucket field follows the missing-field rule identically', () => {
  assert.throws(() => refRender('${{ d: YYYY/MM }}/${{ slug }}', { slug: 'x' }), (e) => e.code === 'path_render_failed');
  assert.throws(() => renderPathsBatch('${{ d: YYYY/MM }}/${{ slug }}', [{ slug: 'x' }]), (e) => e.code === 'path_render_failed');
});
