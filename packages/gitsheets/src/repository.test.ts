import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ConfigError, RefError, TransactionError } from './errors.js';
import { openRepo, Repository } from './repository.js';
import { RECORD_PATH_KEY, RECORD_SHEET_KEY } from './sheet.js';
import { testRepo, type TestRepoHandle } from './test-helpers/test-repo.js';

const handles: TestRepoHandle[] = [];
afterEach(async () => {
  while (handles.length > 0) {
    const h = handles.pop();
    if (h) await h.cleanup();
  }
});

async function makeRepo(opts?: Parameters<typeof testRepo>[0]): Promise<TestRepoHandle> {
  const h = await testRepo(opts);
  handles.push(h);
  return h;
}

async function writeSheetConfig(
  fixture: TestRepoHandle,
  name: string,
  configToml: string,
): Promise<void> {
  await mkdir(join(fixture.path, '.gitsheets'), { recursive: true });
  await writeFile(join(fixture.path, '.gitsheets', `${name}.toml`), configToml);
}

async function seedConfig(fixture: TestRepoHandle, name: string, configToml: string): Promise<void> {
  await writeSheetConfig(fixture, name, configToml);
  await fixture.git('add', `.gitsheets/${name}.toml`);
  await fixture.git('commit', '-m', `chore: add ${name} sheet`);
}

const USERS_CONFIG = `[gitsheet]
root = 'users'
path = '\${{ slug }}'
`;

const USERS_BY_DOMAIN_CONFIG = `[gitsheet]
root = 'people'
path = '\${{ domain }}/\${{ username }}'
`;

describe('openRepo', () => {
  it('opens a repo by gitDir', async () => {
    const fixture = await makeRepo({ withInitialCommit: true });
    const repo = await openRepo({ gitDir: fixture.gitDir });
    expect(repo).toBeInstanceOf(Repository);
    expect(repo.gitDir).toBe(fixture.gitDir);
  });
});

describe('Repository.resolveRef', () => {
  it('resolves HEAD on a repo with commits', async () => {
    const fixture = await makeRepo({ withInitialCommit: true });
    const repo = await openRepo({ gitDir: fixture.gitDir });
    const hash = await repo.resolveRef('HEAD');
    expect(hash).toMatch(/^[0-9a-f]{40}$/);
  });

  it('returns null for an unknown ref', async () => {
    const fixture = await makeRepo({ withInitialCommit: true });
    const repo = await openRepo({ gitDir: fixture.gitDir });
    const hash = await repo.resolveRef('refs/heads/never-existed');
    expect(hash).toBeNull();
  });
});

describe('Repository.openSheet', () => {
  it('throws ConfigError(config_missing) when .gitsheets/<name>.toml is absent', async () => {
    const fixture = await makeRepo({ withInitialCommit: true });
    const repo = await openRepo({ gitDir: fixture.gitDir });
    await expect(repo.openSheet('users')).rejects.toBeInstanceOf(ConfigError);
  });

  it('opens a sheet when its config is committed', async () => {
    const fixture = await makeRepo({ withInitialCommit: true });
    await seedConfig(fixture, 'users', USERS_CONFIG);
    const repo = await openRepo({ gitDir: fixture.gitDir });
    const users = await repo.openSheet('users');
    const config = await users.readConfig();
    expect(config.root).toBe('users');
    expect(config.path).toBe('${{ slug }}');
  });

  it('throws ConfigError(config_invalid) when [gitsheet] is malformed', async () => {
    const fixture = await makeRepo({ withInitialCommit: true });
    await seedConfig(fixture, 'broken', `[gitsheet]\n# missing path\n`);
    const repo = await openRepo({ gitDir: fixture.gitDir });
    await expect(repo.openSheet('broken')).rejects.toBeInstanceOf(ConfigError);
  });
});

describe('Repository.openSheets', () => {
  it('discovers all declared sheets', async () => {
    const fixture = await makeRepo({ withInitialCommit: true });
    await writeSheetConfig(fixture, 'users', USERS_CONFIG);
    await writeSheetConfig(fixture, 'projects', USERS_CONFIG);
    await fixture.git('add', '.gitsheets/');
    await fixture.git('commit', '-m', 'add sheets');

    const repo = await openRepo({ gitDir: fixture.gitDir });
    const sheets = await repo.openSheets();
    expect(Object.keys(sheets).sort()).toEqual(['projects', 'users']);
  });

  it('returns empty when .gitsheets/ is missing', async () => {
    const fixture = await makeRepo({ withInitialCommit: true });
    const repo = await openRepo({ gitDir: fixture.gitDir });
    const sheets = await repo.openSheets();
    expect(sheets).toEqual({});
  });
});

