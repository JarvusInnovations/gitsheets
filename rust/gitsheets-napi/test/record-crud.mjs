// Record CRUD + diff/patch boundary suite for gitsheets-napi.
//
// Proves the record engine's parity from JS:
//   - CRUD round-trips records through the holo-tree substrate (write produces a
//     real tree/blob hash; read returns the written record byte-faithfully).
//   - RFC 6902 `createPatch` matches the `rfc6902` npm package op-for-op on a
//     fixture corpus (the parity target `Sheet.diffFrom` uses).
//   - RFC 7396 `applyMergePatch` matches `packages/gitsheets/src/patch.ts`'s
//     inline `mergePatch` on the `patch-semantics.md` worked examples.
//
// Requires the addon to be built first: `npm run build:debug` (or `build`).
// Run with: `npm test` (node --test).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createPatch as rfc6902CreatePatch } from 'rfc6902';

const require = createRequire(import.meta.url);

let binding;
try {
  binding = require('../binding.cjs');
} catch (err) {
  throw new Error(
    `gitsheets-napi addon not built — run \`npm run build:debug\` first.\n  cause: ${err.message}`,
  );
}
const {
  recordRead,
  recordWrite,
  recordDelete,
  recordList,
  diffRecords,
  createPatch,
  applyMergePatch,
} = binding;

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

function freshRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'gitsheets-napi-'));
  execFileSync('git', ['init', '-q', dir]);
  return { dir, gitDir: join(dir, '.git') };
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

