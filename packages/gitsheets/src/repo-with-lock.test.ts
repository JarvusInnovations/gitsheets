// repo.withLock — the exposed write lock. See specs/api/repository.md#repowithlockfn
// and specs/behaviors/transactions.md (single-writer model).

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { TransactionError } from './errors.js';
import { openRepo, type Repository } from './repository.js';
import { testRepo, type TestRepoHandle } from './test-helpers/test-repo.js';

const handles: TestRepoHandle[] = [];
afterEach(async () => {
  while (handles.length > 0) {
    const h = handles.pop();
    if (h) await h.cleanup();
  }
});

const USERS = `[gitsheet]
root = 'users'
path = '\${{ slug }}'
`;

async function seededRepo(): Promise<Repository> {
  const fixture = await testRepo({ withInitialCommit: true });
  handles.push(fixture);
  await mkdir(join(fixture.path, '.gitsheets'), { recursive: true });
  await writeFile(join(fixture.path, '.gitsheets', 'users.toml'), USERS);
  await fixture.git('add', '.gitsheets/');
  await fixture.git('commit', '-m', 'add users sheet');
  return openRepo({ gitDir: fixture.gitDir });
}

describe('repo.withLock', () => {
  it('returns the callback value (sync and async callbacks)', async () => {
    const repo = await seededRepo();
    expect(await repo.withLock(() => 42)).toBe(42);
    expect(await repo.withLock(async () => 'async')).toBe('async');
  });

  it('releases on throw and propagates the error', async () => {
    const repo = await seededRepo();
    await expect(
      repo.withLock(() => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    // Lock must be free again — a transaction goes through.
    const result = await repo.transact({ message: 'after-throw' }, async (tx) => {
      await tx.sheet('users').upsert({ slug: 'ok' });
    });
    expect(result.commitHash).not.toBeNull();
  });

  it('serializes against repo.transact — a transaction started during withLock commits after it', async () => {
    const repo = await seededRepo();
    const order: string[] = [];

    let releaseHold!: () => void;
    const hold = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });

    const locked = repo.withLock(async () => {
      order.push('lock-start');
      await hold; // keep the lock while the transact queues
      order.push('lock-end');
    });

    // Give withLock a tick to acquire before contending.
    await new Promise((r) => setImmediate(r));

    const txDone = repo
      .transact({ message: 'queued behind lock' }, async (tx) => {
        order.push('tx-run');
        await tx.sheet('users').upsert({ slug: 'queued' });
      })
      .then(() => order.push('tx-done'));

    // The transaction must not run while the lock is held.
    await new Promise((r) => setTimeout(r, 50));
    expect(order).toEqual(['lock-start']);

    releaseHold();
    await Promise.all([locked, txDone]);
    expect(order).toEqual(['lock-start', 'lock-end', 'tx-run', 'tx-done']);
  });

  it('queues behind an in-flight transaction from another async context', async () => {
    const repo = await seededRepo();
    const order: string[] = [];

    let releaseTx!: () => void;
    const holdTx = new Promise<void>((resolve) => {
      releaseTx = resolve;
    });

    const txDone = repo.transact({ message: 'holding' }, async (tx) => {
      order.push('tx-start');
      await holdTx;
      await tx.sheet('users').upsert({ slug: 'first' });
    });

    // transact does async option/author resolution before acquiring the
    // mutex — wait until the handler has provably started (lock held).
    while (!order.includes('tx-start')) {
      await new Promise((r) => setTimeout(r, 5));
    }

    const locked = repo
      .withLock(() => {
        order.push('lock-run');
      })
      .then(() => order.push('lock-done'));

    await new Promise((r) => setTimeout(r, 50));
    expect(order).toEqual(['tx-start']);

    releaseTx();
    await Promise.all([txDone, locked]);
    expect(order[0]).toBe('tx-start');
    expect(order).toContain('lock-run');
    expect(order.indexOf('lock-run')).toBeGreaterThan(order.indexOf('tx-start'));
  });
});

describe('withLock non-reentrancy guards (lock_held)', () => {
  async function expectLockHeld(p: Promise<unknown>): Promise<void> {
    const err = await p.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransactionError);
    expect((err as TransactionError).code).toBe('lock_held');
  }

  it('withLock inside withLock throws immediately', async () => {
    const repo = await seededRepo();
    await repo.withLock(async () => {
      await expectLockHeld(repo.withLock(() => 'inner'));
    });
  });

  it('repo.transact inside withLock throws immediately', async () => {
    const repo = await seededRepo();
    await repo.withLock(async () => {
      await expectLockHeld(repo.transact({ message: 'nested' }, async () => undefined));
    });
  });

  it('a permissive-mode mutation inside withLock throws immediately (auto-transaction)', async () => {
    const repo = await seededRepo();
    const users = await repo.openSheet('users');
    await repo.withLock(async () => {
      await expectLockHeld(users.upsert({ slug: 'nope' }));
    });
  });

  it('withLock inside a transaction handler throws immediately', async () => {
    const repo = await seededRepo();
    await repo.transact({ message: 'outer' }, async (tx) => {
      await expectLockHeld(repo.withLock(() => 'inner'));
      await tx.sheet('users').upsert({ slug: 'still-commits' });
    });
  });

  it('two independent Repository instances do not trip each other\'s guard', async () => {
    const repo = await seededRepo();
    const other = await openRepo({ gitDir: repo.gitDir });
    // Locks are per-instance (documented): other's withLock inside repo's
    // withLock is allowed — they don't share a mutex.
    const result = await repo.withLock(() => other.withLock(() => 'ok'));
    expect(result).toBe('ok');
  });
});
