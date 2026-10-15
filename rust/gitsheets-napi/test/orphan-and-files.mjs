// Orphan commits + raw file writes at the napi boundary
// (specs/api/transaction.md "Parent ref handling" / "Raw files", #305).
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
const { CoreTransaction, writeBlob, blobHeader, syncBranch, isAncestor, mergeSheets, mergeRecordTexts } = require('../binding.cjs');

function setupRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'gitsheets-orphan-'));
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Seed']);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'seed@x.org']);
  mkdirSync(join(dir, '.gitsheets'), { recursive: true });
  writeFileSync(join(dir, '.gitsheets/people.toml'), "[gitsheet]\npath = '${{ slug }}'\nroot = 'people'\n");
  execFileSync('git', ['-C', dir, 'add', '.gitsheets/people.toml']);
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return { dir, gitDir: join(dir, '.git') };
}

function opts(message, extra = {}) {
  return {
    parent: undefined,
    branch: undefined,
    author: { name: 'Jane Doe', email: 'jane@x.org' },
    committer: undefined,
    message,
    trailers: undefined,
    timeSeconds: 1_700_000_000,
    offsetMinutes: -300,
    ...extra,
  };
}

const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args]).toString();

test('orphan: empty start, no parents, branch created; existing branch refused', () => {
  const { dir, gitDir } = setupRepo();
  try {
    const tx = CoreTransaction.begin(gitDir, opts('snapshot', { orphan: true, branch: 'snapshot' }));
    assert.equal(tx.parentCommitHash() ?? null, null);
    const hash = tx.writeFile('README.md', 'scrubbed\n');
    assert.match(hash, /^[0-9a-f]{40}$/);
    const result = tx.finalize();
    assert.equal(result.refName, 'refs/heads/snapshot');
    assert.equal(result.parentCommitHash ?? null, null);
    const parents = git(dir, 'rev-list', '--parents', '-n', '1', result.commitHash).trim().split(/\s+/).slice(1);
    assert.deepEqual(parents, []);
    assert.deepEqual(git(dir, 'ls-tree', '-r', '--name-only', result.commitHash).trim().split('\n'), ['README.md']);

    assert.throws(
      () => CoreTransaction.begin(gitDir, opts('again', { orphan: true, branch: 'snapshot' })),
      // `begin` is a napi factory: the raw addon error carries the typed code
      // (the host's `callCore` maps it onto TransactionError).
      (err) => err.code === 'commit_failed' && /already exists/.test(err.message),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeFile accepts a Buffer and deleteFile reports existence', () => {
  const { dir, gitDir } = setupRepo();
  try {
    const tx = CoreTransaction.begin(gitDir, opts('bytes'));
    tx.writeFile('fixtures/blob.bin', Buffer.from([0, 1, 2]));
    assert.equal(tx.deleteFile('fixtures/missing'), false);
    const result = tx.finalize();
    const bytes = execFileSync('git', ['-C', dir, 'show', `${result.commitHash}:fixtures/blob.bin`]);
    assert.deepEqual([...bytes], [0, 1, 2]);

    const tx2 = CoreTransaction.begin(gitDir, opts('rm'));
    assert.equal(tx2.deleteFile('fixtures/blob.bin'), true);
    const r2 = tx2.finalize();
    assert.ok(!git(dir, 'ls-tree', '-r', '--name-only', r2.commitHash).includes('fixtures/blob.bin'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('branch creates a missing branch from the parent', () => {
  const { dir, gitDir } = setupRepo();
  try {
    const main = git(dir, 'rev-parse', 'refs/heads/main').trim();
    const tx = CoreTransaction.begin(gitDir, opts('fork', { parent: 'main', branch: 'review/x' }));
    tx.writeFile('x.txt', 'x');
    const result = tx.finalize();
    assert.equal(result.refName, 'refs/heads/review/x');
    assert.equal(git(dir, 'rev-parse', 'refs/heads/review/x').trim(), result.commitHash);
    assert.equal(git(dir, 'rev-parse', 'refs/heads/main').trim(), main);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('blobHeader: kind + size from the object header; null for a missing id', () => {
  const { dir, gitDir } = setupRepo();
  try {
    const hash = writeBlob(gitDir, Buffer.from([1, 2, 3, 4, 5]));
    assert.deepEqual(blobHeader(gitDir, hash), { kind: 'blob', size: 5 });
    assert.equal(blobHeader(gitDir, '0'.repeat(40)) ?? null, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('syncBranch fast-forwards a behind branch; isAncestor follows reachability', () => {
  const { dir, gitDir } = setupRepo();
  try {
    const base = git(dir, 'rev-parse', 'main').trim();
    // Simulate a fetched remote tip one commit ahead.
    const tx = CoreTransaction.begin(gitDir, opts('remote work', { parent: 'main', branch: 'refs/remotes/origin/main' }));
    tx.writeFile('remote.txt', 'r');
    const remoteTip = tx.finalize().commitHash;
    const r = syncBranch(gitDir, {
      branch: 'main',
      remoteRef: 'refs/remotes/origin/main',
      onConflict: 'fail',
      timeSeconds: 1_700_000_000,
      offsetMinutes: 0,
    });
    assert.equal(r.outcome, 'fast-forwarded');
    assert.equal(r.oldCommit, base);
    assert.equal(r.newCommit, remoteTip);
    assert.deepEqual([r.ahead, r.behind], [0, 1]);
    assert.equal(git(dir, 'rev-parse', 'main').trim(), remoteTip);
    assert.equal(isAncestor(gitDir, base, remoteTip), true);
    assert.equal(isAncestor(gitDir, remoteTip, base), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mergeSheets field-merges a record changed on both sides and writes it canonically', () => {
  const { dir, gitDir } = setupRepo();
  try {
    const seed = CoreTransaction.begin(gitDir, opts('jane'));
    seed.writeFile('people/jane.toml', 'email = "jane@x.org"\nname = "Jane"\nslug = "jane"\n');
    const base = seed.finalize().commitHash;
    const o = CoreTransaction.begin(gitDir, opts('ours', { parent: 'main' }));
    o.writeFile('people/jane.toml', 'email = "jane@new.org"\nname = "Jane"\nslug = "jane"\n');
    o.finalize();
    const t = CoreTransaction.begin(gitDir, opts('theirs', { parent: base, branch: 'import' }));
    t.writeFile('people/jane.toml', 'slug = "jane"\nname = "Jane"\nemail = "jane@x.org"\ngithubUserId = 458_494\n');
    t.finalize();
    const r = mergeSheets(gitDir, { ours: 'main', theirs: 'import', timeSeconds: 1_700_000_000, offsetMinutes: 0, author: { name: 'M', email: 'm@x.org' } });
    assert.equal(r.outcome, 'merged');
    assert.deepEqual(r.mergedRecords, ['people/jane.toml']);
    const merged = execFileSync('git', ['-C', dir, 'show', `${r.commit}:people/jane.toml`]).toString();
    assert.equal(merged, 'email = "jane@new.org"\ngithubUserId = 458494\nname = "Jane"\nslug = "jane"\n');
    assert.equal(git(dir, 'rev-parse', 'main').trim(), r.commit);

    const one = mergeRecordTexts(gitDir, 'HEAD', 'people', '.gitsheets/people.toml', '.', 'a = 1\nslug = "x"\n', 'a = 2\nslug = "x"\n', 'a = 1\nb = 3\nslug = "x"\n', 'fail');
    assert.equal(one.text, 'a = 2\nb = 3\nslug = "x"\n');
    const conflict = mergeRecordTexts(gitDir, 'HEAD', 'people', '.gitsheets/people.toml', '.', 'a = 1\nslug = "x"\n', 'a = 2\nslug = "x"\n', 'a = 3\nslug = "x"\n', 'fail');
    assert.equal(conflict.text ?? null, null);
    assert.deepEqual(conflict.conflicts, ['a']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readFile sees a file staged earlier in the transaction', () => {
  const { dir, gitDir } = setupRepo();
  try {
    const tx = CoreTransaction.begin(gitDir, opts('stage', { orphan: true }));
    assert.equal(tx.readFile('.gitsheets/people.toml') ?? null, null); // orphan: empty start
    tx.writeFile('.gitsheets/x.toml', 'a = 1\n');
    const entry = tx.readFile('.gitsheets/x.toml');
    assert.equal(entry.content.toString(), 'a = 1\n');
    assert.match(entry.hash, /^[0-9a-f]{40}$/);
    tx.discard();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
