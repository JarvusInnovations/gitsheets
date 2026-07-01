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

test('getFullYear (local-time) parity is reported (TZ-sensitive)', () => {
  // Local-time date accessors depend on the process TZ in BOTH node:vm and boa.
  // In the same process they should agree; we assert that and surface the value.
  const record = { publishedAt: new Date('2026-03-09T12:00:00Z') };
  const template = '${{ publishedAt.getFullYear() }}';
  const expected = refRender(template, record);
  const [actual] = renderPathsBatch(template, [record]);
  console.log(`\n  getFullYear local-time parity: node:vm=${expected} boa=${actual} (TZ=${process.env.TZ ?? 'system'})`);
  assert.equal(actual, expected, 'boa local-time year matches node:vm in-process');
});
