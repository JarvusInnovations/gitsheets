// Sheet / Transaction / Store orchestration boundary suite for gitsheets-napi.
//
// Drives the core's state machine through the napi `CoreTransaction` and proves
// behavioral parity with specs/api/{transaction,sheet,store}.md +
// behaviors/transactions.md:
//   - the full transaction lifecycle: commit (with identity + trailers + the
//     written record), no-op detection (re-upsert of byte-identical bytes), the
//     optimistic parent_moved conflict, and the transaction_in_progress guard;
//   - the TWO-PHASE consumer-validator protocol: prepareUpsert (phase 1) hands a
//     candidate to the host validator, which can REJECT before stageUpsert
//     (phase 3) writes any bytes;
//   - Store discovery + the config_missing validator check.
//
// Requires the addon to be built first: `npm run build:debug` (or `build`).
// Run with: `npm test` (node --test).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
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
const { CoreTransaction, coreDiscoverSheets, coreCheckValidators } = binding;

const CONFIG = "[gitsheet]\npath = '${{ slug }}'\nroot = 'people'\n";

// A repo with `.gitsheets/people.toml` committed on `main`, HEAD symbolic to it.
function setupRepo(config = CONFIG) {
  const dir = mkdtempSync(join(tmpdir(), 'gitsheets-sscore-'));
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Seed']);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'seed@x.org']);
  mkdirSync(join(dir, '.gitsheets'), { recursive: true });
  writeFileSync(join(dir, '.gitsheets/people.toml'), config);
  execFileSync('git', ['-C', dir, 'add', '.gitsheets/people.toml']);
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return { dir, gitDir: join(dir, '.git') };
}

