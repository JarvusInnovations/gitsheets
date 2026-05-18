// AXI mutation commands: upsert, patch, delete — all idempotent.

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
required = ['slug', 'email']

[gitsheet.schema.properties.slug]
type = 'string'
pattern = '^[a-z0-9-]+$'

[gitsheet.schema.properties.email]
type = 'string'

[gitsheet.schema.properties.name]
type = 'string'
`;

async function seedRepo({ withRecords = false }: { withRecords?: boolean } = {}): Promise<TestRepoHandle> {
  const fixture = await testRepo({ withInitialCommit: true });
  handles.push(fixture);
  await mkdir(join(fixture.path, '.gitsheets'), { recursive: true });
  await writeFile(join(fixture.path, '.gitsheets', 'users.toml'), USERS_TOML);
  await fixture.git('add', '.gitsheets/');
  await fixture.git('commit', '-m', 'add sheets');

  if (withRecords) {
    const repo = await openRepo({ gitDir: fixture.gitDir });
    await repo.transact({ message: 'seed' }, async (tx) => {
      await tx.sheet('users').upsert({
        slug: 'jane',
        email: 'jane@x.org',
        name: 'Jane Doe',
      });
    });
  }
  return fixture;
}

async function commitCount(fixture: TestRepoHandle): Promise<number> {
  const { stdout } = await fixture.git('rev-list', '--count', 'HEAD');
  return parseInt(stdout.trim(), 10);
}

describe('upsert', () => {
  it('creates a new record and commits', async () => {
    const fixture = await seedRepo();
    const before = await commitCount(fixture);

    const { stdout, exitCode } = await runCli(
      [
        'upsert',
        'users',
        '--data',
        '{"slug":"jane","email":"jane@x.org"}',
      ],
      fixture.path,
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain('result: committed');
    expect(stdout).toContain('path: jane');
    expect(await commitCount(fixture)).toBe(before + 1);
  });

  it('is idempotent — no-op when bytes match', async () => {
    const fixture = await seedRepo({ withRecords: true });
    const before = await commitCount(fixture);

    const { stdout, exitCode } = await runCli(
      [
        'upsert',
        'users',
        '--data',
        '{"slug":"jane","email":"jane@x.org","name":"Jane Doe"}',
      ],
      fixture.path,
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain('result: no-op');
    expect(await commitCount(fixture)).toBe(before);
  });

  it('errors out when no record JSON is provided (no --data, no stdin)', async () => {
    // In-process test runner short-circuits stdin via GITSHEETS_AXI_NO_STDIN,
    // so this simulates the human-CLI shape of `gitsheets-axi upsert users`
    // with no input.
    const fixture = await seedRepo();
    const { stdout, exitCode } = await runCli(['upsert', 'users'], fixture.path);
    expect(exitCode).not.toBe(0);
    expect(stdout).toContain('error:');
    expect(stdout).toMatch(/needs a record/);
  });

  it('validation errors surface as VALIDATION_FAILED', async () => {
    const fixture = await seedRepo();
    const { stdout, exitCode } = await runCli(
      ['upsert', 'users', '--data', '{"slug":"INVALID UPPERCASE","email":"e@x.org"}'],
      fixture.path,
    );
    expect(exitCode).not.toBe(0);
    expect(stdout).toContain('error:');
    expect(stdout).toMatch(/VALIDATION/);
  });

  it('errors out on invalid JSON', async () => {
    const fixture = await seedRepo();
    const { stdout, exitCode } = await runCli(
      ['upsert', 'users', '--data', '{not json'],
      fixture.path,
    );
    expect(exitCode).not.toBe(0);
    expect(stdout).toContain('INVALID_JSON');
  });
});

describe('patch', () => {
  it('applies an RFC 7396 patch and commits', async () => {
    const fixture = await seedRepo({ withRecords: true });
    const before = await commitCount(fixture);

    const { stdout, exitCode } = await runCli(
      [
        'patch',
        'users',
        '{"slug":"jane"}',
        '--patch',
        '{"name":"Jane O. Doe"}',
      ],
      fixture.path,
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain('result: committed');
    expect(await commitCount(fixture)).toBe(before + 1);

    // Verify the merge happened — name changed, email preserved.
    const repo = await openRepo({ gitDir: fixture.gitDir });
    const updated = await (await repo.openSheet('users')).queryFirst({
      slug: 'jane',
    });
    expect((updated as Record<string, unknown>)['name']).toBe('Jane O. Doe');
    expect((updated as Record<string, unknown>)['email']).toBe('jane@x.org');
  });

  it('is idempotent — no-op when patch produces identical bytes', async () => {
    const fixture = await seedRepo({ withRecords: true });
    const before = await commitCount(fixture);

    const { stdout, exitCode } = await runCli(
      ['patch', 'users', '{"slug":"jane"}', '--patch', '{"name":"Jane Doe"}'],
      fixture.path,
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain('result: no-op');
    expect(await commitCount(fixture)).toBe(before);
  });

  it('errors when the query matches no record', async () => {
    const fixture = await seedRepo({ withRecords: true });
    const { stdout, exitCode } = await runCli(
      ['patch', 'users', '{"slug":"nobody"}', '--patch', '{"name":"X"}'],
      fixture.path,
    );
    expect(exitCode).not.toBe(0);
    expect(stdout).toContain('NOT_FOUND');
  });

  it('null deletes a field (RFC 7396)', async () => {
    const fixture = await seedRepo({ withRecords: true });
    const { stdout, exitCode } = await runCli(
      ['patch', 'users', '{"slug":"jane"}', '--patch', '{"name":null}'],
      fixture.path,
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain('result: committed');

    const repo = await openRepo({ gitDir: fixture.gitDir });
    const updated = await (await repo.openSheet('users')).queryFirst({
      slug: 'jane',
    });
    expect((updated as Record<string, unknown>)['name']).toBeUndefined();
  });
});

describe('delete', () => {
  it('removes an existing record and commits', async () => {
    const fixture = await seedRepo({ withRecords: true });
    const before = await commitCount(fixture);

    const { stdout, exitCode } = await runCli(
      ['delete', 'users', 'jane'],
      fixture.path,
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain('result: committed');
    expect(await commitCount(fixture)).toBe(before + 1);

    const repo = await openRepo({ gitDir: fixture.gitDir });
    const after = await (await repo.openSheet('users')).queryFirst({
      slug: 'jane',
    });
    expect(after).toBeUndefined();
  });

  it('is idempotent — no-op when the record is already absent', async () => {
    const fixture = await seedRepo();
    const before = await commitCount(fixture);

    const { stdout, exitCode } = await runCli(
      ['delete', 'users', 'nobody'],
      fixture.path,
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain('result: no-op');
    expect(await commitCount(fixture)).toBe(before);
  });

  it('errors out on missing args', async () => {
    const fixture = await seedRepo();
    const { stdout, exitCode } = await runCli(['delete', 'users'], fixture.path);
    expect(exitCode).not.toBe(0);
    expect(stdout).toContain('error:');
  });
});