describe('Repository.transact (permissive default)', () => {
  it('commits when the handler mutates and resolves', async () => {
    const fixture = await makeRepo({ withInitialCommit: true });
    await seedConfig(fixture, 'users', USERS_CONFIG);
    const repo = await openRepo({ gitDir: fixture.gitDir });

    const result = await repo.transact(
      {
        message: 'add jane',
        author: { name: 'Test', email: 'test@gitsheets.local' },
      },
      async (tx) => {
        return tx.sheet('users').upsert({ slug: 'jane', email: 'jane@x.org' });
      },
    );

    expect(result.commitHash).toMatch(/^[0-9a-f]{40}$/);
    expect(result.value.path).toBe('jane');
    expect(result.parentCommitHash).toMatch(/^[0-9a-f]{40}$/);

    // HEAD should now point at the new commit
    const head = await repo.resolveRef('HEAD');
    expect(head).toBe(result.commitHash);
  });

  it('does not commit when the handler is a no-op', async () => {
    const fixture = await makeRepo({ withInitialCommit: true });
    await seedConfig(fixture, 'users', USERS_CONFIG);
    const repo = await openRepo({ gitDir: fixture.gitDir });

    const headBefore = await repo.resolveRef('HEAD');
    const result = await repo.transact({ message: 'noop' }, async () => 42);

    expect(result.value).toBe(42);
    expect(result.commitHash).toBeNull();
    const headAfter = await repo.resolveRef('HEAD');
    expect(headAfter).toBe(headBefore);
  });

  it('discards the tree when the handler throws', async () => {
    const fixture = await makeRepo({ withInitialCommit: true });
    await seedConfig(fixture, 'users', USERS_CONFIG);
    const repo = await openRepo({ gitDir: fixture.gitDir });

    const headBefore = await repo.resolveRef('HEAD');
    await expect(
      repo.transact({ message: 'will fail' }, async (tx) => {
        await tx.sheet('users').upsert({ slug: 'doomed', email: 'd@x.org' });
        throw new Error('handler died');
      }),
    ).rejects.toThrow('handler died');

    const headAfter = await repo.resolveRef('HEAD');
    expect(headAfter).toBe(headBefore);
  });

  it('formats trailers in the commit message', async () => {
    const fixture = await makeRepo({ withInitialCommit: true });
    await seedConfig(fixture, 'users', USERS_CONFIG);
    const repo = await openRepo({ gitDir: fixture.gitDir });

    const result = await repo.transact(
      {
        message: 'janedoe: POST /api/users',
        author: { name: 'Jane', email: 'jane@x.org' },
        trailers: {
          Action: 'user.create',
          'Subject-Slug': 'janedoe',
        },
      },
      async (tx) => tx.sheet('users').upsert({ slug: 'janedoe', email: 'jane@x.org' }),
    );

    const { stdout: messageLog } = await fixture.git('log', '-1', '--format=%B');
    expect(messageLog).toContain('janedoe: POST /api/users');
    expect(messageLog).toContain('Action: user.create');
    expect(messageLog).toContain('Subject-Slug: janedoe');
    expect(result.commitHash).toMatch(/^[0-9a-f]{40}$/);
  });

  it('rejects malformed trailer keys', async () => {
    const fixture = await makeRepo({ withInitialCommit: true });
    await seedConfig(fixture, 'users', USERS_CONFIG);
    const repo = await openRepo({ gitDir: fixture.gitDir });

    await expect(
      repo.transact(
        {
          message: 'x',
          trailers: { 'not http header': 'value' },
        },
        async () => 0,
      ),
    ).rejects.toBeInstanceOf(TransactionError);
  });

  it('throws RefError when opts.parent is a missing ref name', async () => {
    const fixture = await makeRepo({ withInitialCommit: true });
    await seedConfig(fixture, 'users', USERS_CONFIG);
    const repo = await openRepo({ gitDir: fixture.gitDir });

    await expect(
      repo.transact({ message: 'x', parent: 'nope' }, async () => 0),
    ).rejects.toBeInstanceOf(RefError);
  });

  it('throws TransactionError on nested repo.transact', async () => {
    const fixture = await makeRepo({ withInitialCommit: true });
    await seedConfig(fixture, 'users', USERS_CONFIG);
    const repo = await openRepo({ gitDir: fixture.gitDir });

    await expect(
      repo.transact({ message: 'outer' }, async () => {
        return repo.transact({ message: 'inner' }, async () => 0);
      }),
    ).rejects.toBeInstanceOf(TransactionError);
  });

  it('queues sequential transactions from independent contexts', async () => {
    const fixture = await makeRepo({ withInitialCommit: true });
    await seedConfig(fixture, 'users', USERS_CONFIG);
    const repo = await openRepo({ gitDir: fixture.gitDir });

    const a = repo.transact({ message: 'first' }, async (tx) =>
      tx.sheet('users').upsert({ slug: 'first', n: 1 }),
    );
    const b = repo.transact({ message: 'second' }, async (tx) =>
      tx.sheet('users').upsert({ slug: 'second', n: 2 }),
    );
    const [ra, rb] = await Promise.all([a, b]);

    // Both committed successfully and produced distinct commits.
    expect(ra.commitHash).not.toBe(rb.commitHash);

    // The mutex serialized them, but the *order* depends on which transact
    // call reaches mutex.acquire() first (after its resolveAuthor `git config`
    // await). That's racy on a loaded CI runner. The invariant we care about
    // is "one ran after the other" — exactly one of them sees the other's
    // commit as its parent.
    const aParentIsB = ra.parentCommitHash === rb.commitHash;
    const bParentIsA = rb.parentCommitHash === ra.commitHash;
    expect(aParentIsB || bParentIsA).toBe(true);
    expect(aParentIsB && bParentIsA).toBe(false);
  });
});

