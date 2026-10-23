// Default-branch binding (specs/behaviors/default-branch.md, #341): a
// Repository bound to a branch other than the one HEAD points at reads,
// commits, refreshes, syncs, pushes, and merges on that branch; HEAD and the
// working tree are never touched.

import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ConfigError, RefError, TransactionError } from './errors.js';
import { openRepo, type Repository } from './repository.js';
import { testRepo, type TestRepoHandle } from './test-helpers/test-repo.js';

const exec = promisify(execFile);

const USERS = `[gitsheet]
root = 'users'
path = '\${{ slug }}'
`;

const handles: TestRepoHandle[] = [];
const dirs: string[] = [];
let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env['GITSHEETS_BRANCH'];
  delete process.env['GITSHEETS_BRANCH'];
});

afterEach(async () => {
  if (savedEnv === undefined) delete process.env['GITSHEETS_BRANCH'];
  else process.env['GITSHEETS_BRANCH'] = savedEnv;
  while (handles.length > 0) await handles.pop()?.cleanup();
  while (dirs.length > 0) {
    const d = dirs.pop();
    if (d) await rm(d, { recursive: true, force: true });
  }
});

async function git(fixture: TestRepoHandle, ...args: string[]): Promise<string> {
  return (await fixture.git(...args)).stdout.trim();
}

/** Write `files` into a commit on `branch` (created as an orphan when absent) via plumbing — no checkout. */
async function commitFiles(
  fixture: TestRepoHandle,
  branch: string,
  files: Record<string, string>,
  message: string,
): Promise<string> {
  const tip = await fixture.git('rev-parse', '--verify', '--quiet', `refs/heads/${branch}`).then(
    (r) => r.stdout.trim(),
    () => '',
  );
  const env = { ...process.env, GIT_INDEX_FILE: join(fixture.gitDir, `tmp-index-${branch.replace(/\//g, '-')}`) };
  const run = async (args: string[], input?: string): Promise<string> => {
    const child = execFile('git', args, { cwd: fixture.path, env });
    if (input !== undefined) {
      child.stdin!.end(input);
    }
    return new Promise((resolve, reject) => {
      let out = '';
      child.stdout!.on('data', (c: Buffer) => (out += c.toString()));
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`git ${args.join(' ')} exited ${code}`))));
    });
  };
  if (tip) await run(['read-tree', tip]);
  else await run(['read-tree', '--empty']);
  for (const [path, content] of Object.entries(files)) {
    const blob = await run(['hash-object', '-w', '--stdin'], content);
    await run(['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`]);
  }
  const tree = await run(['write-tree']);
  const commit = await run(tip ? ['commit-tree', tree, '-p', tip, '-m', message] : ['commit-tree', tree, '-m', message]);
  await run(['update-ref', `refs/heads/${branch}`, commit]);
  await rm(env.GIT_INDEX_FILE, { force: true });
  return commit;
}

/** main has an initial empty commit (checked out); `data` is an orphan branch holding the users sheet + one record. */
async function dataBranchRepo(): Promise<TestRepoHandle> {
  const fixture = await testRepo({ withInitialCommit: true });
  handles.push(fixture);
  await commitFiles(
    fixture,
    'data',
    { '.gitsheets/users.toml': USERS, 'users/jane.toml': 'email = "jane@x.org"\nslug = "jane"\n' },
    'seed data',
  );
  return fixture;
}

describe('resolution', () => {
  it('defaults to the branch HEAD points at', async () => {
    const fixture = await testRepo({ withInitialCommit: true });
    handles.push(fixture);
    const repo = await openRepo({ gitDir: fixture.gitDir });
    expect(repo.branch).toBe('main');
  });

  it('reports HEAD’s unborn branch on a fresh repository', async () => {
    const fixture = await testRepo({ initialBranch: 'trunk' });
    handles.push(fixture);
    expect((await openRepo({ gitDir: fixture.gitDir })).branch).toBe('trunk');
  });

  it('is null on a detached HEAD with nothing configured', async () => {
    const fixture = await testRepo({ withInitialCommit: true });
    handles.push(fixture);
    await fixture.git('checkout', '-q', '--detach');
    expect((await openRepo({ gitDir: fixture.gitDir })).branch).toBeNull();
  });

  it('openRepo({ branch }) binds any branch; refs/heads/<name> is accepted', async () => {
    const fixture = await dataBranchRepo();
    expect((await openRepo({ gitDir: fixture.gitDir, branch: 'data' })).branch).toBe('data');
    expect((await openRepo({ gitDir: fixture.gitDir, branch: 'refs/heads/data' })).branch).toBe('data');
  });

  it('reads GITSHEETS_BRANCH, then gitsheets.branch git config — option > env > config', async () => {
    const fixture = await dataBranchRepo();
    await commitFiles(fixture, 'other', { 'x.txt': 'x' }, 'other');
    await commitFiles(fixture, 'third', { 'y.txt': 'y' }, 'third');

    await fixture.git('config', 'gitsheets.branch', 'data');
    expect((await openRepo({ gitDir: fixture.gitDir })).branch).toBe('data');

    process.env['GITSHEETS_BRANCH'] = 'other';
    expect((await openRepo({ gitDir: fixture.gitDir })).branch).toBe('other');

    expect((await openRepo({ gitDir: fixture.gitDir, branch: 'third' })).branch).toBe('third');

    // An empty env var counts as unset.
    process.env['GITSHEETS_BRANCH'] = '';
    expect((await openRepo({ gitDir: fixture.gitDir })).branch).toBe('data');
  });

  it('a binding overrides a detached HEAD', async () => {
    const fixture = await dataBranchRepo();
    await fixture.git('checkout', '-q', '--detach');
    await fixture.git('config', 'gitsheets.branch', 'data');
    expect((await openRepo({ gitDir: fixture.gitDir })).branch).toBe('data');
  });

  it('rejects a tag, a commit, another ref namespace, or a malformed name with config_invalid', async () => {
    const fixture = await dataBranchRepo();
    await fixture.git('tag', 'v1', 'main');
    const commit = await git(fixture, 'rev-parse', 'main');
    for (const bad of ['v1', 'refs/tags/v1', commit, commit.slice(0, 10), 'refs/remotes/origin/main', 'a..b', 'HEAD', '']) {
      const err = await openRepo({ gitDir: fixture.gitDir, branch: bad }).catch((e: unknown) => e);
      expect(err, bad).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).code, bad).toBe('config_invalid');
    }
    // The env and git-config tiers are validated the same way.
    process.env['GITSHEETS_BRANCH'] = 'v1';
    await expect(openRepo({ gitDir: fixture.gitDir })).rejects.toMatchObject({ code: 'config_invalid' });
    delete process.env['GITSHEETS_BRANCH'];
    await fixture.git('config', 'gitsheets.branch', 'refs/tags/v1');
    await expect(openRepo({ gitDir: fixture.gitDir })).rejects.toMatchObject({ code: 'config_invalid' });
  });
});

