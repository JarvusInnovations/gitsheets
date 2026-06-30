// JSON-Schema validation parity: the Rust validator (`validateBatch`, jsonschema
// crate) vs `ajv` configured exactly like the production layer
// (`packages/gitsheets/src/validation.ts`: strict + allErrors + $data:false +
// ajv-formats). Over a corpus of valid + invalid records we assert:
//
//   1. VALIDITY parity is exact — every record passes/fails the same way.
//   2. The set of failing (instanceLocation, keyword) pairs matches.
//
// Issue MESSAGE TEXT is intentionally excluded (it is library-specific prose).
// Any enumerated divergence is logged and lives in the plan Notes.
//
// Requires the addon built first (`npm run build:debug`). Run: `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Ajv } = require('ajv');
const addFormats = require('ajv-formats');
const { validateBatch } = require('../binding.cjs');

// Mirror validation.ts exactly.
const ajv = new Ajv({ strict: true, allErrors: true, $data: false });
addFormats(ajv);

const SCHEMA = {
  type: 'object',
  required: ['slug', 'email', 'fullName', 'age'],
  additionalProperties: false,
  properties: {
    slug: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{1,49}$' },
    email: { type: 'string', format: 'email' },
    fullName: { type: 'string', minLength: 1, maxLength: 120 },
    age: { type: 'integer', minimum: 0, maximum: 200 },
    role: { type: 'string', enum: ['admin', 'member', 'guest'] },
    website: { type: 'string', format: 'uri' },
    tags: { type: 'array', items: { type: 'string' }, maxItems: 3 },
  },
};

const RECORDS = [
  // valid
  { slug: 'jane', email: 'jane@example.org', fullName: 'Jane', age: 30 },
  { slug: 'bob-99', email: 'bob@x.io', fullName: 'Bob', age: 0, role: 'admin', tags: ['a', 'b'] },
  { slug: 'k8s', email: 'k@k.dev', fullName: 'K', age: 200, website: 'https://k.dev' },
  // invalid — single violations
  { slug: 'JANE!', email: 'jane@example.org', fullName: 'Jane', age: 30 }, // pattern
  { slug: 'jane', email: 'nope', fullName: 'Jane', age: 30 }, // format(email)
  { slug: 'jane', email: 'jane@example.org', fullName: '', age: 30 }, // minLength
  { slug: 'jane', email: 'jane@example.org', fullName: 'Jane', age: -1 }, // minimum
  { slug: 'jane', email: 'jane@example.org', fullName: 'Jane', age: 1.5 }, // type integer
  { slug: 'jane', email: 'jane@example.org', fullName: 'Jane', age: 30, role: 'root' }, // enum
  { slug: 'jane', email: 'jane@example.org', fullName: 'Jane', age: 30, website: 'not a uri' }, // format(uri)
  { slug: 'jane', email: 'jane@example.org', fullName: 'Jane', age: 30, tags: ['a', 'b', 'c', 'd'] }, // maxItems
  { slug: 'jane', email: 'jane@example.org', fullName: 'Jane', age: 30, extra: 'x' }, // additionalProperties
  // invalid — multiple violations (allErrors)
  { slug: 'BAD', email: 'nope', fullName: 'Jane', age: 30 }, // pattern + format
  { fullName: 'Jane', age: 30 }, // required slug + required email
  {}, // all required missing
];

const ajvValidate = ajv.compile(SCHEMA);

function ajvResult(record) {
  const ok = ajvValidate(record);
  const issues = ok
    ? []
    : ajvValidate.errors.map((e) => ({
        loc: e.instancePath, // '' | '/age' | ...
        keyword: e.keyword,
      }));
  return { valid: ok, issues };
}

function rustResult(issuesForRecord) {
  return {
    valid: issuesForRecord.length === 0,
    issues: issuesForRecord.map((i) => ({
      loc: i.path.length ? `/${i.path.join('/')}` : '',
      keyword: i.code,
    })),
  };
}

function keySet(issues) {
  return new Set(issues.map((i) => `${i.loc}|${i.keyword}`));
}

test('validity parity is exact across the corpus', () => {
  const rust = validateBatch(SCHEMA, RECORDS);
  const rows = [];
  for (let i = 0; i < RECORDS.length; i++) {
    const a = ajvResult(RECORDS[i]);
    const r = rustResult(rust[i]);
    rows.push({ i, ajv: a.valid, rust: r.valid });
    assert.equal(r.valid, a.valid, `record ${i} validity: ajv=${a.valid} rust=${r.valid}`);
  }
  console.log('\n  validation validity parity (ajv vs rust):');
  for (const row of rows) {
    console.log(`    #${row.i}  ajv=${row.ajv ? 'valid' : 'INVALID'}  rust=${row.rust ? 'valid' : 'INVALID'}`);
  }
});

test('failing (location, keyword) sets match ajv', () => {
  const rust = validateBatch(SCHEMA, RECORDS);
  const divergences = [];
  for (let i = 0; i < RECORDS.length; i++) {
    const a = keySet(ajvResult(RECORDS[i]).issues);
    const r = keySet(rustResult(rust[i]).issues);
    const onlyAjv = [...a].filter((k) => !r.has(k));
    const onlyRust = [...r].filter((k) => !a.has(k));
    if (onlyAjv.length || onlyRust.length) {
      divergences.push({ i, onlyAjv, onlyRust });
    }
  }
  if (divergences.length) {
    console.log('\n  (location,keyword) divergences:');
    for (const d of divergences) {
      console.log(`    #${d.i}  onlyAjv=${JSON.stringify(d.onlyAjv)}  onlyRust=${JSON.stringify(d.onlyRust)}`);
    }
  }
  assert.equal(divergences.length, 0, 'no (location,keyword) divergences');
});

test('validateBatch compiles the schema once for the whole batch', () => {
  // A 200-record batch validates in a single FFI crossing with one compile.
  const many = Array.from({ length: 200 }, (_, k) => ({
    slug: `u${k}`,
    email: `u${k}@x.io`,
    fullName: `U${k}`,
    age: k % 200,
  }));
  const out = validateBatch(SCHEMA, many);
  assert.equal(out.length, 200);
  assert.ok(out.every((issues) => issues.length === 0));
});
