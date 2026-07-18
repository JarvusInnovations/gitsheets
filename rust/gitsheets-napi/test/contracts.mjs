// Schema contracts boundary suite for gitsheets-napi.
//
// Proves the napi surface for specs/behaviors/contracts.md:
//   - `implements` naming an absent contract fails sheet-open with a typed
//     ContractError (`contract_missing`)
//   - a vendored document violating a document requirement fails sheet-open
//     with `contract_invalid`, naming the violated rule
//   - `allOf` composition: a contract-required field missing on write reports
//     an issue naming the contract; a conforming write succeeds
//   - `canonicalContractHash` yields the identical hash for the same document
//     supplied as JSON text, TOML text, and parsed data
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
const { CoreTransaction, canonicalContractHash, serializeRecords } = binding;

const CONTRACT_NAME = 'example.com/people/v1';

// Canonicalize a contract fixture through the SAME encoder `load_contract`
// checks vendored bytes against, so each test isolates exactly the one
// document-requirement violation it's naming (not an incidental
// non-canonical-bytes failure from hand-typed TOML).
function canonicalToml(doc) {
  return serializeRecords([doc])[0];
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

// A repo with `.gitsheets/people.toml` (declaring `implements`) committed on
// `main`. `contractToml`, when given, is also vendored at its derived path.
function setupRepo(sheetConfig, contractToml) {
  const dir = mkdtempSync(join(tmpdir(), 'gitsheets-contracts-'));
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Seed']);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'seed@x.org']);
  mkdirSync(join(dir, '.gitsheets'), { recursive: true });
  writeFileSync(join(dir, '.gitsheets/people.toml'), sheetConfig);
  execFileSync('git', ['-C', dir, 'add', '.gitsheets/people.toml']);
  if (contractToml !== undefined) {
    const contractDir = join(dir, '.gitsheets/contracts/example.com/people');
    mkdirSync(contractDir, { recursive: true });
    writeFileSync(join(contractDir, 'v1.toml'), contractToml);
    execFileSync('git', ['-C', dir, 'add', '.gitsheets/contracts']);
  }
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return { dir, gitDir: join(dir, '.git') };
}

const SHEET_WITH_IMPLEMENTS =
  "[gitsheet]\npath = '${{ slug }}'\nroot = 'people'\n" +
  `implements = ['${CONTRACT_NAME}']\n`;

// A minimal conforming contract requiring `email`.
const CONFORMING_CONTRACT = canonicalToml({
  $id: `https://${CONTRACT_NAME}`,
  type: 'object',
  required: ['email'],
  properties: { email: { type: 'string' } },
});

test('implements naming an absent contract fails sheet-open with contract_missing', () => {
  const { dir, gitDir } = setupRepo(SHEET_WITH_IMPLEMENTS);
  try {
    const tx = CoreTransaction.begin(gitDir, defaultOpts('open'));
    try {
      assert.throws(
        () => tx.openSheet('people', '.gitsheets/people.toml', '.', ''),
        (err) => err.code === 'contract_missing' && err.gitsheetsClass === 'ContractError',
      );
    } finally {
      tx.discard();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a document-requirement violation fails sheet-open with contract_invalid', () => {
  // $id mismatched against the derived path.
  const badContract = canonicalToml({
    $id: 'https://example.com/people/v2',
    type: 'object',
  });
  const { dir, gitDir } = setupRepo(SHEET_WITH_IMPLEMENTS, badContract);
  try {
    const tx = CoreTransaction.begin(gitDir, defaultOpts('open'));
    try {
      assert.throws(
        () => tx.openSheet('people', '.gitsheets/people.toml', '.', ''),
        (err) =>
          err.code === 'contract_invalid' &&
          err.gitsheetsClass === 'ContractError' &&
          /\$id/.test(err.message),
      );
    } finally {
      tx.discard();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a contract-required field missing on write names the contract', () => {
  const { dir, gitDir } = setupRepo(SHEET_WITH_IMPLEMENTS, CONFORMING_CONTRACT);
  try {
    const tx = CoreTransaction.begin(gitDir, defaultOpts('bad write'));
    try {
      tx.openSheet('people', '.gitsheets/people.toml', '.', '');
      assert.throws(
        () => tx.prepareUpsert('people', { slug: 'jane' }), // missing `email`
        (err) => {
          assert.equal(err.code, 'validation_failed');
          const issue = err.issues.find((i) => i.code === 'required');
          assert.equal(issue.contract, CONTRACT_NAME);
          return true;
        },
      );
      // A conforming write, with an extra local field the contract never
      // mentions, succeeds — contracts stay open by construction.
      const candidate = tx.prepareUpsert('people', {
        slug: 'jane',
        email: 'jane@x.org',
        extra: 'z',
      });
      assert.equal(candidate.record.email, 'jane@x.org');
    } finally {
      tx.discard();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('canonicalContractHash is identical across data, JSON text, and TOML text', () => {
  const data = { $id: `https://${CONTRACT_NAME}`, type: 'object' };
  const jsonText = JSON.stringify(data);
  const tomlText = `'$id' = 'https://${CONTRACT_NAME}'\ntype = 'object'\n`;

  const fromData = canonicalContractHash(data);
  const fromJson = canonicalContractHash(jsonText, 'json');
  const fromToml = canonicalContractHash(tomlText, 'toml');

  assert.equal(fromData, fromJson);
  assert.equal(fromJson, fromToml);
  assert.match(fromData, /^[0-9a-f]{64}$/, 'sha256 hex digest');
});

test('canonicalContractHash requires a format when given a string', () => {
  // A binding-level argument-validation error (not a structured core error):
  // there is no format auto-detection.
  assert.throws(() => canonicalContractHash('a = 1\n'), /format/);
});