describe('Repository.requireExplicitTransactions (strict mode)', () => {
  it('throws transaction_required on standalone Sheet.upsert', async () => {
    const fixture = await makeRepo({ withInitialCommit: true });
    await seedConfig(fixture, 'users', USERS_CONFIG);
    const repo = await openRepo({ gitDir: fixture.gitDir });
    repo.requireExplicitTransactions();

    const users = await repo.openSheet('users');
    await expect(users.upsert({ slug: 'x', email: 'x@y' })).rejects.toBeInstanceOf(
      TransactionError,
    );
  });

  it('allows writes through tx.sheet inside repo.transact', async () => {
    const fixture = await makeRepo({ withInitialCommit: true });
    await seedConfig(fixture, 'users', USERS_CONFIG);
    const repo = await openRepo({ gitDir: fixture.gitDir });
    repo.requireExplicitTransactions();

    const result = await repo.transact(
      { message: 'strict ok' },
      async (tx) => tx.sheet('users').upsert({ slug: 'allowed', n: 1 }),
    );
    expect(result.commitHash).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('round-trip: upsert + query', () => {
  it('reads back what was written', async () => {
    const fixture = await makeRepo({ withInitialCommit: true });
    await seedConfig(fixture, 'users', USERS_CONFIG);
    const repo = await openRepo({ gitDir: fixture.gitDir });

    await repo.transact({ message: 'seed' }, async (tx) => {
      await tx.sheet('users').upsert({ slug: 'alice', email: 'a@x' });
      await tx.sheet('users').upsert({ slug: 'bob', email: 'b@x' });
    });

    const users = await repo.openSheet('users');
    const all = await users.queryAll();
    const slugs = all.map((r) => r['slug']).sort();
    expect(slugs).toEqual(['alice', 'bob']);
    const alice = await users.queryFirst({ slug: 'alice' });
    expect(alice).toBeDefined();
    expect(alice?.['email']).toBe('a@x');
    expect((alice as Record<symbol, unknown>)[RECORD_SHEET_KEY]).toBe('users');
    expect((alice as Record<symbol, unknown>)[RECORD_PATH_KEY]).toBe('alice');
  });

  it('prunes composite-key queries to a single subtree', async () => {
    const fixture = await makeRepo({ withInitialCommit: true });
    await seedConfig(fixture, 'users', USERS_BY_DOMAIN_CONFIG);
    const repo = await openRepo({ gitDir: fixture.gitDir });

    await repo.transact({ message: 'seed' }, async (tx) => {
      const s = tx.sheet('users');
      await s.upsert({ domain: 'af.mil', username: 'grandma', n: 1 });
      await s.upsert({ domain: 'af.mil', username: 'cobol', n: 2 });
      await s.upsert({ domain: 'navy.mil', username: 'sailor', n: 3 });
    });

    const users = await repo.openSheet('users');
    const afmil = await users.queryAll({ domain: 'af.mil' });
    expect(afmil.length).toBe(2);
    const all = await users.queryAll();
    expect(all.length).toBe(3);
  });
});

describe('Sheet.delete', () => {
  it('removes a record', async () => {
    const fixture = await makeRepo({ withInitialCommit: true });
    await seedConfig(fixture, 'users', USERS_CONFIG);
    const repo = await openRepo({ gitDir: fixture.gitDir });

    await repo.transact({ message: 'seed' }, async (tx) => {
      await tx.sheet('users').upsert({ slug: 'alice', email: 'a@x' });
      await tx.sheet('users').upsert({ slug: 'bob', email: 'b@x' });
    });

    await repo.transact({ message: 'delete alice' }, async (tx) => {
      await tx.sheet('users').delete({ slug: 'alice' });
    });

    const users = await repo.openSheet('users');
    const all = await users.queryAll();
    expect(all.length).toBe(1);
    expect(all[0]?.['slug']).toBe('bob');
  });
});

// specs/api/transaction.md "Raw files" + "Parent ref handling" (#305).
describe('tx.writeFile / tx.deleteFile', () => {
  it('stages text and bytes beside record changes in one commit; deleteFile reports existence', async () => {
    const fixture = await makeRepo({ withInitialCommit: true });
    await seedConfig(fixture, 'users', USERS_CONFIG);
    const repo = await openRepo({ gitDir: fixture.gitDir });

    const result = await repo.transact({ message: 'files + record' }, async (tx) => {
      const text = tx.writeFile('fixtures/readme.md', 'hello\n');
      const bytes = tx.writeFile('fixtures/blob.bin', Buffer.from([0, 1, 2]));
      expect(text.hash).toMatch(/^[0-9a-f]{40}$/);
      expect((await bytes.read())).toEqual(Buffer.from([0, 1, 2]));
      expect(tx.deleteFile('fixtures/not-there.txt')).toBe(false);
      await tx.sheet('users').upsert({ slug: 'jane', email: 'jane@x.org' });
    });
    const { stdout } = await fixture.git('ls-tree', '-r', '--name-only', result.commitHash!);
    expect(stdout.split('\n')).toEqual(expect.arrayContaining(['fixtures/readme.md', 'fixtures/blob.bin', 'users/jane.toml']));
    const { stdout: readme } = await fixture.git('show', `${result.commitHash}:fixtures/readme.md`);
    expect(readme).toBe('hello\n');

    const rm = await repo.transact({ message: 'rm' }, async (tx) => {
      expect(tx.deleteFile('fixtures/blob.bin')).toBe(true);
    });
    const { stdout: after } = await fixture.git('ls-tree', '-r', '--name-only', rm.commitHash!);
    expect(after).not.toContain('fixtures/blob.bin');

    // A miss alone is a no-op transaction.
    const noop = await repo.transact({ message: 'noop' }, async (tx) => {
      tx.deleteFile('fixtures/gone.txt');
    });
    expect(noop.commitHash).toBeNull();
  });
});

describe('orphan commits and branch creation', () => {
  async function parentsOf(fixture: TestRepoHandle, commit: string): Promise<string[]> {
    const { stdout } = await fixture.git('rev-list', '--parents', '-n', '1', commit);
    return stdout.trim().split(/\s+/).slice(1);
  }

  it('parent: null starts from the empty tree, commits with no parents, and creates the branch', async () => {
    const fixture = await makeRepo({ withInitialCommit: true });
    await seedConfig(fixture, 'users', USERS_CONFIG);
    const repo = await openRepo({ gitDir: fixture.gitDir });

    const result = await repo.transact({ message: 'snapshot', parent: null, branch: 'snapshot' }, async (tx) => {
      expect(tx.parentCommitHash).toBeNull();
      tx.writeFile('README.md', 'scrubbed\n');
    });
    expect(result.parentCommitHash).toBeNull();
    expect(result.ref).toBe('refs/heads/snapshot');
    expect(await parentsOf(fixture, result.commitHash!)).toEqual([]);
    const { stdout } = await fixture.git('ls-tree', '-r', '--name-only', result.commitHash!);
    expect(stdout.trim().split('\n')).toEqual(['README.md']); // nothing inherited from main
    const { stdout: tip } = await fixture.git('rev-parse', 'refs/heads/snapshot');
    expect(tip.trim()).toBe(result.commitHash);

    // An orphan only creates: landing on an existing branch is refused at open.
    await expect(
      repo.transact({ message: 'again', parent: null, branch: 'snapshot' }, async () => 0),
    ).rejects.toMatchObject({ code: 'commit_failed' });

    // Without a branch: a detached root that always commits, even empty.
    const detached = await repo.transact({ message: 'empty root', parent: null }, async () => 0);
    expect(detached.commitHash).not.toBeNull();
    expect(detached.ref).toBeNull();
  });

  it('branch names a branch that does not exist yet → created from the parent, parent untouched', async () => {
    const fixture = await makeRepo({ withInitialCommit: true });
    await seedConfig(fixture, 'users', USERS_CONFIG);
    const repo = await openRepo({ gitDir: fixture.gitDir });
    const { stdout: mainBefore } = await fixture.git('rev-parse', 'refs/heads/main');

    const result = await repo.transact({ message: 'fork', parent: 'main', branch: 'review/batch-7' }, async (tx) => {
      await tx.sheet('users').upsert({ slug: 'fx', email: 'fx@x.org' });
    });
    expect(result.ref).toBe('refs/heads/review/batch-7');
    expect(await parentsOf(fixture, result.commitHash!)).toEqual([mainBefore.trim()]);
    const { stdout: mainAfter } = await fixture.git('rev-parse', 'refs/heads/main');
    expect(mainAfter).toBe(mainBefore);
  });
});

// specs/api/transaction.md "Read isolation" — config from the tx tree (#329).
describe('tx-bound sheets read config from the transaction tree', () => {
  it('an orphan transaction can stage a config and upsert records in the same commit', async () => {
    const fixture = await makeRepo({ withInitialCommit: true });
    const repo = await openRepo({ gitDir: fixture.gitDir });
    // HEAD has no `events` sheet at all.
    const result = await repo.transact({ message: 'snapshot', parent: null, branch: 'snapshot' }, async (tx) => {
      tx.writeFile('.gitsheets/events.toml', "[gitsheet]\nroot = 'events'\npath = '${{ slug }}'\n\n[gitsheet.schema]\ntype = 'object'\nrequired = ['slug']\n");
      await tx.sheet('events').upsert({ slug: 'launch', title: 'Launch' });
    });
    const { stdout } = await fixture.git('ls-tree', '-r', '--name-only', result.commitHash!);
    expect(stdout.trim().split('\n').sort()).toEqual(['.gitsheets/events.toml', 'events/launch.toml']);
  });

  it('a config changed earlier in a transaction governs that sheet\'s writes', async () => {
    const fixture = await makeRepo({ withInitialCommit: true });
    await seedConfig(fixture, 'users', USERS_CONFIG);
    const repo = await openRepo({ gitDir: fixture.gitDir });
    const strict = `${USERS_CONFIG}\n[gitsheet.schema]\ntype = 'object'\nrequired = ['slug', 'email']\n`;
    await expect(
      repo.transact({ message: 'tighten + write' }, async (tx) => {
        tx.writeFile('.gitsheets/users.toml', strict);
        await tx.sheet('users').upsert({ slug: 'jane' }); // no email → the staged schema rejects it
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });
});

// specs/api/repository.md — repo.tag / repo.listTree (#331).
describe('repo.tag and repo.listTree', () => {
  it('lists direct entries at a ref and sets / force-moves a lightweight tag', async () => {
    const fixture = await makeRepo({ withInitialCommit: true });
    await seedConfig(fixture, 'users', USERS_CONFIG);
    const repo = await openRepo({ gitDir: fixture.gitDir });
    const entries = await repo.listTree('HEAD', '.gitsheets');
    expect(entries).toEqual([expect.objectContaining({ name: 'users.toml', type: 'blob', mode: '100644' })]);
    expect(await repo.listTree('HEAD', 'nope')).toBeNull();
    await expect(repo.listTree('no-such-ref')).rejects.toBeInstanceOf(RefError);

    const head = (await fixture.git('rev-parse', 'HEAD')).stdout.trim();
    expect(await repo.tag('snap')).toBe(head);
    await expect(repo.tag('snap')).rejects.toMatchObject({ code: 'commit_failed' });
    await repo.transact({ message: 'more' }, async (tx) => {
      await tx.sheet('users').upsert({ slug: 'jane', email: 'jane@x.org' });
    });
    const next = (await fixture.git('rev-parse', 'HEAD')).stdout.trim();
    expect(await repo.tag('snap', 'HEAD', { force: true })).toBe(next);
    expect((await fixture.git('rev-parse', 'refs/tags/snap')).stdout.trim()).toBe(next);
  });
});
