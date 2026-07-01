// Attachment + blob-staging + diff-rename boundary suite for gitsheets-napi.
//
// Drives the core's attachment surface through the napi `CoreTransaction` and
// proves parity with specs/behaviors/attachments.md + specs/api/sheet.md:
//   - the blob-write primitive (`writeBlob` hashes to the expected git blob hash);
//   - ATOMICITY: a record upsert + its attachment land in ONE commit (the tree
//     the transaction commits contains both — the crux the cutover needs);
//   - setAttachment(s) / getAttachment(s) / deleteAttachment(s) semantics
//     (overwrite, strict single-delete, idempotent bulk-delete no-op);
//   - diff rename detection: a moved record surfaces as status 'renamed' with
//     `previousPath`, matching `git diff-tree -M`.
//
// Requires the addon to be built first: `npm run build:debug` (or `build`).
// Run with: `npm test` (node --test).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);

let binding;
try {
  binding = require('../binding.cjs');
} catch (err) {
  throw new Error(
    `gitsheets-napi addon not built — run \`npm run build:debug\` first.\n  cause: ${err.message}`,
  );
}
const { CoreTransaction, writeBlob, diffRecords } = binding;

const CONFIG = "[gitsheet]\npath = '${{ slug }}'\nroot = 'users'\n";

// A repo with `.gitsheets/users.toml` committed on `main`, HEAD symbolic to it.
function setupRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'gitsheets-attach-'));
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Seed']);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'seed@x.org']);
  mkdirSync(join(dir, '.gitsheets'), { recursive: true });
  writeFileSync(join(dir, '.gitsheets/users.toml'), CONFIG);
  execFileSync('git', ['-C', dir, 'add', '.gitsheets/users.toml']);
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return { dir, gitDir: join(dir, '.git') };
}

function defaultOpts(message) {
  return {
    parent: undefined,
    branch: undefined,
    author: { name: 'Jane Doe', email: 'jane@x.org' },
    committer: undefined,
    message,
    trailers: undefined,
    timeSeconds: 1_700_000_000,
    offsetMinutes: -300,
  };
}

// Independently computed git blob hash: sha1("blob <len>\0<bytes>").
function gitBlobHash(bytes) {
  const h = createHash('sha1');
  h.update(`blob ${bytes.length}\0`);
  h.update(bytes);
  return h.digest('hex');
}

