// Rollup sheets at the napi boundary (specs/behaviors/rollups.md): the
// commit-time pass inside CoreTransaction.finalize, the stateless
// read-through (rollupQuery / rollupGet / rollupStatus), the tx-bound
// materialize / rollupStatus, `stale`, and the error mapping.
//
// Requires the addon to be built first: `npm run build:debug` (or `build`).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { CoreTransaction, rollupQuery, rollupGet, rollupStatus } = require('../binding.cjs');

const TX = "[gitsheet]\nroot = 'transactions'\npath = '${{ postedAt: YYYY/MM }}/${{ id }}'\n";
const MONTHLY =
  "[gitsheet]\nroot = 'transactions-monthly'\npath = '${{ postedAt: YYYY/MM }}'\n\n[gitsheet.rollup]\nfrom = 'transactions'\n\n[gitsheet.rollup.aggregates]\ncount = { count = true }\ntotal = { sum = 'amountCents' }\n";

const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args]).toString();

function setupRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'gitsheets-rollup-'));
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Seed']);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'seed@x.org']);
  mkdirSync(join(dir, '.gitsheets'), { recursive: true });
  writeFileSync(join(dir, '.gitsheets/transactions.toml'), TX);
  writeFileSync(join(dir, '.gitsheets/transactions-monthly.toml'), MONTHLY);
  execFileSync('git', ['-C', dir, 'add', '.gitsheets']);
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return { dir, gitDir: join(dir, '.git') };
}

function begin(gitDir, message = 'tx') {
  return CoreTransaction.begin(gitDir, {
    parent: undefined,
    branch: undefined,
    author: { name: 'Jane Doe', email: 'jane@x.org' },
    committer: undefined,
    message,
    trailers: undefined,
    timeSeconds: 1_700_000_000,
    offsetMinutes: 0,
  });
}

function upsertAll(gitDir, records) {
  const tx = begin(gitDir);
  tx.openSheet('transactions', '.gitsheets/transactions.toml', '.', '');
  for (const r of records) {
    tx.prepareUpsert('transactions', r);
    tx.stageUpsert('transactions');
  }
  return tx.finalize();
}

const rec = (id, iso, cents) => ({ id, postedAt: new Date(iso), amountCents: cents });

test('finalize runs the rollup pass: records and rollups in one commit', () => {
  const { dir, gitDir } = setupRepo();
  try {
    const r = upsertAll(gitDir, [rec('a', '2026-03-01T00:00:00Z', 5), rec('b', '2026-03-02T00:00:00Z', 7)]);
    const text = git(dir, 'show', `${r.commitHash}:transactions-monthly/2026/03.toml`);
    const stamp = git(dir, 'rev-parse', `${r.commitHash}:transactions/2026/03`).trim();
    assert.equal(text, `count = 2\npostedAt = 2026-03-01\nsourceTree = "${stamp}"\ntotal = 12\n`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stateless read-through, stale modes, status, and tx-bound materialize', () => {
  const { dir, gitDir } = setupRepo();
  try {
    upsertAll(gitDir, [rec('a', '2026-03-01T00:00:00Z', 5)]);
    // A raw git write the pass never saw.
    git(dir, 'reset', '-q', '--hard');
    mkdirSync(join(dir, 'transactions/2026/03'), { recursive: true });
    writeFileSync(join(dir, 'transactions/2026/03/z.toml'), 'amountCents = 1\nid = "z"\npostedAt = 2026-03-09T00:00:00Z\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'raw');

    const args = [gitDir, 'HEAD', 'transactions-monthly', '.gitsheets/transactions-monthly.toml', '.', ''];
    const rows = rollupQuery(...args, {}, undefined);
    assert.deepEqual(rows.map((r) => [r.path, r.record.count]), [['2026/03', 2]]);
    assert.equal(rollupQuery(...args, {}, 'serve')[0].record.count, 1);
    assert.equal(rollupGet(...args, '2026/03', 'recompute').count, 2);
    assert.equal(rollupGet(...args, '2026/04', undefined), null);
    assert.deepEqual(rollupStatus(...args), [{ path: '2026/03', status: 'stale' }]);
    assert.throws(() => rollupQuery(...args, {}, 'bogus'), /stale mode/);

    const tx = begin(gitDir, 'materialize');
    tx.openSheet('transactions-monthly', '.gitsheets/transactions-monthly.toml', '.', '');
    assert.deepEqual(tx.rollupStatus('transactions-monthly'), [{ path: '2026/03', status: 'stale' }]);
    assert.deepEqual(tx.materialize('transactions-monthly'), { recomputed: ['2026/03'], deleted: [] });
    assert.equal(tx.query('transactions-monthly', {}, true, 'serve')[0].record.count, 2);
    assert.ok(tx.finalize().commitHash);
    assert.deepEqual(rollupStatus(...args), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writes to a rollup sheet throw sheet_derived; materialize on a plain sheet is a TypeError', () => {
  const { dir, gitDir } = setupRepo();
  try {
    const tx = begin(gitDir);
    tx.openSheet('transactions-monthly', '.gitsheets/transactions-monthly.toml', '.', '');
    tx.openSheet('transactions', '.gitsheets/transactions.toml', '.', '');
    assert.throws(
      () => tx.prepareUpsert('transactions-monthly', { postedAt: new Date('2026-03-01T00:00:00Z'), count: 1 }),
      (err) => err.code === 'sheet_derived' && err.gitsheetsClass === 'TransactionError' && err.status === 409,
    );
    assert.throws(() => tx.materialize('transactions'), TypeError);
    tx.discard();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
