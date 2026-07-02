// Incremental-write robustness: --dry-run / --delete-missing on bulk upsert,
// and --on-missing / --delete-missing / --dry-run on bulk patch. (#223 Medium.)

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { testRepo, type TestRepoHandle } from './test-repo.js';
import { runCli } from './run-cli.js';

const handles: TestRepoHandle[] = [];
afterEach(async () => {
  while (handles.length > 0) {
    const h = handles.pop();
    if (h) await h.cleanup();
  }
});

const USERS_TOML = `[gitsheet]
root = 'users'
path = '\${{ slug }}'

[gitsheet.schema]
type = 'object'
required = ['slug', 'email']

[gitsheet.schema.properties.slug]
type = 'string'
[gitsheet.schema.properties.email]
type = 'string'
[gitsheet.schema.properties.role]
type = 'string'
`;

const SEED = JSON.stringify([
  { slug: 'jane', email: 'jane@x.org' },
  { slug: 'bob', email: 'bob@x.org' },
  { slug: 'mia', email: 'mia@x.org' },
]);

async function seeded(): Promise<TestRepoHandle> {
  const fixture = await testRepo({ withInitialCommit: true });
  handles.push(fixture);
  await mkdir(join(fixture.path, '.gitsheets'), { recursive: true });
  await writeFile(join(fixture.path, '.gitsheets', 'users.toml'), USERS_TOML);
  await fixture.git('add', '.gitsheets/');
  await fixture.git('commit', '-m', 'add users');
  await runCli(['upsert', 'users', '--data', SEED], fixture.path);
  return fixture;
}

async function commitCount(fixture: TestRepoHandle): Promise<number> {
  const { stdout } = await fixture.git('rev-list', '--count', 'HEAD');
  return parseInt(stdout.trim(), 10);
}

async function total(fixture: TestRepoHandle): Promise<string> {
  const { stdout } = await runCli(['count', 'users'], fixture.path);
  return stdout;
}

describe('upsert --dry-run', () => {
  it('previews will-change / no-op / invalid without committing', async () => {
    const fixture = await seeded();
    const before = await commitCount(fixture);
    const batch = JSON.stringify([
      { slug: 'jane', email: 'NEW@x.org' }, // changed
      { slug: 'bob', email: 'bob@x.org' }, // no-op
      { slug: 'zoe' }, // invalid (missing email)
    ]);
    const { stdout, exitCode } = await runCli(['upsert', 'users', '--data', batch, '--dry-run'], fixture.path);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('result: dry-run');
    expect(stdout).toMatch(/willChange: 1\b/);
    expect(stdout).toMatch(/noOp: 1\b/);
    expect(stdout).toMatch(/invalid: 1\b/);
    expect(stdout).toContain('zoe'); // named in the invalid table
    expect(await commitCount(fixture)).toBe(before); // nothing committed
  });
});

describe('upsert --delete-missing', () => {
  it('makes the sheet exactly match the input set', async () => {
    const fixture = await seeded();
    const subset = JSON.stringify([
      { slug: 'jane', email: 'jane@x.org' },
      { slug: 'bob', email: 'bob@x.org' },
    ]);
    const { stdout } = await runCli(['upsert', 'users', '--data', subset, '--delete-missing'], fixture.path);
    expect(stdout).toMatch(/deleted: 1\b/); // mia
    expect(await total(fixture)).toMatch(/count: 2\b/);
    const { exitCode } = await runCli(['read', 'users', 'mia'], fixture.path);
    expect(exitCode).not.toBe(0); // mia gone
  });
});

describe('patch --on-missing', () => {
  it('skip: patches the present rows, skips the missing ones (one commit)', async () => {
    const fixture = await seeded();
    const before = await commitCount(fixture);
    const batch = JSON.stringify([
      { slug: 'jane', role: 'lead' },
      { slug: 'ghost', role: 'x' }, // no such record
    ]);
    const { stdout, exitCode } = await runCli(['patch', 'users', '--data', batch, '--on-missing', 'skip'], fixture.path);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/patched: 1\b/);
    expect(stdout).toMatch(/skipped: 1\b/);
    expect(await commitCount(fixture)).toBe(before + 1);
    expect(await total(fixture)).toMatch(/count: 3\b/); // ghost not created
  });

  it('insert: upserts a missing record as new', async () => {
    const fixture = await seeded();
    const batch = JSON.stringify([{ slug: 'ghost', email: 'ghost@x.org', role: 'x' }]);
    const { stdout } = await runCli(['patch', 'users', '--data', batch, '--on-missing', 'insert'], fixture.path);
    expect(stdout).toMatch(/inserted: 1\b/);
    expect(await total(fixture)).toMatch(/count: 4\b/);
    const { stdout: ghost } = await runCli(['read', 'users', 'ghost'], fixture.path);
    expect(ghost).toContain('ghost@x.org');
  });

  it('abort (default) still aborts the whole batch, nothing committed', async () => {
    const fixture = await seeded();
    const before = await commitCount(fixture);
    const batch = JSON.stringify([
      { slug: 'jane', role: 'lead' },
      { slug: 'ghost', role: 'x' },
    ]);
    const { exitCode } = await runCli(['patch', 'users', '--data', batch], fixture.path);
    expect(exitCode).not.toBe(0);
    expect(await commitCount(fixture)).toBe(before);
  });
});

describe('patch --delete-missing', () => {
  it('deletes existing records not targeted by the batch', async () => {
    const fixture = await seeded();
    const batch = JSON.stringify([
      { slug: 'jane', role: 'a' },
      { slug: 'bob', role: 'b' },
    ]);
    const { stdout } = await runCli(['patch', 'users', '--data', batch, '--delete-missing'], fixture.path);
    expect(stdout).toMatch(/deleted: 1\b/); // mia untargeted
    expect(await total(fixture)).toMatch(/count: 2\b/);
  });
});

describe('patch --dry-run', () => {
  it('previews will-change / missing without committing', async () => {
    const fixture = await seeded();
    const before = await commitCount(fixture);
    const batch = JSON.stringify([
      { slug: 'jane', role: 'lead' },
      { slug: 'ghost', role: 'x' },
    ]);
    const { stdout, exitCode } = await runCli(
      ['patch', 'users', '--data', batch, '--on-missing', 'skip', '--dry-run'],
      fixture.path,
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain('result: dry-run');
    expect(stdout).toMatch(/willChange: 1\b/);
    expect(stdout).toMatch(/missing: 1\b/);
    expect(await commitCount(fixture)).toBe(before);
  });
});