test('write → read round-trips a record through holo-tree', () => {
  const { dir, gitDir } = freshRepo();
  try {
    const rec = { email: 'jane@x.org', slug: 'jane', tags: ['a', 'b'], age: 30 };
    const out = recordWrite(gitDir, EMPTY_TREE, 'people', ['jane'], [rec]);
    assert.match(out.treeHash, /^[0-9a-f]{40}$/, 'a real tree hash');
    assert.match(out.blobHashes[0], /^[0-9a-f]{40}$/, 'a real blob hash');

    const read = recordRead(gitDir, out.treeHash, 'people', ['jane']);
    assert.deepEqual(read[0], rec, 'read back identical');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('read of a missing record is null', () => {
  const { dir, gitDir } = freshRepo();
  try {
    const out = recordWrite(gitDir, EMPTY_TREE, 'people', ['jane'], [{ slug: 'jane' }]);
    const read = recordRead(gitDir, out.treeHash, 'people', ['nobody']);
    assert.equal(read[0], null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('list returns every record under base, sorted', () => {
  const { dir, gitDir } = freshRepo();
  try {
    const out = recordWrite(
      gitDir,
      EMPTY_TREE,
      'people',
      ['zoe', 'amy'],
      [{ slug: 'zoe' }, { slug: 'amy' }],
    );
    const listed = recordList(gitDir, out.treeHash, 'people');
    assert.deepEqual(
      listed.map((e) => e.path),
      ['amy', 'zoe'],
    );
    assert.deepEqual(listed[0].record, { slug: 'amy' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('delete removes a record and reports existence', () => {
  const { dir, gitDir } = freshRepo();
  try {
    const w = recordWrite(gitDir, EMPTY_TREE, 'people', ['jane'], [{ slug: 'jane' }]);
    const d = recordDelete(gitDir, w.treeHash, 'people', ['jane', 'ghost']);
    assert.deepEqual(d.existed, [true, false]);
    const read = recordRead(gitDir, d.treeHash, 'people', ['jane']);
    assert.equal(read[0], null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('diff classifies added / modified / deleted with RFC 6902 patches', () => {
  const { dir, gitDir } = freshRepo();
  try {
    const src = recordWrite(
      gitDir,
      EMPTY_TREE,
      'people',
      ['jane', 'bob'],
      [{ email: 'old', slug: 'jane' }, { slug: 'bob' }],
    );
    let dst = recordWrite(gitDir, src.treeHash, 'people', ['jane'], [{ email: 'new', slug: 'jane' }]);
    dst = recordWrite(gitDir, dst.treeHash, 'people', ['amy'], [{ slug: 'amy' }]);
    dst = recordDelete(gitDir, dst.treeHash, 'people', ['bob']);

    const diffs = diffRecords(gitDir, src.treeHash, dst.treeHash, 'people');
    const byPath = Object.fromEntries(diffs.map((d) => [d.path, d]));

    assert.equal(byPath.amy.status, 'added');
    assert.equal(byPath.bob.status, 'deleted');
    assert.equal(byPath.jane.status, 'modified');

    assert.deepEqual(byPath.jane.patch, [{ op: 'replace', path: '/email', value: 'new' }]);
    assert.deepEqual(byPath.amy.patch, [{ op: 'replace', path: '', value: { slug: 'amy' } }]);
    assert.deepEqual(byPath.bob.patch, [{ op: 'replace', path: '', value: null }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── RFC 6902 parity vs the `rfc6902` package ───────────────────────────────────

const PATCH_CASES = [
  ['added', null, { slug: 'jane', email: 'j@x.org' }],
  ['deleted', { slug: 'jane', email: 'j@x.org' }, null],
  ['field-change', { slug: 'jane', email: 'old', name: 'Jane' }, { slug: 'jane', email: 'new', name: 'Jane' }],
  ['field-add', { slug: 'jane' }, { slug: 'jane', email: 'new' }],
  ['field-remove', { slug: 'jane', email: 'x' }, { slug: 'jane' }],
  ['nested-change', { a: { city: 'P', zip: '1' } }, { a: { city: 'P', zip: '2' } }],
  ['nested-add', { a: { city: 'P' } }, { a: { city: 'P', zip: '2' } }],
  ['array-append', { tags: ['a', 'b'] }, { tags: ['a', 'b', 'c'] }],
  ['array-replace-elem', { tags: ['a', 'b'] }, { tags: ['a', 'x'] }],
  ['array-remove', { tags: ['a', 'b', 'c'] }, { tags: ['a'] }],
  ['array-whole', { tags: ['a', 'b'] }, { tags: ['x'] }],
  ['array-prepend', { tags: ['b', 'c'] }, { tags: ['a', 'b', 'c'] }],
  ['array-of-objects', { rows: [{ k: 1 }, { k: 2 }] }, { rows: [{ k: 1 }, { k: 3 }] }],
  ['type-change', { x: 1 }, { x: '1' }],
  ['multi-field', { a: 1, b: 2, c: 3 }, { a: 1, b: 20, d: 4 }],
  ['noop', { a: 1, b: 2 }, { a: 1, b: 2 }],
  ['pointer-escape', { 'a/b': 1, 'c~d': 2 }, { 'a/b': 9, 'c~d': 2 }],
];

test('createPatch matches the rfc6902 package op-for-op', () => {
  for (const [name, src, dst] of PATCH_CASES) {
    const mine = createPatch(src, dst);
    const theirs = rfc6902CreatePatch(src, dst);
    assert.deepEqual(mine, theirs, `createPatch divergence on "${name}"`);
  }
});

// ── RFC 7396 parity vs patch.ts's inline mergePatch ────────────────────────────

// Verbatim copy of `packages/gitsheets/src/patch.ts` `mergePatch` — the exact
// implementation `Sheet.patch` applies. Parity is asserted against it directly.
function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  if (value instanceof Date) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
function mergePatch(target, patch) {
  if (!isPlainObject(patch)) return patch;
  const base = isPlainObject(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete base[key];
    else base[key] = mergePatch(base[key], value);
  }
  return base;
}

const MERGE_CASES = [
  ['update-field', { slug: 'jane', email: 'jane@old.org', fullName: 'Jane' }, { email: 'jane@new.org' }],
  ['delete-field', { slug: 'jane', email: 'jane@x.org', bio: 'Hello!' }, { bio: null }],
  ['replace-array', { slug: 'jane', tags: ['foo', 'bar'] }, { tags: ['baz'] }],
  ['merge-nested', { slug: 'jane', address: { city: 'Philly', zip: '19103' } }, { address: { zip: '19104' } }],
  ['delete-nested', { slug: 'jane', address: { city: 'Philly', zip: '19103' } }, { address: { zip: null } }],
  ['partial-nested-merges', { slug: 'jane', address: { city: 'Philly', zip: '19103' } }, { address: { city: 'Pittsburgh' } }],
  ['add-field', { slug: 'jane' }, { email: 'new@x.org' }],
  ['add-nested-object', { slug: 'jane' }, { address: { city: 'Philly' } }],
  ['scalar-types', { n: 1, b: true }, { n: 2, b: false }],
];

test('applyMergePatch matches patch.ts mergePatch on the spec examples', () => {
  for (const [name, target, patch] of MERGE_CASES) {
    const mine = applyMergePatch(target, patch);
    const theirs = mergePatch(target, patch);
    assert.deepEqual(mine, theirs, `mergePatch divergence on "${name}"`);
  }
});
