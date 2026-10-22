// Ad-hoc aggregation boundary suite for gitsheets-napi (specs/behaviors/aggregation.md).
//
// Proves from JS that:
//   - recordAggregate folds the core's own reads (pruned, filtered, body-less)
//     in canonical path order, for every form + modifier;
//   - `paths` restricts the contributing set to host-admitted records;
//   - a malformed spec throws a plain TypeError; a data-dependent failure an
//     AggregationError (aggregation_failed) carrying sheet + aggregate;
//   - CoreTransaction.aggregate answers over the transaction's private tree.
//
// Requires the addon built first (`npm run build`). Run: `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { recordWrite, recordAggregate, CoreTransaction, AggregationError } = require('../binding.cjs');

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const TEMPLATE = '${{ postedAt: YYYY/MM }}/${{ id }}';

const LEDGER = [
  { id: 'a', postedAt: new Date('2026-01-05T00:00:00Z'), status: 'posted', amountCents: 1000, rate: 0.1 },
  { id: 'b', postedAt: new Date('2026-01-20T00:00:00Z'), status: 'posted', amountCents: 2500, rate: 0.2 },
  { id: 'c', postedAt: new Date('2026-02-10T00:00:00Z'), status: 'pending', amountCents: -500, rate: 0.3 },
  { id: 'z', postedAt: new Date('2025-12-31T00:00:00Z'), status: 'posted', amountCents: 99, tag: 'old' },
];

function pathOf(r) {
  const d = r.postedAt;
  return `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${r.id}`;
}

function freshRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'gitsheets-napi-agg-'));
  execFileSync('git', ['init', '-q', dir]);
  const gitDir = join(dir, '.git');
  const { treeHash } = recordWrite(gitDir, EMPTY_TREE, 'tx', LEDGER.map(pathOf), LEDGER);
  return { dir, gitDir, treeHash };
}

function agg(gitDir, treeHash, filter, aggregates, paths) {
  return recordAggregate(gitDir, treeHash, 'tx', 'tx', TEMPLATE, filter, aggregates, '.toml', null, null, paths);
}