describe('a bound branch with HEAD elsewhere', () => {
  it('live sheets read the default branch; openSheet({ ref: "HEAD" }) still reads git’s HEAD', async () => {
    const fixture = await dataBranchRepo();
    const repo = await openRepo({ gitDir: fixture.gitDir, branch: 'data' });
    const users = await repo.openSheet('users');
    expect((await users.queryFirst({ slug: 'jane' }))?.['email']).toBe('jane@x.org');
    expect(Object.keys(await repo.openSheets())).toEqual(['users']);
    await expect(repo.openSheet('users', { ref: 'HEAD' })).rejects.toMatchObject({ code: 'config_missing' });
    // An explicit ref keeps meaning git's HEAD.
    await expect(repo.readBlob('HEAD', '.gitsheets/users.toml')).rejects.toMatchObject({ code: 'record_not_found' });
  });

  it('permissive writes and transact commit to the default branch; HEAD and the working tree stay put', async () => {
    const fixture = await dataBranchRepo();
    const mainBefore = await git(fixture, 'rev-parse', 'main');
    const dataBefore = await git(fixture, 'rev-parse', 'data');
    const repo = await openRepo({ gitDir: fixture.gitDir, branch: 'data' });
    const users = await repo.openSheet('users');

    await users.upsert({ slug: 'ada', email: 'ada@x.org' });
    const afterUpsert = await git(fixture, 'rev-parse', 'data');
    expect(await git(fixture, 'rev-parse', `${afterUpsert}^`)).toBe(dataBefore);

    const result = await repo.transact({ message: 'add bob' }, async (tx) => {
      await tx.sheet('users').upsert({ slug: 'bob', email: 'bob@x.org' });
    });
    expect(result.ref).toBe('refs/heads/data');
    expect(result.parentCommitHash).toBe(afterUpsert);
    expect(await git(fixture, 'rev-parse', 'data')).toBe(result.commitHash);

    expect(await git(fixture, 'rev-parse', 'main')).toBe(mainBefore);
    expect(await git(fixture, 'symbolic-ref', 'HEAD')).toBe('refs/heads/main');
    expect(await git(fixture, 'status', '--porcelain')).toBe('');
    // Read-your-writes through the standing sheet.
    expect((await users.queryFirst({ slug: 'bob' }))?.['email']).toBe('bob@x.org');
  });

  it('transact({ branch }) without a parent starts from the default branch tip', async () => {
    const fixture = await dataBranchRepo();
    const dataTip = await git(fixture, 'rev-parse', 'data');
    const repo = await openRepo({ gitDir: fixture.gitDir, branch: 'data' });
    const r = await repo.transact({ message: 'side', branch: 'side' }, async (tx) => {
      await tx.sheet('users').upsert({ slug: 'eve', email: 'eve@x.org' });
    });
    expect(r.ref).toBe('refs/heads/side');
    expect(r.parentCommitHash).toBe(dataTip);
    expect(await git(fixture, 'rev-parse', 'data')).toBe(dataTip);
  });

  it('auto-refresh fires for a commit on the default branch, not for a side-branch commit', async () => {
    const fixture = await dataBranchRepo();
    await fixture.git('branch', 'side', 'data');
    const repo = await openRepo({ gitDir: fixture.gitDir, branch: 'data' });
    const users = await repo.openSheet('users');
    expect(await users.count()).toBe(1);

    await repo.transact({ message: 'side write', parent: 'side' }, async (tx) => {
      await tx.sheet('users').upsert({ slug: 'side', email: 'side@x.org' });
    });
    // An out-of-band move of the default branch is NOT picked up by a side commit.
    await commitFiles(fixture, 'data', { 'users/oob.toml': 'email = "oob@x.org"\nslug = "oob"\n' }, 'oob');
    await repo.transact({ message: 'side write 2', parent: 'side' }, async (tx) => {
      await tx.sheet('users').upsert({ slug: 'side2', email: 'side2@x.org' });
    });
    expect(await users.count()).toBe(1);

    await repo.transact({ message: 'data write' }, async (tx) => {
      await tx.sheet('users').upsert({ slug: 'ada', email: 'ada@x.org' });
    });
    // oob + ada + jane — and nothing from side.
    const slugs: unknown[] = [];
    for await (const u of users.query()) slugs.push(u['slug']);
    expect(slugs.sort()).toEqual(['ada', 'jane', 'oob']);
  });

  it('repo.refresh() and sheet.refresh() re-resolve the default branch', async () => {
    const fixture = await dataBranchRepo();
    const repo = await openRepo({ gitDir: fixture.gitDir, branch: 'data' });
    const users = await repo.openSheet('users');
    const again = await repo.openSheet('users');
    await commitFiles(fixture, 'data', { 'users/oob.toml': 'email = "oob@x.org"\nslug = "oob"\n' }, 'oob');
    expect(await users.count()).toBe(1);
    await users.refresh();
    expect(await users.count()).toBe(2);
    expect(await again.count()).toBe(1);
    await repo.refresh();
    expect(await again.count()).toBe(2);
  });

  it('willChange compares against the default branch', async () => {
    const fixture = await dataBranchRepo();
    const repo = await openRepo({ gitDir: fixture.gitDir, branch: 'data' });
    const users = await repo.openSheet('users');
    expect((await users.willChange({ slug: 'jane', email: 'jane@x.org' })).changed).toBe(false);
    expect((await users.willChange({ slug: 'jane', email: 'jane@new.org' })).changed).toBe(true);
  });
});

