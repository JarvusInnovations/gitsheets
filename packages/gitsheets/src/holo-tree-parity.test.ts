// holo-tree spike (#127), Phase B: prove the Rust holo-tree binding builds
// byte-identical trees to the hologit-JS path for the upsert→commit slice.
//
// Trees are content-addressed, so an identical tree hash is a strong oracle:
// it means the binding's blob hashing + tree serialization (sorting, modes,
// nesting) match git exactly. Both paths are driven through the SAME public
// Repository API; only `repo.enableHoloTree()` differs.
//
// NOTE: commit-hash parity is intentionally NOT asserted — holo-tree's
// commit_tree derives author/committer from git-config + the current time and
// can't yet take explicit identity/time (see notes/holo-tree-findings.md), so
// the two paths' commits differ in identity/timestamp. Tree parity is the
// deterministic, substrate-equivalence claim.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openRepo } from './repository.js';
import { testRepo, type TestRepoHandle } from './test-helpers/test-repo.js';

const WIDGETS_CONFIG = `[gitsheet]
root = 'widgets'
path = '\${{ id }}'
`;

const handles: TestRepoHandle[] = [];
afterEach(async () => {
  while (handles.length > 0) {
    const h = handles.pop();
    if (h) await h.cleanup();
  }
});

async function seedRepo(): Promise<TestRepoHandle> {
  const fixture = await testRepo({ withInitialCommit: true });
  handles.push(fixture);
  await mkdir(join(fixture.path, '.gitsheets'), { recursive: true });
  await writeFile(join(fixture.path, '.gitsheets', 'widgets.toml'), WIDGETS_CONFIG);
  await fixture.git('add', '.gitsheets/');
  await fixture.git('commit', '-m', 'add widgets sheet');
  return fixture;
}

async function headHash(fixture: TestRepoHandle): Promise<string> {
  return (await fixture.git('rev-parse', 'HEAD')).stdout.trim();
}

describe('holo-tree parity (#127)', () => {
  it('builds the same tree as hologit for a single upsert', async () => {
    const fixture = await seedRepo();
    const parent = await headHash(fixture);
    const record = { id: '1', name: 'widget one' };

    const js = await openRepo({ gitDir: fixture.gitDir });
    const jsResult = await js.transact({ parent, message: 'add widget 1' }, async (tx) => {
      await tx.sheet('widgets').upsert(record);
    });

    const holo = await openRepo({ gitDir: fixture.gitDir });
    holo.enableHoloTree();
    const holoResult = await holo.transact({ parent, message: 'add widget 1' }, async (tx) => {
      await tx.sheet('widgets').upsert(record);
    });

    expect(jsResult.treeHash).not.toBeNull();
    expect(holoResult.treeHash).toBe(jsResult.treeHash);
    expect(holoResult.commitHash).not.toBeNull();
  });

  it('builds the same tree for multiple records in one transaction', async () => {
    const fixture = await seedRepo();
    const parent = await headHash(fixture);
    const records = [
      { id: 'a', name: 'alpha' },
      { id: 'b', name: 'bravo' },
      { id: 'c', name: 'charlie' },
    ];

    const js = await openRepo({ gitDir: fixture.gitDir });
    const jsResult = await js.transact({ parent, message: 'bulk' }, async (tx) => {
      const sheet = tx.sheet('widgets');
      for (const r of records) await sheet.upsert(r);
    });

    const holo = await openRepo({ gitDir: fixture.gitDir });
    holo.enableHoloTree();
    const holoResult = await holo.transact({ parent, message: 'bulk' }, async (tx) => {
      const sheet = tx.sheet('widgets');
      for (const r of records) await sheet.upsert(r);
    });

    expect(holoResult.treeHash).toBe(jsResult.treeHash);
  });

  it('drives commit + ref update through the binding, advancing the branch', async () => {
    const fixture = await seedRepo();
    const parent = await headHash(fixture);

    const holo = await openRepo({ gitDir: fixture.gitDir });
    holo.enableHoloTree();
    const result = await holo.transact(
      { branch: 'main', message: 'add widget via holo-tree' },
      async (tx) => {
        await tx.sheet('widgets').upsert({ id: '1', name: 'widget one' });
      },
    );

    // Short branch name passed through: holo-tree's update_ref qualifies it to
    // refs/heads/main (the upstream fix this case drove). The returned ref
    // echoes what the caller passed.
    expect(result.commitHash).not.toBeNull();
    expect(result.ref).toBe('main');
    expect(result.parentCommitHash).toBe(parent);

    // git agrees: the branch advanced to our commit, and its tree is the one
    // the binding wrote.
    expect((await fixture.git('rev-parse', 'main')).stdout.trim()).toBe(result.commitHash);
    expect((await fixture.git('rev-parse', 'main^{tree}')).stdout.trim()).toBe(result.treeHash);

    // The record is readable back through git.
    const onDisk = (await fixture.git('cat-file', '-p', `${result.commitHash!}:widgets/1.toml`))
      .stdout;
    expect(onDisk).toContain('name = "widget one"');
  });

  it('preserves no-op detection under the holo-tree path', async () => {
    const fixture = await seedRepo();
    const holo = await openRepo({ gitDir: fixture.gitDir });
    holo.enableHoloTree();

    // First write moves the branch.
    const first = await holo.transact({ branch: 'main', message: 'add' }, async (tx) => {
      await tx.sheet('widgets').upsert({ id: '1', name: 'widget one' });
    });
    expect(first.commitHash).not.toBeNull();

    // Byte-identical re-upsert: tree hash equals parent tree → no commit.
    const second = await holo.transact({ branch: 'main', message: 'again' }, async (tx) => {
      await tx.sheet('widgets').upsert({ id: '1', name: 'widget one' });
    });
    expect(second.commitHash).toBeNull();
    expect(second.treeHash).toBeNull();
  });
});
