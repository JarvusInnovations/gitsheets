// Round-trip fidelity tests for the gitsheets-napi marshalling boundary.
//
// Each test pushes a JS value through `roundtrip` (JS → core `Value` → JS) and
// asserts the type survived per `specs/rust-core.md` "Type-fidelity rules".
//
// Requires the addon to be built first: `npm run build:debug` (or `build`).
// Run with: `npm test` (node --test).

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
const { roundtrip } = binding;

// Round-trip a single record and return it.
function trip(record) {
  const out = roundtrip([record]);
  assert.equal(out.length, 1, 'one record in, one record out');
  return out[0];
}

test('the addon loads without throwing', () => {
  assert.equal(typeof roundtrip, 'function');
});

test('a Date stays a Date with the same instant', () => {
  const d = new Date('2021-06-15T10:30:00.000Z');
  const out = trip({ at: d });
  assert.ok(out.at instanceof Date, 'value should still be a Date');
  assert.equal(out.at.getTime(), d.getTime(), 'instant preserved to the ms');
});

test('a small integer stays an integral number', () => {
  const out = trip({ id: 7 });
  assert.equal(typeof out.id, 'number');
  assert.ok(Number.isInteger(out.id), 'stays integral');
  assert.equal(out.id, 7);
});

test('an integer above 2^53 stays a BigInt with the exact value', () => {
  const big = 9007199254740993n; // 2^53 + 1 — not representable as a JS number
  const out = trip({ id: big });
  assert.equal(typeof out.id, 'bigint', 'large integer surfaces as BigInt');
  assert.equal(out.id, big, 'exact value preserved');
});

test('a bigint that fits in the safe range comes back as a number', () => {
  // Inbound accepts BOTH number and bigint; the outbound surface is adaptive,
  // so a small bigint comes back as an ergonomic number.
  const out = trip({ id: 42n });
  assert.equal(typeof out.id, 'number');
  assert.equal(out.id, 42);
});

test('a float stays a float (distinct from an integer)', () => {
  const out = trip({ ratio: 3.14 });
  assert.equal(typeof out.ratio, 'number');
  assert.ok(!Number.isInteger(out.ratio), 'fractional value preserved');
  assert.equal(out.ratio, 3.14);
});

test('strings and booleans survive', () => {
  const out = trip({ name: 'Ada', active: true, archived: false });
  assert.equal(out.name, 'Ada');
  assert.equal(out.active, true);
  assert.equal(out.archived, false);
});

test('nested tables and arrays survive structurally', () => {
  const record = {
    id: 1,
    meta: { author: { name: 'Ada', verified: true }, tags: ['a', 'b'] },
    scores: [10, 20, 30],
  };
  const out = trip(record);
  assert.deepEqual(out, record);
});

test('mixed-type values inside one record keep their distinctions', () => {
  const d = new Date('1999-12-31T23:59:59.000Z');
  const record = { n: 5, f: 2.5, s: 'x', b: false, when: d, big: 9007199254740993n };
  const out = trip(record);
  assert.equal(typeof out.n, 'number');
  assert.ok(Number.isInteger(out.n));
  assert.ok(!Number.isInteger(out.f));
  assert.equal(out.s, 'x');
  assert.equal(out.b, false);
  assert.ok(out.when instanceof Date);
  assert.equal(out.when.getTime(), d.getTime());
  assert.equal(typeof out.big, 'bigint');
  assert.equal(out.big, 9007199254740993n);
});

test('a batch of records crosses the boundary in a single call', () => {
  const batch = [
    { id: 1, name: 'one' },
    { id: 2, name: 'two', nested: { ok: true } },
    { id: 9007199254740993n, name: 'big' },
  ];
  const out = roundtrip(batch);
  assert.equal(out.length, 3, 'whole array round-trips in one call');
  assert.deepEqual(out[0], { id: 1, name: 'one' });
  assert.deepEqual(out[1], { id: 2, name: 'two', nested: { ok: true } });
  assert.equal(typeof out[2].id, 'bigint');
  assert.equal(out[2].id, 9007199254740993n);
});

test('a top-level array of scalars round-trips', () => {
  const out = roundtrip([[1, 'two', true]]);
  assert.deepEqual(out[0], [1, 'two', true]);
});

// ── null / undefined handling (specs/behaviors/normalization.md) ─────────────
//
// TOML has no null: a null/undefined-valued KEY is dropped (recursively — the
// 1.x @iarna semantics restored by #232), a null/undefined array ELEMENT or a
// null/undefined value itself is rejected.

test('null- and undefined-valued keys are dropped from a record', () => {
  const out = trip({ keep: 'v', gone: null, alsoGone: undefined });
  assert.deepEqual(out, { keep: 'v' });
  assert.equal(out.gone, undefined, 'dropped key reads back as undefined');
});

test('the key drop is recursive: nested tables and objects inside arrays', () => {
  const out = trip({
    nested: { x: null, y: 2, deeper: { z: undefined, k: 'v' } },
    arr: [{ a: null, b: 1 }, { c: 2 }],
  });
  assert.deepEqual(out, {
    nested: { y: 2, deeper: { k: 'v' } },
    arr: [{ b: 1 }, { c: 2 }],
  });
});

test('a record of ONLY nullish keys becomes an empty table, not an error', () => {
  const out = trip({ a: null, b: undefined });
  assert.deepEqual(out, {});
});

test('a null array element is rejected with the index named', () => {
  assert.throws(
    () => roundtrip([{ tags: ['a', null, 'c'] }]),
    (err) => {
      assert.match(err.message, /array element \(index 1\)/);
      assert.match(err.message, /remove the element/);
      return true;
    },
  );
});

test('an undefined array element (and a sparse hole) is rejected the same way', () => {
  assert.throws(() => roundtrip([{ tags: ['a', undefined] }]), /array element \(index 1\)/);
  // eslint-disable-next-line no-sparse-arrays
  assert.throws(() => roundtrip([{ tags: [1, , 3] }]), /array element \(index 1\)/);
});

test('a null record itself is still rejected', () => {
  assert.throws(() => roundtrip([null]), /cannot marshal null\/undefined to a TOML value/);
});