function defaultOpts(message, extra = {}) {
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

// Drive one full prepare → (host validator) → stage → finalize cycle.
function upsertOne(gitDir, opts, record, validate) {
  const tx = CoreTransaction.begin(gitDir, opts);
  try {
    tx.openSheet('people', '.gitsheets/people.toml', '.', '');
    const candidate = tx.prepareUpsert('people', record);
    if (validate) validate(candidate.record); // host-side consumer validator
    tx.stageUpsert('people');
    return tx.finalize();
  } catch (err) {
    tx.discard();
    throw err;
  }
}

function gitLog(gitDir, format) {
  return execFileSync('git', ['--git-dir', gitDir, 'log', '-1', `--format=${format}`])
    .toString()
    .trim();
}

test('full upsert commits with identity, trailers, and the written record', () => {
  const { dir, gitDir } = setupRepo();
  try {
    const opts = defaultOpts('people: add jane', {
      trailers: [{ key: 'Action', value: 'person.create' }],
    });
    const result = upsertOne(gitDir, opts, { slug: 'jane', email: 'jane@x.org' });

    assert.match(result.commitHash, /^[0-9a-f]{40}$/, 'a commit was produced');
    assert.equal(result.refName, 'refs/heads/main');

    // Branch advanced; identity + trailer survived.
    assert.equal(gitLog(gitDir, '%H'), result.commitHash);
    assert.equal(gitLog(gitDir, '%an'), 'Jane Doe');
    assert.equal(gitLog(gitDir, '%ae'), 'jane@x.org');
    assert.equal(gitLog(gitDir, '%cn'), 'Jane Doe'); // committer falls back to author
    const body = gitLog(gitDir, '%B');
    assert.match(body, /people: add jane/);
    assert.match(body, /Action: person\.create/);

    // The record landed at people/jane.toml with canonical (key-sorted) bytes.
    const blob = execFileSync('git', [
      '--git-dir',
      gitDir,
      'show',
      `${result.commitHash}:people/jane.toml`,
    ]).toString();
    assert.equal(blob, 'email = "jane@x.org"\nslug = "jane"\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('re-upsert of byte-identical record is a no-op (no commit)', () => {
  const { dir, gitDir } = setupRepo();
  try {
    const first = upsertOne(gitDir, defaultOpts('add jane'), { slug: 'jane', email: 'j@x.org' });
    assert.ok(first.commitHash);

    const second = upsertOne(gitDir, defaultOpts('re-add jane'), { slug: 'jane', email: 'j@x.org' });
    assert.equal(second.commitHash ?? null, null, 'tree-hash equality → no commit');
    assert.equal(second.refName ?? null, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('no mutating call short-circuits finalize to a no-op', () => {
  const { dir, gitDir } = setupRepo();
  try {
    const tx = CoreTransaction.begin(gitDir, defaultOpts('nothing'));
    const result = tx.finalize();
    assert.equal(result.commitHash ?? null, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parent_moved when the branch advances mid-transaction', () => {
  const { dir, gitDir } = setupRepo();
  try {
    const tx = CoreTransaction.begin(gitDir, defaultOpts('add jane'));
    tx.openSheet('people', '.gitsheets/people.toml', '.', '');
    const cand = tx.prepareUpsert('people', { slug: 'jane' });
    tx.stageUpsert('people');

    // A separate process commits to refs/heads/main.
    execFileSync('git', ['-C', dir, 'commit', '-q', '--allow-empty', '-m', 'external']);

    void cand;
    assert.throws(
      () => tx.finalize(),
      (err) => err.code === 'parent_moved',
      'finalize detects the parent move',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a concurrent open on the same repo is transaction_in_progress', () => {
  const { dir, gitDir } = setupRepo();
  try {
    const tx1 = CoreTransaction.begin(gitDir, defaultOpts('first'));
    try {
      assert.throws(
        () => CoreTransaction.begin(gitDir, defaultOpts('second')),
        (err) => err.code === 'transaction_in_progress',
      );
    } finally {
      tx1.discard();
    }
    // Slot freed — a fresh open succeeds.
    const tx2 = CoreTransaction.begin(gitDir, defaultOpts('third'));
    tx2.discard();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── the two-phase consumer-validator protocol ──────────────────────────────────

test('the consumer validator can REJECT a write before any bytes are written', () => {
  const { dir, gitDir } = setupRepo();
  try {
    // A host-side validator that requires a non-empty email (Zod/Pydantic stand-in).
    const validate = (record) => {
      if (typeof record.email !== 'string' || record.email.length === 0) {
        throw new Error('email is required');
      }
    };

    // Phase 1 returns the candidate; the host validator throws; phase 3 (stage)
    // never runs → no bytes, the finalize is a no-op.
    assert.throws(
      () => upsertOne(gitDir, defaultOpts('bad'), { slug: 'bad' }, validate),
      /email is required/,
    );

    // Prove nothing was written: a fresh transaction sees no people/bad.toml.
    assert.throws(
      () => execFileSync('git', ['--git-dir', gitDir, 'show', 'HEAD:people/bad.toml'], {
        stdio: ['ignore', 'ignore', 'ignore'],
      }),
      'the rejected record was never committed',
    );

    // And the same record, once it passes the validator, DOES commit.
    const ok = upsertOne(gitDir, defaultOpts('good'), { slug: 'good', email: 'g@x.org' }, validate);
    assert.ok(ok.commitHash);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('willChange reports idempotency without mutating', () => {
  const { dir, gitDir } = setupRepo();
  try {
    upsertOne(gitDir, defaultOpts('add jane'), { slug: 'jane', email: 'j@x.org' });

    const tx = CoreTransaction.begin(gitDir, defaultOpts('check'));
    try {
      tx.openSheet('people', '.gitsheets/people.toml', '.', '');
      const same = tx.willChange('people', { slug: 'jane', email: 'j@x.org' });
      assert.equal(same.changed, false, 'byte-identical → no change');
      assert.match(same.currentBlobHash, /^[0-9a-f]{40}$/);

      const diff = tx.willChange('people', { slug: 'jane', email: 'new@x.org' });
      assert.equal(diff.changed, true);
    } finally {
      // willChange never mutated → finalize is a no-op; discard to free the slot.
      tx.discard();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('JSON-Schema shape validation rejects in phase 1', () => {
  const config =
    "[gitsheet]\npath = '${{ slug }}'\nroot = 'people'\n" +
    "[gitsheet.schema]\ntype = 'object'\nrequired = ['email']\n" +
    "[gitsheet.schema.properties.email]\ntype = 'string'\nformat = 'email'\n";
  const { dir, gitDir } = setupRepo(config);
  try {
    const tx = CoreTransaction.begin(gitDir, defaultOpts('bad'));
    try {
      tx.openSheet('people', '.gitsheets/people.toml', '.', '');
      assert.throws(
        () => tx.prepareUpsert('people', { slug: 'jane', email: 'not-an-email' }),
        (err) => err.code === 'validation_failed' && err.gitsheetsClass === 'ValidationError',
      );
    } finally {
      tx.discard();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('delete and clear', () => {
  const { dir, gitDir } = setupRepo();
  try {
    upsertOne(gitDir, defaultOpts('add jane'), { slug: 'jane' });
    upsertOne(gitDir, defaultOpts('add bob'), { slug: 'bob' });

    // delete jane
    const tx = CoreTransaction.begin(gitDir, defaultOpts('delete jane'));
    let result;
    try {
      tx.openSheet('people', '.gitsheets/people.toml', '.', '');
      tx.delete('people', 'jane');
      result = tx.finalize();
    } catch (err) {
      tx.discard();
      throw err;
    }
    assert.ok(result.commitHash);
    assert.throws(() =>
      execFileSync('git', ['--git-dir', gitDir, 'show', 'HEAD:people/jane.toml'], {
        stdio: ['ignore', 'ignore', 'ignore'],
      }),
    );
    // bob survives
    execFileSync('git', ['--git-dir', gitDir, 'show', 'HEAD:people/bob.toml']);

    // delete of a missing record throws record_not_found
    const tx2 = CoreTransaction.begin(gitDir, defaultOpts('delete ghost'));
    try {
      tx2.openSheet('people', '.gitsheets/people.toml', '.', '');
      assert.throws(
        () => tx2.delete('people', 'ghost'),
        (err) => err.code === 'record_not_found',
      );
    } finally {
      tx2.discard();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Store discovery + validator check ──────────────────────────────────────────

test('discover_sheets enumerates .gitsheets/*.toml', () => {
  const { dir, gitDir } = setupRepo();
  try {
    // Add a second sheet config and commit.
    writeFileSync(join(dir, '.gitsheets/projects.toml'), "[gitsheet]\npath = '${{ slug }}'\n");
    execFileSync('git', ['-C', dir, 'add', '.gitsheets/projects.toml']);
    execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'add projects']);

    const names = coreDiscoverSheets(gitDir, 'HEAD', '.');
    assert.deepEqual(names, ['people', 'projects']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('check_validators flags a validator naming a missing sheet', () => {
  assert.doesNotThrow(() => coreCheckValidators(['people', 'projects'], ['people']));
  assert.throws(
    () => coreCheckValidators(['people'], ['projects']),
    (err) => err.code === 'config_missing' && err.name === 'ConfigError',
  );
});
