// repo.merge() — sheet-aware merge (specs/behaviors/merge.md, #307).

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

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

/** main: users sheet + jane. `import`: branched off main. Returns the repo and the base commit. */
async function seed(): Promise<{ fixture: TestRepoHandle; repo: Repository; base: string }> {
  const fixture = await testRepo({ withInitialCommit: true });
  handles.push(fixture);
  await mkdir(join(fixture.path, '.gitsheets'), { recursive: true });
  await writeFile(join(fixture.path, '.gitsheets', 'users.toml'), USERS);
  await fixture.git('add', '.gitsheets/');
  await fixture.git('commit', '-m', 'add users sheet');
  const repo = await openRepo({ gitDir: fixture.gitDir });
  await repo.transact({ message: 'jane' }, async (tx) => {
    await tx.sheet('users').upsert({ slug: 'jane', email: 'jane@x.org', name: 'Jane' });
  });
  const base = (await fixture.git('rev-parse', 'main')).stdout.trim();
  await fixture.git('branch', 'import');
  return { fixture, repo, base };
}

/** Commit raw record text on a branch through tx.writeFile (raw bytes survive; no working tree involved). */
async function rawCommit(repo: Repository, branch: string, path: string, text: string | null, message: string): Promise<string> {
  const { commitHash } = await repo.transact({ message, parent: branch }, async (tx) => {
    if (text === null) tx.deleteFile(path);
    else tx.writeFile(path, text);
  });
  return commitHash!;
}

describe('repo.merge()', () => {
  it('field-merges a record changed on both sides and writes it canonically', async () => {
    const { fixture, repo, base } = await seed();
    await repo.transact({ message: 'ours: new email' }, async (tx) => {
      await tx.sheet('users').upsert({ slug: 'jane', email: 'jane@new.org', name: 'Jane' });
    });
    // theirs: an old serialization — different key order, underscored int.
    const theirs = await rawCommit(repo, 'import', 'users/jane.toml', 'slug = "jane"\nname = "Jane"\nemail = "jane@x.org"\ngithubUserId = 458_494\n', 'theirs');

    const users = await repo.openSheet('users');
    const r = await repo.merge({ theirs: 'import', author: { name: 'M', email: 'm@x.org' } });
    expect(r.outcome).toBe('merged');
    expect(r.base).toBe(base);
    expect(r.theirsCommit).toBe(theirs);
    expect(r.mergedRecords).toEqual(['users/jane.toml']);
    expect(r.conflicts).toEqual([]);
    const { stdout: blob } = await fixture.git('show', `${r.commit}:users/jane.toml`);
    expect(blob).toBe('email = "jane@new.org"\ngithubUserId = 458494\nname = "Jane"\nslug = "jane"\n');
    const { stdout: parents } = await fixture.git('log', '--format=%P', '-1', r.commit!);
    expect(parents.trim().split(' ')).toEqual([r.oursCommit, theirs]);
    expect((await fixture.git('rev-parse', 'main')).stdout.trim()).toBe(r.commit);
    // Live sheets were rebound: the merged record is visible without refresh().
    expect((await users.get('jane'))?.['githubUserId']).toBe(458494);
  });

  it("reports a field conflict and writes nothing by default; prefer: 'theirs' resolves it", async () => {
    const { fixture, repo } = await seed();
    await repo.transact({ message: 'ours' }, async (tx) => {
      await tx.sheet('users').upsert({ slug: 'jane', email: 'ours@x.org', name: 'Jane' });
    });
    await rawCommit(repo, 'import', 'users/jane.toml', 'email = "theirs@x.org"\nname = "Jane"\nslug = "jane"\n', 'theirs');
    const before = (await fixture.git('rev-parse', 'main')).stdout.trim();

    const r = await repo.merge({ theirs: 'import' });
    expect(r.outcome).toBe('conflict');
    expect(r.commit).toBeNull();
    expect(r.conflicts).toEqual([expect.objectContaining({ path: 'users/jane.toml', kind: 'field', field: 'email' })]);
    expect((await fixture.git('rev-parse', 'main')).stdout.trim()).toBe(before);

    const resolved = await repo.merge({ theirs: 'import', prefer: 'theirs' });
    expect(resolved.outcome).toBe('merged');
    const { stdout: blob } = await fixture.git('show', `${resolved.commit}:users/jane.toml`);
    expect(blob).toBe('email = "theirs@x.org"\nname = "Jane"\nslug = "jane"\n');
  });

  it("delete/modify: reported by default; prefer: 'theirs' keeps their modified record", async () => {
    const { fixture, repo } = await seed();
    await repo.transact({ message: 'ours deletes jane' }, async (tx) => {
      await tx.sheet('users').delete('jane');
    });
    await rawCommit(repo, 'import', 'users/jane.toml', 'email = "jane@x.org"\nname = "Jane D"\nslug = "jane"\n', 'theirs modifies');
    const r = await repo.merge({ theirs: 'import' });
    expect(r.outcome).toBe('conflict');
    expect(r.conflicts[0]).toMatchObject({ path: 'users/jane.toml', kind: 'delete-modify' });
    const resolved = await repo.merge({ theirs: 'import', prefer: 'theirs' });
    expect(resolved.outcome).toBe('merged');
    const users = await repo.openSheet('users');
    expect((await users.get('jane'))?.['name']).toBe('Jane D');
  });

  it('dry-run writes the tree and moves nothing; up-to-date and fast-forward short-circuit', async () => {
    const { fixture, repo } = await seed();
    await rawCommit(repo, 'import', 'users/bob.toml', 'slug = "bob"\n', 'theirs adds bob');
    const before = (await fixture.git('rev-parse', 'main')).stdout.trim();
    const dry = await repo.merge({ theirs: 'import', commit: false });
    expect(dry.outcome).toBe('dry-run');
    expect(dry.tree).toMatch(/^[0-9a-f]{40}$/);
    expect(dry.commit).toBeNull();
    expect((await fixture.git('rev-parse', 'main')).stdout.trim()).toBe(before);

    const ff = await repo.merge({ theirs: 'import' });
    expect(ff.outcome).toBe('fast-forward');
    expect((await fixture.git('rev-parse', 'main')).stdout.trim()).toBe(ff.commit);
    const again = await repo.merge({ theirs: 'import' });
    expect(again.outcome).toBe('up-to-date');
  });
});
