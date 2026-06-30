// Boundary tests for the canonical TOML parse/serialize entry points.
//
// These prove the bytes-authority crosses the FFI correctly: a batch of TOML
// documents parses to JS objects with full type fidelity, and a batch of JS
// objects serializes to the canonical bytes (deep key sort + toml-crate default
// formatting, integer-underscore normalization). See `specs/rust-core.md` and
// `specs/behaviors/normalization.md`.
//
// Requires the addon to be built first (`npm run build:debug`). Run: `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let binding;
try {
  binding = require('../binding.cjs');
} catch (err) {
  throw new Error(
    `gitsheets-napi addon not built — run \`npm run build:debug\` first.\n  cause: ${err.message}`,
  );
}
const { parseRecords, serializeRecords, ConfigError } = binding;

test('parse + serialize are exposed', () => {
  assert.equal(typeof parseRecords, 'function');
  assert.equal(typeof serializeRecords, 'function');
});

test('a batch of documents parses to objects with type fidelity', () => {
  const [a, b] = parseRecords([
    'id = 7\nratio = 1.5\nname = "Ada"\nactive = true\n',
    'at = 1979-05-27T07:32:00Z\n',
  ]);
  assert.equal(a.id, 7);
  assert.ok(Number.isInteger(a.id), 'integer stays integral');
  assert.equal(a.ratio, 1.5);
  assert.ok(!Number.isInteger(a.ratio), 'float stays fractional');
  assert.equal(a.name, 'Ada');
  assert.equal(a.active, true);
  assert.ok(b.at instanceof Date, 'TOML datetime surfaces as a Date');
});

test('serialize emits canonical bytes: deep key sort + integer normalization', () => {
  const [out] = serializeRecords([{ slug: 'jane', legacyId: 31618, email: 'jane@x.org' }]);
  assert.equal(out, 'email = "jane@x.org"\nlegacyId = 31618\nslug = "jane"\n');
});

test('parse → serialize round-trips a record to canonical form', () => {
  // On-disk @iarna form has the integer underscore; canonical drops it.
  const onDisk = 'email = "jane@x.org"\nlegacyId = 31_618\nslug = "jane"\n';
  const [record] = parseRecords([onDisk]);
  const [out] = serializeRecords([record]);
  assert.equal(out, 'email = "jane@x.org"\nlegacyId = 31618\nslug = "jane"\n');
});

test('a multiline body stays triple-quoted, not single-line escaped', () => {
  const [record] = parseRecords(['body = """\n# Title\n\nA paragraph."""\n']);
  const [out] = serializeRecords([record]);
  assert.ok(out.includes('"""'), 'stays triple-quoted');
  assert.ok(out.includes('\n# Title\n'), 'newlines stay literal');
});

test('serialization is idempotent across the boundary', () => {
  const record = { z: 1, a: 2, body: { y: 3, b: 4 }, list: [3, 1, 2] };
  const [once] = serializeRecords([record]);
  const [twice] = serializeRecords(parseRecords([once]));
  assert.equal(twice, once);
});

test('a malformed document throws a typed ConfigError', () => {
  assert.throws(
    () => parseRecords(['this is = = not valid\n']),
    (err) => {
      assert.ok(err instanceof ConfigError, 'typed ConfigError');
      assert.equal(err.code, 'config_invalid');
      return true;
    },
  );
});
