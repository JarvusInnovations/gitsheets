// AXI attachment command (list / get / set / delete).

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
`;

async function seedRepo({ withAttachments = false }: { withAttachments?: boolean } = {}): Promise<TestRepoHandle> {
  const fixture = await testRepo({ withInitialCommit: true });
  handles.push(fixture);
  await mkdir(join(fixture.path, '.gitsheets'), { recursive: true });
  await writeFile(join(fixture.path, '.gitsheets', 'users.toml'), USERS_TOML);
  await fixture.git('add', '.gitsheets/');
  await fixture.git('commit', '-m', 'add users');

  const repo = await openRepo({ gitDir: fixture.gitDir });
  await repo.transact({ message: 'seed jane' }, async (tx) => {
    await tx.sheet('users').upsert({ slug: 'jane' });
    if (withAttachments) {
      await tx.sheet('users').setAttachment({ slug: 'jane' }, 'avatar.png', 'PNGBYTES');
      await tx.sheet('users').setAttachment({ slug: 'jane' }, 'cover.jpg', 'JPGBYTES');
    }
  });
  return fixture;
}

async function commitCount(fixture: TestRepoHandle): Promise<number> {
  const { stdout } = await fixture.git('rev-list', '--count', 'HEAD');
  return parseInt(stdout.trim(), 10);
}

describe('attachment list', () => {
  it('shows attachments on a record', async () => {
    const fixture = await seedRepo({ withAttachments: true });
    const { stdout, exitCode } = await runCli(
      ['attachment', 'list', 'users', 'jane'],
      fixture.path,
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain('attachments[2]');
    expect(stdout).toContain('avatar.png');
    expect(stdout).toContain('cover.jpg');
  });

  it('emits empty state when no attachments exist', async () => {
    const fixture = await seedRepo();
    const { stdout, exitCode } = await runCli(
      ['attachment', 'list', 'users', 'jane'],
      fixture.path,
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain('no attachments');
  });
});

describe('attachment get', () => {
  it('returns base64-encoded content + metadata', async () => {
    const fixture = await seedRepo({ withAttachments: true });
    const { stdout, exitCode } = await runCli(
      ['attachment', 'get', 'users', 'jane', 'avatar.png'],
      fixture.path,
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain('attachment:');
    expect(stdout).toContain('name: avatar.png');
    expect(stdout).toContain('size: 8');
    expect(stdout).toContain('base64:');
    // base64 of "PNGBYTES"
    expect(stdout).toContain('UE5HQllURVM=');
  });

  it('errors when attachment is missing', async () => {
    const fixture = await seedRepo({ withAttachments: true });
    const { stdout, exitCode } = await runCli(
      ['attachment', 'get', 'users', 'jane', 'nope.png'],
      fixture.path,
    );
    expect(exitCode).not.toBe(0);
    expect(stdout).toContain('NOT_FOUND');
  });
});

describe('attachment set', () => {
  it('creates a new attachment via --data', async () => {
    const fixture = await seedRepo();
    const before = await commitCount(fixture);

    const { stdout, exitCode } = await runCli(
      [
        'attachment',
        'set',
        'users',
        'jane',
        'note.txt',
        '--data',
        'hello',
      ],
      fixture.path,
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain('result: created');
    expect(stdout).toContain('name: note.txt');
    expect(await commitCount(fixture)).toBe(before + 1);
  });

  it('idempotent — no-op when bytes match', async () => {
    const fixture = await seedRepo({ withAttachments: true });
    const before = await commitCount(fixture);

    const { stdout, exitCode } = await runCli(
      ['attachment', 'set', 'users', 'jane', 'avatar.png', '--data', 'PNGBYTES'],
      fixture.path,
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain('result: no-op');
    expect(await commitCount(fixture)).toBe(before);
  });

  it('overwrites existing attachment when bytes differ', async () => {
    const fixture = await seedRepo({ withAttachments: true });
    const before = await commitCount(fixture);

    const { stdout, exitCode } = await runCli(
      ['attachment', 'set', 'users', 'jane', 'avatar.png', '--data', 'NEW-BYTES'],
      fixture.path,
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain('result: overwritten');
    expect(await commitCount(fixture)).toBe(before + 1);
  });
});

describe('attachment delete', () => {
  it('deletes a single named attachment', async () => {
    const fixture = await seedRepo({ withAttachments: true });
    const before = await commitCount(fixture);

    const { stdout, exitCode } = await runCli(
      ['attachment', 'delete', 'users', 'jane', 'avatar.png'],
      fixture.path,
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain('result: committed');
    expect(await commitCount(fixture)).toBe(before + 1);
  });

  it('idempotent — no-op when attachment already absent', async () => {
    const fixture = await seedRepo();
    const before = await commitCount(fixture);

    const { stdout, exitCode } = await runCli(
      ['attachment', 'delete', 'users', 'jane', 'nope.png'],
      fixture.path,
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain('result: no-op');
    expect(await commitCount(fixture)).toBe(before);
  });

  it('deletes all attachments when no name is given', async () => {
    const fixture = await seedRepo({ withAttachments: true });
    const before = await commitCount(fixture);

    const { stdout, exitCode } = await runCli(
      ['attachment', 'delete', 'users', 'jane'],
      fixture.path,
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain('result: committed');
    expect(stdout).toContain('deleted: 2');
    expect(await commitCount(fixture)).toBe(before + 1);
  });
});
