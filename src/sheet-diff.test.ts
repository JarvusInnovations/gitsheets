// Sheet.diffFrom (#152) — diff records scoped to a sheet's root, between a
// prior commit and the current tree state.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { RefError } from './errors.js';
import { openRepo } from './repository.js';
import { testRepo, type TestRepoHandle } from './test-helpers/test-repo.js';

const handles: TestRepoHandle[] = [];
afterEach(async () => {
  while (handles.length > 0) {
    const h = handles.pop();
    if (h) await h.cleanup();
  }
});

const USERS_CONFIG = `[gitsheet]
root = 'users'
path = '\${{ slug }}'
`;

async function seedRepo(): Promise<TestRepoHandle> {
  const fixture = await testRepo({ withInitialCommit: true });
  handles.push(fixture);
  await mkdir(join(fixture.path, '.gitsheets'), { recursive: true });
  await writeFile(join(fixture.path, '.gitsheets', 'users.toml'), USERS_CONFIG);
  await fixture.git('add', '.gitsheets/');
  await fixture.git('commit', '-m', 'add users sheet');
  return fixture;
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of it) out.push(v);
  return out;
}

describe('Sheet.diffFrom', () => {
  it('yields added entries when src defaults to the empty tree', async () => {
    const fixture = await seedRepo();
    const repo = await openRepo({ gitDir: fixture.gitDir });
    await repo.transact({ message: 'seed' }, async (tx) => {
      await tx.sheet('users').upsert({ slug: 'jane' });
      await tx.sheet('users').upsert({ slug: 'pat' });
    });

    const users = await repo.openSheet('users');
    const changes = await collect(users.diffFrom());
    const byPath = new Map(changes.map((c) => [c.path, c]));
    expect(byPath.size).toBe(2);
    expect(byPath.get('jane')?.status).toBe('added');
    expect(byPath.get('pat')?.status).toBe('added');
    expect(byPath.get('jane')?.srcHash).toBeNull();
    expect(byPath.get('jane')?.dstHash).toMatch(/^[0-9a-f]{40}$/);
  });

  it('reports modified records between two commits', async () => {
    const fixture = await seedRepo();
    const repo = await openRepo({ gitDir: fixture.gitDir });
    const first = await repo.transact({ message: 'seed' }, async (tx) => {
      await tx.sheet('users').upsert({ slug: 'jane', email: 'jane@x' });
    });
    await repo.transact({ message: 'edit' }, async (tx) => {
      await tx.sheet('users').upsert({ slug: 'jane', email: 'jane@y' });
    });

    const users = await repo.openSheet('users');
    const changes = await collect(users.diffFrom(first.commitHash));
    expect(changes.length).toBe(1);
    expect(changes[0]?.path).toBe('jane');
    expect(changes[0]?.status).toBe('modified');
    expect(changes[0]?.srcHash).toMatch(/^[0-9a-f]{40}$/);
    expect(changes[0]?.dstHash).toMatch(/^[0-9a-f]{40}$/);
    expect(changes[0]?.srcHash).not.toBe(changes[0]?.dstHash);
  });

  it('reports deleted records', async () => {
    const fixture = await seedRepo();
    const repo = await openRepo({ gitDir: fixture.gitDir });
    const first = await repo.transact({ message: 'seed' }, async (tx) => {
      await tx.sheet('users').upsert({ slug: 'jane' });
      await tx.sheet('users').upsert({ slug: 'pat' });
    });
    await repo.transact({ message: 'remove pat' }, async (tx) => {
      await tx.sheet('users').delete({ slug: 'pat' });
    });

    const users = await repo.openSheet('users');
    const changes = await collect(users.diffFrom(first.commitHash));
    expect(changes.length).toBe(1);
    expect(changes[0]?.path).toBe('pat');
    expect(changes[0]?.status).toBe('deleted');
    expect(changes[0]?.dstHash).toBeNull();
  });

  it('opts.records returns parsed records with Date intact', async () => {
    const fixture = await seedRepo();
    const repo = await openRepo({ gitDir: fixture.gitDir });

    const SHEET_WITH_DATE = `[gitsheet]
root = 'events'
path = '\${{ id }}'
`;
    await writeFile(join(fixture.path, '.gitsheets', 'events.toml'), SHEET_WITH_DATE);
    await fixture.git('add', '.gitsheets/events.toml');
    await fixture.git('commit', '-m', 'events sheet');

    const first = await repo.transact({ message: 'seed event' }, async (tx) => {
      await tx.sheet('events').upsert({
        id: 'e1',
        title: 'Launch',
        scheduledFor: new Date('2026-05-16T14:00:00Z'),
      });
    });
    await repo.transact({ message: 'update event' }, async (tx) => {
      await tx.sheet('events').upsert({
        id: 'e1',
        title: 'Launch v2',
        scheduledFor: new Date('2026-05-17T14:00:00Z'),
      });
    });

    const events = await repo.openSheet('events');
    const changes = await collect(events.diffFrom(first.commitHash, { records: true }));
    expect(changes.length).toBe(1);
    const change = changes[0]!;
    expect(change.src).toBeDefined();
    expect(change.dst).toBeDefined();
    // @iarna/toml round-trips dates as Date subclasses
    expect((change.src as Record<string, unknown>)['scheduledFor']).toBeInstanceOf(Date);
    expect((change.dst as Record<string, unknown>)['scheduledFor']).toBeInstanceOf(Date);
    expect(((change.src as Record<string, unknown>)['scheduledFor'] as Date).getUTCDate()).toBe(16);
    expect(((change.dst as Record<string, unknown>)['scheduledFor'] as Date).getUTCDate()).toBe(17);
  });

  it('opts.patches produces a valid RFC 6902 patch', async () => {
    const fixture = await seedRepo();
    const repo = await openRepo({ gitDir: fixture.gitDir });
    const first = await repo.transact({ message: 'seed' }, async (tx) => {
      await tx.sheet('users').upsert({ slug: 'jane', email: 'jane@x', age: 30 });
    });
    await repo.transact({ message: 'edit' }, async (tx) => {
      await tx.sheet('users').upsert({ slug: 'jane', email: 'jane@y', age: 31 });
    });

    const users = await repo.openSheet('users');
    const changes = await collect(users.diffFrom(first.commitHash, { patches: true }));
    expect(changes.length).toBe(1);
    const patch = changes[0]?.patch;
    expect(Array.isArray(patch)).toBe(true);
    expect(patch!.length).toBeGreaterThan(0);
    // Should contain replace ops for the changed fields
    const replacePaths = patch!
      .filter((op) => op.op === 'replace')
      .map((op) => op.path);
    expect(replacePaths).toContain('/email');
    expect(replacePaths).toContain('/age');
  });

  it('opts.blobs returns BlobObject handles for non-null hashes', async () => {
    const fixture = await seedRepo();
    const repo = await openRepo({ gitDir: fixture.gitDir });
    await repo.transact({ message: 'seed' }, async (tx) => {
      await tx.sheet('users').upsert({ slug: 'jane' });
    });

    const users = await repo.openSheet('users');
    const changes = await collect(users.diffFrom(undefined, { blobs: true }));
    expect(changes.length).toBe(1);
    const change = changes[0]!;
    expect(change.srcBlob).toBeUndefined(); // added → no src
    expect(change.dstBlob).toBeDefined();
    expect((change.dstBlob as { isBlob?: boolean }).isBlob).toBe(true);
  });

  it('throws RefError for an unknown src ref', async () => {
    const fixture = await seedRepo();
    const repo = await openRepo({ gitDir: fixture.gitDir });
    await repo.transact({ message: 'seed' }, async (tx) => {
      await tx.sheet('users').upsert({ slug: 'jane' });
    });

    const users = await repo.openSheet('users');
    await expect(collect(users.diffFrom('refs/heads/never-existed'))).rejects.toBeInstanceOf(
      RefError,
    );
  });

  it('returns an empty stream when src equals dst', async () => {
    const fixture = await seedRepo();
    const repo = await openRepo({ gitDir: fixture.gitDir });
    const result = await repo.transact({ message: 'seed' }, async (tx) => {
      await tx.sheet('users').upsert({ slug: 'jane' });
    });

    const users = await repo.openSheet('users');
    const changes = await collect(users.diffFrom(result.commitHash));
    expect(changes.length).toBe(0);
  });
});