describe('an unborn default branch', () => {
  it('discovers nothing; openSheet is config_missing', async () => {
    const fixture = await testRepo({ withInitialCommit: true });
    handles.push(fixture);
    const repo = await openRepo({ gitDir: fixture.gitDir, branch: 'data' });
    expect(repo.branch).toBe('data');
    expect(await repo.openSheets()).toEqual({});
    await expect(repo.openSheet('users')).rejects.toMatchObject({ code: 'config_missing' });
  });

  it('the first committing transaction creates the branch with a root commit', async () => {
    const fixture = await testRepo({ withInitialCommit: true });
    handles.push(fixture);
    const mainBefore = await git(fixture, 'rev-parse', 'main');
    const repo = await openRepo({ gitDir: fixture.gitDir, branch: 'data' });

    // A handler that writes nothing commits nothing — and creates no branch.
    const noop = await repo.transact({ message: 'nothing' }, async () => 'v');
    expect(noop).toMatchObject({ value: 'v', commitHash: null, ref: null });
    await expect(fixture.git('rev-parse', '--verify', '--quiet', 'refs/heads/data')).rejects.toBeTruthy();

    const first = await repo.transact({ message: 'init users' }, async (tx) => {
      tx.writeFile('.gitsheets/users.toml', USERS);
    });
    expect(first.ref).toBe('refs/heads/data');
    expect(first.parentCommitHash).toBeNull();
    expect(await git(fixture, 'rev-list', '--count', 'data')).toBe('1');
    expect(await git(fixture, 'ls-tree', '-r', '--name-only', 'data')).toBe('.gitsheets/users.toml');
    expect(await git(fixture, 'rev-parse', 'main')).toBe(mainBefore);
    expect(await git(fixture, 'status', '--porcelain')).toBe('');

    // Now the sheet opens and later writes stack on the root.
    const users = await repo.openSheet('users');
    await users.upsert({ slug: 'jane', email: 'jane@x.org' });
    expect(await git(fixture, 'rev-list', '--count', 'data')).toBe('2');
  });

  it('live sheets opened before the bootstrap see it via auto-refresh', async () => {
    // A Sheet needs its config to open (config_missing on an unborn branch),
    // so the standing handle is opened after the config-only root commit and
    // before any record lands; the record commit rebinds it.
    const fixture = await testRepo({ withInitialCommit: true });
    handles.push(fixture);
    const repo = await openRepo({ gitDir: fixture.gitDir, branch: 'data' });
    expect(await repo.openSheets()).toEqual({});
    await repo.transact({ message: 'init' }, async (tx) => {
      tx.writeFile('.gitsheets/users.toml', USERS);
    });
    const users = await repo.openSheet('users');
    expect(await users.count()).toBe(0);
    await repo.transact({ message: 'jane' }, async (tx) => {
      await tx.sheet('users').upsert({ slug: 'jane', email: 'jane@x.org' });
    });
    expect(await users.count()).toBe(1);
  });

  it('a live sheet whose config lands in the same bootstrap commit as records', async () => {
    const fixture = await testRepo({ withInitialCommit: true });
    handles.push(fixture);
    const repo = await openRepo({ gitDir: fixture.gitDir, branch: 'data' });
    const before = await repo.currentReadTree();
    await repo.transact({ message: 'seed' }, async (tx) => {
      tx.writeFile('.gitsheets/users.toml', USERS);
      await tx.sheet('users').upsert({ slug: 'jane', email: 'jane@x.org' });
    });
    expect(await repo.currentReadTree()).not.toBe(before);
    expect(await (await repo.openSheet('users')).count()).toBe(1);
  });

  it('an existing different branch with no parent is refused with a clear commit_failed', async () => {
    const fixture = await testRepo({ withInitialCommit: true });
    handles.push(fixture);
    const repo = await openRepo({ gitDir: fixture.gitDir, branch: 'data' });
    const err = await repo
      .transact({ message: 'x', branch: 'main' }, async (tx) => {
        tx.writeFile('a.txt', 'a');
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransactionError);
    expect((err as TransactionError).code).toBe('commit_failed');
    expect((err as Error).message).toMatch(/unborn.*pass opts\.parent/);
    expect((err as Error).message).not.toMatch(/parent: null/);
    // A different branch that does not exist yet is fine: created as a root.
    const ok = await repo.transact({ message: 'y', branch: 'other' }, async (tx) => {
      tx.writeFile('a.txt', 'a');
    });
    expect(ok.ref).toBe('refs/heads/other');
  });

  it('a fresh repo bound to HEAD’s own unborn branch keeps the fresh-repo path', async () => {
    const fixture = await testRepo();
    handles.push(fixture);
    const repo = await openRepo({ gitDir: fixture.gitDir });
    expect(repo.branch).toBe('main');
    const noop = await repo.transact({ message: 'nothing' }, async () => 0);
    expect(noop.commitHash).toBeNull();
    const r = await repo.transact({ message: 'init' }, async (tx) => {
      tx.writeFile('.gitsheets/users.toml', USERS);
    });
    expect(r.ref).toBe('refs/heads/main');
  });
});

describe('sync / fetch / push daemon / merge default to the default branch', () => {
  async function withRemote(): Promise<{ fixture: TestRepoHandle; remote: string; repo: Repository }> {
    const fixture = await dataBranchRepo();
    const remote = await mkdtemp(join(tmpdir(), 'gitsheets-db-remote-'));
    dirs.push(remote);
    await exec('git', ['init', '-q', '--bare', remote]);
    await fixture.git('remote', 'add', 'origin', remote);
    await fixture.git('push', '-q', 'origin', 'data');
    // HEAD detached: today's branch-defaulting operations would throw.
    await fixture.git('checkout', '-q', '--detach', 'main');
    const repo = await openRepo({ gitDir: fixture.gitDir, branch: 'data' });
    return { fixture, remote, repo };
  }

  it('detached HEAD with no binding still throws RefError', async () => {
    const fixture = await testRepo({ withInitialCommit: true });
    handles.push(fixture);
    await fixture.git('checkout', '-q', '--detach');
    const repo = await openRepo({ gitDir: fixture.gitDir });
    await expect(repo.sync()).rejects.toBeInstanceOf(RefError);
    await expect(repo.fetch()).rejects.toBeInstanceOf(RefError);
    await expect(repo.merge({ theirs: 'main' })).rejects.toBeInstanceOf(RefError);
    await expect(repo.startPushDaemon({ remote: 'origin' })).rejects.toBeInstanceOf(RefError);
  });

  it('fetch and sync act on the bound branch and rebind live sheets', async () => {
    const { fixture, remote, repo } = await withRemote();
    const users = await repo.openSheet('users');

    // Another writer advances data on the remote.
    const other = await mkdtemp(join(tmpdir(), 'gitsheets-db-other-'));
    dirs.push(other);
    await exec('git', ['clone', '-q', '-b', 'data', remote, other]);
    await exec('git', ['-C', other, 'config', 'user.name', 'O']);
    await exec('git', ['-C', other, 'config', 'user.email', 'o@x.org']);
    await exec('git', ['-C', other, 'config', 'commit.gpgsign', 'false']);
    await exec('sh', ['-c', `printf 'email = "z@x.org"\\nslug = "zed"\\n' > users/zed.toml`], { cwd: other });
    await exec('git', ['-C', other, 'add', 'users']);
    await exec('git', ['-C', other, 'commit', '-q', '-m', 'zed']);
    await exec('git', ['-C', other, 'push', '-q', 'origin', 'data']);

    const fetched = await repo.fetch();
    expect(fetched).toMatchObject({ ok: true, remoteRef: 'refs/remotes/origin/data' });

    const r = await repo.sync({ fetch: false });
    expect(r.outcome).toBe('fast-forwarded');
    expect(await git(fixture, 'rev-parse', 'data')).toBe(r.newCommit);
    expect(await users.count()).toBe(2);
  });

  it('the push daemon pushes the bound branch', async () => {
    const { fixture, remote, repo } = await withRemote();
    const daemon = await repo.startPushDaemon({ remote: 'origin' });
    try {
      const pushed = new Promise<void>((resolve) => daemon.on('push', () => resolve()));
      const users = await repo.openSheet('users');
      await users.upsert({ slug: 'ada', email: 'ada@x.org' });
      await pushed;
      const local = await git(fixture, 'rev-parse', 'data');
      const { stdout } = await exec('git', ['rev-parse', 'refs/heads/data'], { cwd: remote });
      expect(stdout.trim()).toBe(local);
    } finally {
      await daemon.stop();
    }
  });

  it('merge defaults ours to the bound branch', async () => {
    const { fixture, repo } = await withRemote();
    await fixture.git('branch', 'import', 'data');
    await commitFiles(fixture, 'import', { 'users/imp.toml': 'email = "imp@x.org"\nslug = "imp"\n' }, 'import');
    const users = await repo.openSheet('users');
    const r = await repo.merge({ theirs: 'import' });
    expect(r.outcome).toBe('fast-forward');
    expect(await git(fixture, 'rev-parse', 'data')).toBe(r.commit);
    expect(await users.count()).toBe(2);
  });
});

describe('review round 1', () => {
  async function cloneWithRemoteData(): Promise<{ clone: TestRepoHandle; repoPath: string }> {
    const origin = await dataBranchRepo();
    const dir = await mkdtemp(join(tmpdir(), 'gitsheets-db-clone-'));
    dirs.push(dir);
    await exec('git', ['clone', '-q', origin.path, dir]);
    const clone: TestRepoHandle = {
      path: dir,
      gitDir: join(dir, '.git'),
      git: (...args: string[]) => exec('git', args, { cwd: dir }),
      cleanup: async () => {},
    };
    await clone.git('config', 'user.name', 'C');
    await clone.git('config', 'user.email', 'c@x.org');
    return { clone, repoPath: dir };
  }

  it('a branch present only as a remote-tracking ref is config_invalid, naming the remedy', async () => {
    const { clone } = await cloneWithRemoteData();
    await expect(clone.git('rev-parse', '--verify', '--quiet', 'refs/heads/data')).rejects.toBeTruthy();
    const err = await openRepo({ gitDir: clone.gitDir, branch: 'data' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).code).toBe('config_invalid');
    expect((err as Error).message).toContain('git branch data origin/data');
    await clone.git('config', 'gitsheets.branch', 'data');
    await expect(openRepo({ gitDir: clone.gitDir })).rejects.toMatchObject({ code: 'config_invalid' });
    // The remedy works.
    await clone.git('branch', 'data', 'origin/data');
    const repo = await openRepo({ gitDir: clone.gitDir });
    expect(await (await repo.openSheet('users')).count()).toBe(1);
  });

  it('a remote-tracking copy fetched after open blocks the bootstrap write', async () => {
    const origin = await dataBranchRepo();
    const fixture = await testRepo({ withInitialCommit: true });
    handles.push(fixture);
    const repo = await openRepo({ gitDir: fixture.gitDir, branch: 'data' });
    await fixture.git('remote', 'add', 'origin', origin.path);
    await fixture.git('fetch', '-q', 'origin');
    await expect(
      repo.transact({ message: 'x' }, async (tx) => {
        tx.writeFile('a.txt', 'a');
      }),
    ).rejects.toMatchObject({ code: 'config_invalid' });
    await expect(fixture.git('rev-parse', '--verify', '--quiet', 'refs/heads/data')).rejects.toBeTruthy();
  });

  it('tag() defaults to the default branch tip; HEAD when bound to a detached HEAD', async () => {
    const fixture = await dataBranchRepo();
    const repo = await openRepo({ gitDir: fixture.gitDir, branch: 'data' });
    expect(await repo.tag('snap')).toBe(await git(fixture, 'rev-parse', 'data'));
    await fixture.git('checkout', '-q', '--detach', 'main');
    const detached = await openRepo({ gitDir: fixture.gitDir });
    expect(detached.branch).toBeNull();
    expect(await detached.tag('head-snap')).toBe(await git(fixture, 'rev-parse', 'HEAD'));
    // An explicit target still means what it names.
    expect(await repo.tag('main-snap', 'main')).toBe(await git(fixture, 'rev-parse', 'main'));
  });

  it('merge moves a default branch whose name looks like a hash', async () => {
    const fixture = await dataBranchRepo();
    await fixture.git('branch', '2026', 'data');
    await fixture.git('branch', 'import', 'data');
    await commitFiles(fixture, 'import', { 'users/imp.toml': 'email = "imp@x.org"\nslug = "imp"\n' }, 'import');
    await commitFiles(fixture, '2026', { 'users/loc.toml': 'email = "loc@x.org"\nslug = "loc"\n' }, 'local');
    const repo = await openRepo({ gitDir: fixture.gitDir, branch: '2026' });
    const users = await repo.openSheet('users');
    const r = await repo.merge({ theirs: 'import' });
    expect(r.outcome).toBe('merged');
    expect(await git(fixture, 'rev-parse', 'refs/heads/2026')).toBe(r.commit);
    expect(await git(fixture, 'log', '-1', '--format=%s', 'refs/heads/2026')).toBe('Merge import into 2026');
    expect(await users.count()).toBe(3);
  });

  it('detached HEAD + binding: writes land on the bound branch, HEAD stays detached', async () => {
    const fixture = await dataBranchRepo();
    await fixture.git('checkout', '-q', '--detach', 'main');
    const head0 = await git(fixture, 'rev-parse', 'HEAD');
    const data0 = await git(fixture, 'rev-parse', 'data');
    const repo = await openRepo({ gitDir: fixture.gitDir, branch: 'data' });
    const users = await repo.openSheet('users');
    await users.upsert({ slug: 'ada', email: 'ada@x.org' });
    expect(await git(fixture, 'rev-parse', 'data^')).toBe(data0);
    expect(await git(fixture, 'rev-parse', 'HEAD')).toBe(head0);
    await expect(fixture.git('symbolic-ref', '--quiet', 'HEAD')).rejects.toBeTruthy();
    expect(await users.count()).toBe(2);
  });
});
