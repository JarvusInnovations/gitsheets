// Secondary-indexing boundary suite for gitsheets-napi.
//
// Proves the Rust core's lazy in-memory index build/lookup matches the host
// `Sheet.defineIndex` / `findByIndex` build pipeline (`sheet.ts`):
//   - unique index lookup returns the same record;
//   - non-unique index returns the same set;
//   - keyFn returning undefined/null excludes the record;
//   - a duplicate key on a unique index throws IndexError(index_unique_conflict)
//     naming both paths.
//
// The Rust keyFn is a snippet string compiled into the embedded engine; the
// reference keyFn is the equivalent JS function. Both are the SAME logic, so a
// divergence is a real boa-vs-node difference.
//
// Requires the addon built first (`npm run build:debug`). Run: `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { recordWrite, recordIndexUnique, recordIndexMulti, IndexError } = require('../binding.cjs');

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

function freshRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'gitsheets-napi-index-'));
  execFileSync('git', ['init', '-q', dir]);
  return { dir, gitDir: join(dir, '.git') };
}
function seed(gitDir, base, corpus) {
  return recordWrite(
    gitDir,
    EMPTY_TREE,
    base,
    corpus.map((e) => e.path),
    corpus.map((e) => e.record),
  ).treeHash;
}

// Reference: the host `#ensureIndexBuilt` build over a {path,record} corpus.
// (key === null/undefined ⇒ excluded; otherwise String(key).)
function buildUnique(corpus, keyFn) {
  const map = new Map();
  for (const { path, record } of corpus) {
    const raw = keyFn(record);
    if (raw === undefined || raw === null) continue;
    const key = String(raw);
    if (map.has(key)) {
      const e = new Error(`unique conflict on ${key}`);
      e.code = 'index_unique_conflict';
      e.conflictingPaths = [map.get(key).path, path];
      throw e;
    }
    map.set(key, { path, record });
  }
  return map;
}
function buildMulti(corpus, keyFn) {
  const map = new Map();
  for (const { path, record } of corpus) {
    const raw = keyFn(record);
    if (raw === undefined || raw === null) continue;
    const key = String(raw);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push({ path, record });
  }
  return map;
}

const PEOPLE = [
  { path: 'amy', record: { slug: 'amy', email: 'Amy@z.org', team: 'design', legacyId: 100 } },
  { path: 'bob', record: { slug: 'bob', email: 'BOB@y.org', team: 'eng' } },
  { path: 'jane', record: { slug: 'jane', email: 'Jane@x.org', team: 'eng', legacyId: 7 } },
];

test('unique index lookup matches the host index', () => {
  const { dir, gitDir } = freshRepo();
  try {
    const tree = seed(gitDir, 'people', PEOPLE);
    const fn = (r) => r.email.toLowerCase();
    const snippet = '(r) => r.email.toLowerCase()';
    const ref = buildUnique(PEOPLE, fn);

    const keys = ['jane@x.org', 'bob@y.org', 'nobody@example.com'];
    const actual = recordIndexUnique(gitDir, tree, 'people', snippet, keys);
    keys.forEach((k, i) => {
      const expected = ref.has(k) ? ref.get(k).record : null;
      assert.deepEqual(actual[i] ?? null, expected, `unique lookup ${k}`);
    });
    console.log('\n  unique index parity: byEmail ->', actual.map((r) => (r ? r.slug : null)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('non-unique index lookup matches the host index', () => {
  const { dir, gitDir } = freshRepo();
  try {
    const tree = seed(gitDir, 'people', PEOPLE);
    const fn = (r) => String(r.team);
    const snippet = '(r) => String(r.team)';
    const ref = buildMulti(PEOPLE, fn);

    for (const key of ['eng', 'design', 'ops']) {
      const actual = recordIndexMulti(gitDir, tree, 'people', snippet, [key])[0];
      const expected = (ref.get(key) ?? []).map((e) => e.record);
      // Compare as sets-of-slugs (build order is sorted-path on both sides).
      assert.deepEqual(
        actual.map((r) => r.slug).sort(),
        expected.map((r) => r.slug).sort(),
        `multi lookup ${key}`,
      );
    }
    console.log('\n  non-unique index parity: byTeam[eng] count =',
      recordIndexMulti(gitDir, tree, 'people', snippet, ['eng'])[0].length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('keyFn returning undefined excludes the record (host parity)', () => {
  const { dir, gitDir } = freshRepo();
  try {
    const tree = seed(gitDir, 'people', PEOPLE);
    const fn = (r) => ('legacyId' in r ? String(r.legacyId) : undefined);
    const snippet = "(r) => ('legacyId' in r ? String(r.legacyId) : undefined)";
    const ref = buildUnique(PEOPLE, fn);

    const keys = ['100', '7', 'missing'];
    const actual = recordIndexUnique(gitDir, tree, 'people', snippet, keys);
    keys.forEach((k, i) => {
      const expected = ref.has(k) ? ref.get(k).record : null;
      assert.deepEqual(actual[i] ?? null, expected, `legacy lookup ${k}`);
    });
    // bob (no legacyId) is excluded — no key maps to its record.
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('unique conflict throws IndexError(index_unique_conflict) naming both paths', () => {
  const { dir, gitDir } = freshRepo();
  try {
    const tree = seed(gitDir, 'people', PEOPLE);
    // team is not unique → conflict on 'eng' (jane, bob — sorted path order).
    const fn = (r) => String(r.team);
    let refError;
    try {
      buildUnique(PEOPLE, fn);
    } catch (e) {
      refError = e;
    }
    assert.equal(refError.code, 'index_unique_conflict');

    assert.throws(
      () => recordIndexUnique(gitDir, tree, 'people', '(r) => String(r.team)', ['eng']),
      (err) => {
        assert.ok(err instanceof IndexError, 'typed IndexError');
        assert.equal(err.code, 'index_unique_conflict');
        assert.deepEqual(err.conflictingPaths, refError.conflictingPaths);
        return true;
      },
    );
    console.log('\n  unique conflict parity: conflictingPaths =', refError.conflictingPaths);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
