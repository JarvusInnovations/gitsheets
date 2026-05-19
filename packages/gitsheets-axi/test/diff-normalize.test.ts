// AXI diff + normalize commands.

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

const USERS_TOML = `[gitsheet]
root = 'users'
path = '\${{ slug }}'

[gitsheet.schema]
type = 'object'
required = ['slug']

[gitsheet.schema.properties.slug]
type = 'string'

[gitsheet.schema.properties.email]
type = 'string'
`;

async function seedRepo({ withRecords = false }: { withRecords?: boolean } = {}): Promise<TestRepoHandle> {
  const fixture = await testRepo({ withInitialCommit: true });
  handles.push(fixture);
  await mkdir(join(fixture.path, '.gitsheets'), { recursive: true });
  await writeFile(join(fixture.path, '.gitsheets', 'users.toml'), USERS_TOML);
  await fixture.git('add', '.gitsheets/');
  await fixture.git('commit', '-m', 'add users');

  if (withRecords) {
    const repo = await openRepo({ gitDir: fixture.gitDir });
    await repo.transact({ message: 'seed' }, async (tx) => {
      await tx.sheet('users').upsert({ slug: 'jane', email: 'jane@x.org' });
      await tx.sheet('users').upsert({ slug: 'bob', email: 'bob@x.org' });
    });
  }
  return fixture;
}

async function commitCount(fixture: TestRepoHandle): Promise<number> {
  const { stdout } = await fixture.git('rev-list', '--count', 'HEAD');
  return parseInt(stdout.trim(), 10);
}

describe('diff', () => {
  it('lists current records as added when no src ref is given', async () => {
    const fixture = await seedRepo({ withRecords: true });
    const { stdout, exitCode } = await runCli(['diff', 'users'], fixture.path);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('count: 2 of 2 total');
    expect(stdout).toContain('src_ref: (empty tree)');
    expect(stdout).toMatch(/added,bob/);
    expect(stdout).toMatch(/added,jane/);
  });

  it('emits empty state with src_ref=HEAD', async () => {
    const fixture = await seedRepo({ withRecords: true });
    const { stdout, exitCode } = await runCli(
      ['diff', 'users', 'HEAD'],
      fixture.path,
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain('src_ref: HEAD');
    expect(stdout).toMatch(/changes: no changes|count: 0 of 0/);
  });

  it('--patches includes RFC 6902 patch ops per change', async () => {
    const fixture = await seedRepo({ withRecords: true });
    const { stdout, exitCode } = await runCli(
      ['diff', 'users', '--patches'],
      fixture.path,
    );
    expect(exitCode).toBe(0);
    // The header should now include a `patch` column.
    expect(stdout).toMatch(/changes\[2\]\{status,path,src_hash,dst_hash,patch\}/);
  });
});

describe('normalize', () => {
  it('no-op when every record is already canonical', async () => {
    const fixture = await seedRepo({ withRecords: true });
    const before = await commitCount(fixture);

    const { stdout, exitCode } = await runCli(
      ['normalize', 'users'],
      fixture.path,
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain('result: no-op');
    expect(stdout).toContain('already canonical');
    expect(await commitCount(fixture)).toBe(before);
  });

  it('no-op on an empty sheet', async () => {
    const fixture = await seedRepo();
    const before = await commitCount(fixture);

    const { stdout, exitCode } = await runCli(
      ['normalize', 'users'],
      fixture.path,
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain('result: no-op');
    expect(await commitCount(fixture)).toBe(before);
  });

  it('rewrites a non-canonical record (manual disk edit)', async () => {
    const fixture = await seedRepo();
    // Write a non-canonical record directly to disk + commit it. Library
    // upserts always canonicalize, so this is the only way to get a
    // non-canonical record into a tree.
    await mkdir(join(fixture.path, 'users'), { recursive: true });
    await writeFile(
      join(fixture.path, 'users', 'mia.toml'),
      `slug = "mia"\nemail = "mia@x.org"\n`, // keys out of order
      'utf-8',
    );
    await fixture.git('add', 'users/mia.toml');
    await fixture.git('commit', '-m', 'add mia (non-canonical)');
    const before = await commitCount(fixture);

    const { stdout, exitCode } = await runCli(
      ['normalize', 'users'],
      fixture.path,
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain('result: committed');
    expect(stdout).toContain('1 of 1 rewritten');
    expect(await commitCount(fixture)).toBe(before + 1);
  });
});
