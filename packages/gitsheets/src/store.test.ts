import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ConfigError, ValidationError } from './errors.js';
import { openRepo } from './repository.js';
import { openStore } from './store.js';
import { testRepo, type TestRepoHandle } from './test-helpers/test-repo.js';
import type { StandardSchemaV1 } from './validation.js';

const handles: TestRepoHandle[] = [];
afterEach(async () => {
  while (handles.length > 0) {
    const h = handles.pop();
    if (h) await h.cleanup();
  }
});

async function makeRepo(): Promise<TestRepoHandle> {
  const h = await testRepo({ withInitialCommit: true });
  handles.push(h);
  return h;
}

async function seedConfigs(fixture: TestRepoHandle, configs: Record<string, string>): Promise<void> {
  await mkdir(join(fixture.path, '.gitsheets'), { recursive: true });
  for (const [name, content] of Object.entries(configs)) {
    await writeFile(join(fixture.path, '.gitsheets', `${name}.toml`), content);
  }
  await fixture.git('add', '.gitsheets/');
  await fixture.git('commit', '-m', 'add sheets');
}

const USERS = `[gitsheet]
root = 'users'
path = '\${{ slug }}'
`;
const PROJECTS = `[gitsheet]
root = 'projects'
path = '\${{ slug }}'
`;

import type { RecordLike } from './path-template/index.js';

function makeStandardSchema<O extends RecordLike = RecordLike>(
  validate: (value: unknown) => { value: O } | { issues: Array<{ message: string; path?: string[] }> },
): StandardSchemaV1<unknown, O> {
  return {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate(value: unknown) {
        return validate(value);
      },
    },
  };
}

describe('openStore', () => {
  it('discovers every declared sheet', async () => {
    const fixture = await makeRepo();
    await seedConfigs(fixture, { users: USERS, projects: PROJECTS });
    const repo = await openRepo({ gitDir: fixture.gitDir });
    const store = await openStore(repo);
    expect(store['users']).toBeDefined();
    expect(store['projects']).toBeDefined();
  });

  it('throws ConfigError when validators name a sheet that does not exist', async () => {
    const fixture = await makeRepo();
    await seedConfigs(fixture, { users: USERS });
    const repo = await openRepo({ gitDir: fixture.gitDir });

    const validator = makeStandardSchema<RecordLike>((v) => ({ value: v as RecordLike }));
    await expect(
      openStore(repo, { validators: { projects: validator } }),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it('attaches validators to the standalone Sheets', async () => {
    const fixture = await makeRepo();
    await seedConfigs(fixture, { users: USERS });
    const repo = await openRepo({ gitDir: fixture.gitDir });

    const requireEmail = makeStandardSchema((value) => {
      const v = value as Record<string, unknown>;
      if (typeof v['email'] !== 'string') {
        return { issues: [{ message: 'email required', path: ['email'] }] };
      }
      return { value: v };
    });

    const store = await openStore(repo, { validators: { users: requireEmail } });
    await expect((store['users'] as any).upsert({ slug: 'a' })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('threads validators through to tx-scoped sheets in store.transact', async () => {
    const fixture = await makeRepo();
    await seedConfigs(fixture, { users: USERS });
    const repo = await openRepo({ gitDir: fixture.gitDir });

    const downcaseSlug = makeStandardSchema<RecordLike>((value) => {
      const v = value as Record<string, unknown>;
      return {
        value: { ...v, slug: (v['slug'] as string).toLowerCase() } as RecordLike,
      };
    });

    const store = await openStore(repo, { validators: { users: downcaseSlug } });

    await store.transact({ message: 'tx with validator' }, async (tx) => {
      await tx['users']!.upsert({ slug: 'MIXED', email: 'm@x' });
    });

    const reopened = await repo.openSheet('users');
    const found = await reopened.queryFirst({ slug: 'mixed' });
    expect(found).toBeDefined();
  });

  it('store.transact bundles multi-sheet writes atomically', async () => {
    const fixture = await makeRepo();
    await seedConfigs(fixture, { users: USERS, projects: PROJECTS });
    const repo = await openRepo({ gitDir: fixture.gitDir });
    const store = await openStore(repo);

    const result = await store.transact({ message: 'multi' }, async (tx) => {
      await tx['users']!.upsert({ slug: 'jane' });
      await tx['projects']!.upsert({ slug: 'p1' });
      return 'done';
    });

    expect(result.value).toBe('done');
    expect(result.commitHash).toMatch(/^[0-9a-f]{40}$/);

    const users = await repo.openSheet('users');
    const projects = await repo.openSheet('projects');
    expect((await users.queryAll()).length).toBe(1);
    expect((await projects.queryAll()).length).toBe(1);
  });
});
