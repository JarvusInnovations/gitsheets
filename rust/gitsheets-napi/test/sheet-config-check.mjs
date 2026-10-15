// Template-coherence boundary suite for gitsheets-napi
// (specs/behaviors/path-templates.md "Template fields must be schema-required").
//
// `sheetConfigCheck` opens a sheet against a committed tree and surfaces the
// core's open-time validation: a static template field the persisted schema
// does not require fails with ConfigError(config_invalid) naming the field;
// there is no exemption list (specs/principles.md); the removed
// `injectedFields` key is itself rejected.
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
const binding = require('../binding.cjs');
const { sheetConfigCheck, ConfigError } = binding;

function setupRepo(config) {
  const dir = mkdtempSync(join(tmpdir(), 'gitsheets-cfgcheck-'));
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Seed']);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'seed@x.org']);
  mkdirSync(join(dir, '.gitsheets'), { recursive: true });
  writeFileSync(join(dir, '.gitsheets/roles.toml'), config);
  execFileSync('git', ['-C', dir, 'add', '.gitsheets/roles.toml']);
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
  return { dir, gitDir: join(dir, '.git') };
}

const BAD = `[gitsheet]
root = 'roles'
path = '\${{ projectSlug }}/\${{ slug }}'

[gitsheet.schema]
type = 'object'
required = ['slug']
`;

test('sheetConfigCheck: a template field the schema does not require is config_invalid', () => {
  const { dir, gitDir } = setupRepo(BAD);
  try {
    assert.throws(
      () => sheetConfigCheck(gitDir, 'HEAD', 'roles', '.gitsheets/roles.toml', '.'),
      (err) => {
        assert.ok(err instanceof ConfigError, `expected ConfigError, got ${err?.constructor?.name}`);
        assert.equal(err.code, 'config_invalid');
        assert.match(err.message, /"projectSlug"/);
        assert.match(err.message, /`required`/);
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sheetConfigCheck: the removed injectedFields key is config_invalid by name; requiring the field opens', () => {
  const { dir, gitDir } = setupRepo(BAD.replace("root = 'roles'", "root = 'roles'\ninjectedFields = ['projectSlug']"));
  try {
    assert.throws(
      () => sheetConfigCheck(gitDir, 'HEAD', 'roles', '.gitsheets/roles.toml', '.'),
      (err) => err.code === 'config_invalid' && /injectedFields was removed/.test(err.message),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const ok = setupRepo(BAD.replace("required = ['slug']", "required = ['slug', 'projectSlug']"));
  try {
    assert.doesNotThrow(() => sheetConfigCheck(ok.gitDir, 'HEAD', 'roles', '.gitsheets/roles.toml', '.'));
  } finally {
    rmSync(ok.dir, { recursive: true, force: true });
  }
});

test('sheetConfigCheck: a missing config is config_missing', () => {
  const { dir, gitDir } = setupRepo(BAD);
  try {
    assert.throws(
      () => sheetConfigCheck(gitDir, 'HEAD', 'nope', '.gitsheets/nope.toml', '.'),
      (err) => err instanceof ConfigError && err.code === 'config_missing',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
