// Error-mapping tests for the gitsheets-napi boundary.
//
// A core error must surface in JS as a STRUCTURED, matchable error: an
// `instanceof` the right typed `GitsheetsError` subclass, carrying a stable
// `code`/`status` discriminant (asserted directly — never by message substring)
// and class-specific payloads (`issues`, `conflictingPaths`).
//
// Requires the addon to be built first: `npm run build:debug` (or `build`).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const binding = require('../binding.cjs');

const {
  simulateCoreError,
  GitsheetsError,
  ConfigError,
  ValidationError,
  TransactionError,
  IndexError,
  RefError,
  PathTemplateError,
  NotFoundError,
} = binding;

// Capture the thrown error from a code.
function thrownFor(code) {
  try {
    simulateCoreError(code);
  } catch (err) {
    return err;
  }
  throw new Error(`expected simulateCoreError(${code}) to throw`);
}

test('validation_failed maps to ValidationError with structured issues', () => {
  const err = thrownFor('validation_failed');
  assert.ok(err instanceof ValidationError, 'is a ValidationError');
  assert.ok(err instanceof GitsheetsError, 'and a GitsheetsError');
  assert.equal(err.code, 'validation_failed'); // matchable discriminant, not substring
  assert.equal(err.status, 422);
  assert.ok(Array.isArray(err.issues) && err.issues.length > 0, 'carries issues');
  const issue = err.issues[0];
  assert.deepEqual(issue.path, ['email']);
  assert.equal(issue.source, 'json-schema');
  assert.equal(issue.code, 'pattern');
});

test('index_unique_conflict maps to IndexError with conflictingPaths', () => {
  const err = thrownFor('index_unique_conflict');
  assert.ok(err instanceof IndexError);
  assert.equal(err.code, 'index_unique_conflict');
  assert.equal(err.status, 409);
  assert.ok(Array.isArray(err.conflictingPaths) && err.conflictingPaths.length > 0);
});

test('each code maps to its typed class, code, and status', () => {
  const expected = [
    ['config_missing', ConfigError, 500],
    ['config_invalid', ConfigError, 500],
    ['transaction_in_progress', TransactionError, 409],
    ['transaction_required', TransactionError, 409],
    ['parent_moved', TransactionError, 409],
    ['commit_failed', TransactionError, 500],
    ['push_daemon_running', TransactionError, 409],
    ['transaction_closed', TransactionError, 409],
    ['index_not_defined', IndexError, 500],
    ['ref_not_found', RefError, 404],
    ['not_an_ancestor', RefError, 409],
    ['path_render_failed', PathTemplateError, 422],
    ['path_invalid_chars', PathTemplateError, 422],
    ['record_not_found', NotFoundError, 404],
  ];
  for (const [code, Cls, status] of expected) {
    const err = thrownFor(code);
    assert.ok(err instanceof Cls, `${code} should be a ${Cls.name}`);
    assert.ok(err instanceof GitsheetsError, `${code} should be a GitsheetsError`);
    assert.equal(err.code, code, `${code} should carry its stable code`);
    assert.equal(err.status, status, `${code} should carry status ${status}`);
    assert.equal(typeof err.message, 'string');
  }
});

test('the structured error is a real Error with a stack', () => {
  const err = thrownFor('ref_not_found');
  assert.ok(err instanceof Error);
  assert.equal(typeof err.stack, 'string');
  // The original structured cause is preserved.
  assert.equal(err.cause.code, 'ref_not_found');
  assert.equal(err.cause.gitsheetsClass, 'RefError');
});

test('an unknown code surfaces as a plain (non-typed) error', () => {
  let threw = false;
  try {
    simulateCoreError('not_a_real_code');
  } catch (err) {
    threw = true;
    assert.ok(!(err instanceof GitsheetsError), 'unknown codes are not typed');
  }
  assert.ok(threw, 'should still throw');
});