test('every form folds over the filtered set in canonical path order', () => {
  const { dir, gitDir, treeHash } = freshRepo();
  try {
    const r = agg(gitDir, treeHash, { postedAt: { $gte: '2026-01-01' } }, {
      count: { count: true },
      total: { sum: 'amountCents' },
      rateSum: { sum: 'rate' },
      mean: { avg: 'amountCents' },
      lo: { min: 'amountCents' },
      latest: { max: 'postedAt' },
      statuses: { distinct: 'status' },
      none: { max: 'tag' },
      byStatus: { count: true, groupBy: 'status' },
      posted: { sum: 'amountCents', where: { status: 'posted' } },
      order: { reduce: 'return acc + record.id;', initial: '' },
      stats: {
        reduce: 'acc.n += 1; acc.total += record.amountCents; return acc;',
        initial: { n: 0, total: 0 },
        finalize: 'return acc.total / acc.n;',
      },
    });
    assert.equal(r.count, 3);
    assert.equal(r.total, 3000);
    assert.equal(r.rateSum, 0 + 0.1 + 0.2 + 0.3);
    assert.equal(r.mean, 1000);
    assert.equal(r.lo, -500);
    assert.deepEqual(r.latest, new Date('2026-02-10T00:00:00Z'));
    assert.deepEqual(r.statuses, ['pending', 'posted']);
    assert.equal('none' in r, false, 'no contributing record → omitted');
    assert.deepEqual(r.byStatus, { pending: 1, posted: 2 });
    assert.equal(r.posted, 3500);
    assert.equal(r.order, 'abc');
    assert.equal(r.stats, 1000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an empty contributing set: count and sum are 0, others omitted, groups {}', () => {
  const { dir, gitDir, treeHash } = freshRepo();
  try {
    const r = agg(gitDir, treeHash, { status: 'nope' }, {
      n: { count: true },
      total: { sum: 'amountCents' },
      mean: { avg: 'amountCents' },
      byStatus: { count: true, groupBy: 'status' },
    });
    assert.deepEqual(r, { n: 0, total: 0, byStatus: {} });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('paths restricts the contributing set to admitted records', () => {
  const { dir, gitDir, treeHash } = freshRepo();
  try {
    const r = agg(gitDir, treeHash, {}, { order: { reduce: 'return acc + record.id;', initial: '' } }, [
      '2026/02/c',
      '2025/12/z',
    ]);
    assert.equal(r.order, 'zc');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a malformed spec throws TypeError', () => {
  const { dir, gitDir, treeHash } = freshRepo();
  try {
    for (const aggregates of [
      { x: { count: false } },
      { x: { sum: 'a', min: 'b' } },
      { x: { reduce: 'return acc;' } },
      { x: { reduce: 'return acc +;', initial: 0 } },
      { x: { count: true, where: { a: { $in: [1] } } } },
      { x: { count: true, bogus: 1 } },
      { x: { reduce: () => 1, initial: 0 } },
    ]) {
      assert.throws(() => agg(gitDir, treeHash, {}, aggregates), TypeError, JSON.stringify(aggregates));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a body-field reference throws TypeError on a markdown sheet', () => {
  const { dir, gitDir, treeHash } = freshRepo();
  try {
    assert.throws(
      () =>
        recordAggregate(gitDir, treeHash, 'tx', 'tx', TEMPLATE, {}, { x: { distinct: 'body' } }, '.md', 'body', null),
      TypeError,
    );
    assert.throws(
      () =>
        recordAggregate(gitDir, treeHash, 'tx', 'tx', TEMPLATE, { body: 'x' }, { n: { count: true } }, '.md', 'body', null),
      TypeError,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('data-dependent failures are AggregationError with sheet + aggregate', () => {
  const { dir, gitDir, treeHash } = freshRepo();
  try {
    for (const aggregates of [
      { bad: { max: 'mixed' } },
      { bad: { reduce: 'throw new Error("boom")', initial: 0 } },
      { bad: { reduce: 'return undefined;', initial: 0 } },
    ]) {
      let caught;
      try {
        // `mixed` is a number on one record and a string on another.
        const { treeHash: t2 } = recordWrite(gitDir, treeHash, 'tx', ['2026/01/a', '2026/01/b'], [
          { ...LEDGER[0], mixed: 1 },
          { ...LEDGER[1], mixed: 'one' },
        ]);
        agg(gitDir, t2, {}, aggregates);
      } catch (err) {
        caught = err;
      }
      assert.ok(caught instanceof AggregationError, `${JSON.stringify(aggregates)}: ${caught}`);
      assert.equal(caught.code, 'aggregation_failed');
      assert.equal(caught.status, 422);
      assert.equal(caught.sheet, 'tx');
      assert.equal(caught.aggregate, 'bad');
      assert.equal(caught.partition, undefined);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CoreTransaction.aggregate answers over the private tree', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gitsheets-napi-agg-tx-'));
  try {
    execFileSync('git', ['init', '-q', '-b', 'main', dir]);
    execFileSync('git', ['-C', dir, 'config', 'user.name', 'Seed']);
    execFileSync('git', ['-C', dir, 'config', 'user.email', 'seed@x.org']);
    mkdirSync(join(dir, '.gitsheets'), { recursive: true });
    writeFileSync(join(dir, '.gitsheets/people.toml'), "[gitsheet]\npath = '${{ slug }}'\nroot = 'people'\n");
    execFileSync('git', ['-C', dir, 'add', '.gitsheets/people.toml']);
    execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
    const tx = CoreTransaction.begin(join(dir, '.git'), {
      author: { name: 'Jane Doe', email: 'jane@x.org' },
      message: 'seed',
      timeSeconds: 1_700_000_000,
      offsetMinutes: 0,
    });
    try {
      tx.openSheet('people', '.gitsheets/people.toml', '.', '');
      for (const rec of [
        { slug: 'amy', team: 'design', age: 41 },
        { slug: 'bob', team: 'eng', age: 17 },
        { slug: 'jane', team: 'eng', age: 30 },
      ]) {
        tx.prepareUpsert('people', rec);
        tx.stageUpsert('people');
      }
      const r = tx.aggregate('people', {}, {
        byTeam: { count: true, groupBy: 'team' },
        oldest: { max: 'age' },
        engAges: { sum: 'age', where: { team: 'eng' } },
      });
      assert.deepEqual(r, { byTeam: { design: 1, eng: 2 }, oldest: 41, engAges: 47 });
      assert.throws(() => tx.aggregate('people', {}, { x: { nope: true } }), TypeError);
    } finally {
      tx.discard();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
