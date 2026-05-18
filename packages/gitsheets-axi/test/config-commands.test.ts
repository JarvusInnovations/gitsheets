// AXI config scaffolding: init, infer, migrate-config.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openRepo } from 'gitsheets';

import { testRepo, type TestRepoHandle } from './test-repo.js';
import { runCli } from './run-cli.js';

const handles: TestRepoHandle[] = [];
afterEach(async () => {
  while (handles.length > 0) {
    const h = handles.pop();
    if (h) await h.cleanup();
  }
});

async function emptyRepo(): Promise<TestRepoHandle> {
  const fixture = await testRepo({ withInitialCommit: true });
  handles.push(fixture);
  return fixture;
}

async function commitCount(fixture: TestRepoHandle): Promise<number> {
  const { stdout } = await fixture.git('rev-list', '--count', 'HEAD');
  return parseInt(stdout.trim(), 10);
}

describe('init', () => {
  it('creates a starter config and commits', async () => {
    const fixture = await emptyRepo();
    const before = await commitCount(fixture);

    const { stdout, exitCode } = await runCli(
      ['init', 'users', '--path', '${{ slug }}'],
      fixture.path,
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain('result: created');
    expect(stdout).toContain('config: .gitsheets/users.toml');
    expect(await commitCount(fixture)).toBe(before + 1);

    // Sheet should be openable.
    const repo = await openRepo({ gitDir: fixture.gitDir });
    const sheet = await repo.openSheet('users');
    const cfg = await sheet.readConfig();
    expect(cfg.path).toBe('${{ slug }}');
  });

  it('idempotent on re-run with the same args', async () => {
    const fixture = await emptyRepo();
    await runCli(['init', 'users', '--path', '${{ slug }}'], fixture.path);
    const before = await commitCount(fixture);

    const { stdout, exitCode } = await runCli(
      ['init', 'users', '--path', '${{ slug }}'],
      fixture.path,
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain('result: no-op');
    expect(await commitCount(fixture)).toBe(before);
  });

  it('refuses to overwrite without --force', async () => {
    const fixture = await emptyRepo();
    await runCli(['init', 'users', '--path', '${{ slug }}'], fixture.path);

    const { stdout, exitCode } = await runCli(
      ['init', 'users', '--path', '${{ id }}'], // different path
      fixture.path,
    );

    expect(exitCode).not.toBe(0);
    expect(stdout).toContain('CONFIG_EXISTS');
  });

  it('overwrites with --force', async () => {
    const fixture = await emptyRepo();
    await runCli(['init', 'users', '--path', '${{ slug }}'], fixture.path);

    const { stdout, exitCode } = await runCli(
      ['init', 'users', '--path', '${{ id }}', '--force'],
      fixture.path,
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain('result: overwritten');
  });
});

describe('infer', () => {
  it('infers schema from existing records', async () => {
    const fixture = await emptyRepo();
    await runCli(['init', 'users', '--path', '${{ slug }}'], fixture.path);
    // Seed via library so records exist.
    const repo = await openRepo({ gitDir: fixture.gitDir });
    await repo.transact({ message: 'seed' }, async (tx) => {
      await tx.sheet('users').upsert({
        slug: 'jane',
        email: 'jane@x.org',
        active: true,
      });
      await tx.sheet('users').upsert({
        slug: 'bob',
        email: 'bob@x.org',
        active: false,
      });
    });

    const { stdout, exitCode } = await runCli(['infer', 'users'], fixture.path);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('result: committed');
    expect(stdout).toMatch(/properties: 3/);
    expect(stdout).toMatch(/required: 3/);
    expect(stdout).toMatch(/records_observed: 2/);
  });

  it('errors when no records exist', async () => {
    const fixture = await emptyRepo();
    await runCli(['init', 'users', '--path', '${{ slug }}'], fixture.path);

    const { stdout, exitCode } = await runCli(['infer', 'users'], fixture.path);

    expect(exitCode).not.toBe(0);
    expect(stdout).toContain('NO_RECORDS');
  });

  it('idempotent when schema already matches', async () => {
    const fixture = await emptyRepo();
    await runCli(['init', 'users', '--path', '${{ slug }}'], fixture.path);
    const repo = await openRepo({ gitDir: fixture.gitDir });
    await repo.transact({ message: 'seed' }, async (tx) => {
      await tx.sheet('users').upsert({ slug: 'jane', email: 'jane@x.org' });
    });

    await runCli(['infer', 'users'], fixture.path);
    const before = await commitCount(fixture);

    const { stdout, exitCode } = await runCli(['infer', 'users'], fixture.path);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('result: no-op');
    expect(await commitCount(fixture)).toBe(before);
  });
});

describe('migrate-config', () => {
  it('migrates a pre-v1.0 [gitsheet.fields] block into [gitsheet.schema]', async () => {
    const fixture = await emptyRepo();
    // Hand-write a legacy config.
    await mkdir(join(fixture.path, '.gitsheets'), { recursive: true });
    await writeFile(
      join(fixture.path, '.gitsheets', 'legacy.toml'),
      `[gitsheet]
root = 'legacy'
path = '\${{ slug }}'

[gitsheet.fields.slug]
type = 'string'

[gitsheet.fields.score]
type = 'number'
default = 0
`,
      'utf-8',
    );
    await fixture.git('add', '.gitsheets/legacy.toml');
    await fixture.git('commit', '-m', 'legacy config');
    const before = await commitCount(fixture);

    const { stdout, exitCode } = await runCli(
      ['migrate-config', 'legacy'],
      fixture.path,
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain('result: committed');
    expect(stdout).toMatch(/properties_migrated: 2/);
    expect(await commitCount(fixture)).toBe(before + 1);

    // After migration the config should have [gitsheet.schema] and no
    // [gitsheet.fields].
    const repo = await openRepo({ gitDir: fixture.gitDir });
    const sheet = await repo.openSheet('legacy');
    const cfg = await sheet.readConfig();
    expect(cfg.schema).toBeDefined();
  });

  it('no-ops when no [gitsheet.fields] block exists', async () => {
    const fixture = await emptyRepo();
    await runCli(['init', 'users', '--path', '${{ slug }}'], fixture.path);
    const before = await commitCount(fixture);

    const { stdout, exitCode } = await runCli(
      ['migrate-config', 'users'],
      fixture.path,
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain('result: no-op');
    expect(stdout).toContain('no [gitsheet.fields] block');
    expect(await commitCount(fixture)).toBe(before);
  });
});