test('writeBlob hashes binary bytes to the git blob hash', () => {
  const { dir, gitDir } = setupRepo();
  try {
    const bytes = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0xff, 0x68, 0x69]);
    const hash = writeBlob(gitDir, bytes);
    assert.equal(hash, gitBlobHash(bytes));
    // git agrees too (the object is really in the ODB).
    const catType = execFileSync('git', ['--git-dir', gitDir, 'cat-file', '-t', hash]).toString().trim();
    assert.equal(catType, 'blob');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('record + attachment land in ONE commit (atomic staging)', () => {
  const { dir, gitDir } = setupRepo();
  try {
    const bytes = Buffer.from('AVATAR-BYTES');
    const tx = CoreTransaction.begin(gitDir, defaultOpts('add jane + avatar'));
    let attachHash;
    let result;
    try {
      tx.openSheet('users', '.gitsheets/users.toml', '.', '');
      tx.prepareUpsert('users', { slug: 'jane' });
      tx.stageUpsert('users');
      attachHash = writeBlob(gitDir, bytes);
      tx.setAttachment('users', 'jane', 'avatar.jpg', attachHash);
      result = tx.finalize();
    } catch (err) {
      tx.discard();
      throw err;
    }

    assert.ok(result.commitHash, 'a commit was produced');

    // Exactly ONE new commit (parent count 1) — not a record commit + a separate
    // attachment commit.
    const parents = execFileSync('git', ['--git-dir', gitDir, 'rev-list', '--parents', '-n', '1', result.commitHash])
      .toString().trim().split(/\s+/);
    assert.equal(parents.length, 2, 'commit has exactly one parent');

    // That single commit's tree contains BOTH the record and the attachment.
    const tree = execFileSync('git', ['--git-dir', gitDir, 'ls-tree', '-r', result.commitHash])
      .toString();
    assert.match(tree, /users\/jane\.toml/, 'record file is in the commit');
    assert.match(tree, /users\/jane\/avatar\.jpg/, 'attachment is in the SAME commit');

    // And the attachment blob is exactly the bytes we wrote.
    const blobHashInTree = execFileSync('git', ['--git-dir', gitDir, 'rev-parse', `${result.commitHash}:users/jane/avatar.jpg`])
      .toString().trim();
    assert.equal(blobHashInTree, attachHash);
    assert.equal(blobHashInTree, gitBlobHash(bytes));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('setAttachments / getAttachments / overwrite / getAttachment', () => {
  const { dir, gitDir } = setupRepo();
  try {
    const avatar = writeBlob(gitDir, Buffer.from('AV1'));
    const cover = writeBlob(gitDir, Buffer.from('COVER'));
    const tx = CoreTransaction.begin(gitDir, defaultOpts('seed'));
    try {
      tx.openSheet('users', '.gitsheets/users.toml', '.', '');
      tx.prepareUpsert('users', { slug: 'jane' });
      tx.stageUpsert('users');
      tx.setAttachments('users', 'jane', { 'avatar.jpg': avatar, 'cover.png': cover });

      // Overwrite avatar within the same tx.
      const avatar2 = writeBlob(gitDir, Buffer.from('AV2'));
      tx.setAttachment('users', 'jane', 'avatar.jpg', avatar2);

      const map = tx.getAttachments('users', 'jane');
      const byName = Object.fromEntries(map.map((e) => [e.name, e.hash]));
      assert.deepEqual(Object.keys(byName).sort(), ['avatar.jpg', 'cover.png']);
      assert.equal(byName['avatar.jpg'], avatar2, 'avatar overwritten');
      assert.equal(byName['cover.png'], cover);

      assert.equal(tx.getAttachment('users', 'jane', 'cover.png'), cover);
      assert.equal(tx.getAttachment('users', 'jane', 'nope.png'), null);
      tx.finalize();
    } catch (err) {
      tx.discard();
      throw err;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('getAttachments returns null when a record has no attachment dir', () => {
  const { dir, gitDir } = setupRepo();
  try {
    const tx = CoreTransaction.begin(gitDir, defaultOpts('seed'));
    try {
      tx.openSheet('users', '.gitsheets/users.toml', '.', '');
      tx.prepareUpsert('users', { slug: 'jane' });
      tx.stageUpsert('users');
      assert.equal(tx.getAttachments('users', 'jane'), null);
      tx.finalize();
    } catch (err) {
      tx.discard();
      throw err;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('deleteAttachment is strict; deleteAttachments is an idempotent no-op', () => {
  const { dir, gitDir } = setupRepo();
  try {
    // Seed jane with two attachments.
    let tx = CoreTransaction.begin(gitDir, defaultOpts('seed'));
    try {
      tx.openSheet('users', '.gitsheets/users.toml', '.', '');
      tx.prepareUpsert('users', { slug: 'jane' });
      tx.stageUpsert('users');
      tx.setAttachment('users', 'jane', 'avatar.jpg', writeBlob(gitDir, Buffer.from('A')));
      tx.setAttachment('users', 'jane', 'cover.png', writeBlob(gitDir, Buffer.from('C')));
      tx.finalize();
    } catch (err) {
      tx.discard();
      throw err;
    }

    // Strict single-delete: missing name throws NotFoundError.
    tx = CoreTransaction.begin(gitDir, defaultOpts('drop missing'));
    try {
      tx.openSheet('users', '.gitsheets/users.toml', '.', '');
      // CoreTransaction is the raw addon class — it throws structured errors
      // (code + gitsheetsClass discriminant), which the JS package maps to the
      // typed NotFoundError.
      assert.throws(
        () => tx.deleteAttachment('users', 'jane', 'nope.png'),
        (err) => err.code === 'record_not_found' && err.gitsheetsClass === 'NotFoundError',
      );
    } finally {
      tx.discard();
    }

    // Existing single-delete leaves the sibling.
    tx = CoreTransaction.begin(gitDir, defaultOpts('drop avatar'));
    try {
      tx.openSheet('users', '.gitsheets/users.toml', '.', '');
      tx.deleteAttachment('users', 'jane', 'avatar.jpg');
      const names = tx.getAttachments('users', 'jane').map((e) => e.name);
      assert.deepEqual(names, ['cover.png']);
      tx.finalize();
    } catch (err) {
      tx.discard();
      throw err;
    }

    // deleteAttachments on a record with NO dir → false, and the transaction is
    // a no-op (no commit) since nothing else mutated.
    tx = CoreTransaction.begin(gitDir, defaultOpts('add pat only'));
    try {
      tx.openSheet('users', '.gitsheets/users.toml', '.', '');
      tx.prepareUpsert('users', { slug: 'pat' });
      tx.stageUpsert('users');
      tx.finalize();
    } catch (err) {
      tx.discard();
      throw err;
    }
    tx = CoreTransaction.begin(gitDir, defaultOpts('wipe pat attachments (none)'));
    let result;
    try {
      tx.openSheet('users', '.gitsheets/users.toml', '.', '');
      const removed = tx.deleteAttachments('users', 'pat');
      assert.equal(removed, false, 'no dir → nothing removed');
      result = tx.finalize();
    } catch (err) {
      tx.discard();
      throw err;
    }
    assert.ok(!result.commitHash, 'no-op delete produces no commit');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('diffRecords detects a moved record as renamed, matching git diff-tree -M', () => {
  const { dir, gitDir } = setupRepo();
  try {
    // A 4-field record whose slug drives the path; changing only the slug keeps
    // ~75% of the lines → above git's 50% rename threshold.
    const person = (slug) => ({
      bio: 'A reasonably long biography line that stays put.',
      email: 'jane@example.org',
      name: 'Jane Q. Doe',
      slug,
    });

    // Commit 1: jane.
    let src;
    let tx = CoreTransaction.begin(gitDir, defaultOpts('add jane'));
    try {
      tx.openSheet('users', '.gitsheets/users.toml', '.', '');
      tx.prepareUpsert('users', person('jane'));
      tx.stageUpsert('users');
      src = tx.finalize();
    } catch (err) {
      tx.discard();
      throw err;
    }

    // Commit 2: move jane → jane-doe (delete old path via previousPath, write new).
    let dst;
    tx = CoreTransaction.begin(gitDir, defaultOpts('rename jane → jane-doe'));
    try {
      tx.openSheet('users', '.gitsheets/users.toml', '.', '');
      tx.prepareUpsert('users', person('jane-doe'), 'jane');
      tx.stageUpsert('users');
      dst = tx.finalize();
    } catch (err) {
      tx.discard();
      throw err;
    }

    const diffs = diffRecords(gitDir, src.commitHash, dst.commitHash, 'users');
    assert.equal(diffs.length, 1, 'one rename, not add + delete');
    const change = diffs[0];
    assert.equal(change.status, 'renamed');
    assert.equal(change.path, 'jane-doe');
    assert.equal(change.previousPath, 'jane');
    assert.ok(change.srcHash && change.dstHash);

    // git diff-tree -M agrees it's a rename.
    const gitOut = execFileSync('git', [
      '--git-dir', gitDir, 'diff-tree', '-M', '-r', '--name-status', '--no-commit-id',
      src.commitHash, dst.commitHash, '--', 'users',
    ]).toString();
    assert.ok(
      gitOut.split('\n').some((l) => l.startsWith('R') && l.includes('users/jane.toml') && l.includes('users/jane-doe.toml')),
      `git diff-tree -M should report a rename, got: ${JSON.stringify(gitOut)}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
