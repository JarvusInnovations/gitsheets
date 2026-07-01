// Sheet.willChange — pre-flight idempotency check for upsert.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { IndexError, ValidationError } from './errors.js';
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

[gitsheet.schema]
type = 'object'
required = ['slug', 'email']

[gitsheet.schema.properties.slug]
type = 'string'
pattern = '^[a-z0-9-]+$'

[gitsheet.schema.properties.email]
type = 'string'
format = 'email'
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

describe('Sheet.willChange', () => {
  it('returns changed=true when no record exists at the path', async () => {
    const fixture = await seedRepo();
    const repo = await openRepo({ gitDir: fixture.gitDir });
    const sheet = await repo.openSheet('users');

    const result = await sheet.willChange({ slug: 'jane', email: 'jane@x.org' });

    expect(result.changed).toBe(true);
    expect(result.path).toBe('jane');
    expect(result.currentBlobHash).toBeUndefined();
    expect(result.nextText).toContain('email = "jane@x.org"');
    expect(result.nextText).toContain('slug = "jane"');
  });

  it('returns changed=false when canonical bytes match existing blob', async () => {
    const fixture = await seedRepo();
    const repo = await openRepo({ gitDir: fixture.gitDir });

    await repo.transact({ message: 'seed jane' }, async (tx) => {
      await tx.sheet('users').upsert({ slug: 'jane', email: 'jane@x.org' });
    });

    const sheet = await repo.openSheet('users');
    const result = await sheet.willChange({ slug: 'jane', email: 'jane@x.org' });

    expect(result.changed).toBe(false);
    expect(result.path).toBe('jane');
    expect(result.currentBlobHash).toBeDefined();
  });

  it('returns changed=true when bytes differ from existing blob', async () => {
    const fixture = await seedRepo();
    const repo = await openRepo({ gitDir: fixture.gitDir });

    await repo.transact({ message: 'seed jane' }, async (tx) => {
      await tx.sheet('users').upsert({ slug: 'jane', email: 'jane@x.org' });
    });

    const sheet = await repo.openSheet('users');
    const result = await sheet.willChange({ slug: 'jane', email: 'jane@new.org' });

    expect(result.changed).toBe(true);
    expect(result.path).toBe('jane');
    expect(result.currentBlobHash).toBeDefined();
    expect(result.nextText).toContain('email = "jane@new.org"');
  });

  it('ignores semantic-no-op input differences (object key order)', async () => {
    const fixture = await seedRepo();
    const repo = await openRepo({ gitDir: fixture.gitDir });

    await repo.transact({ message: 'seed jane' }, async (tx) => {
      await tx.sheet('users').upsert({ slug: 'jane', email: 'jane@x.org' });
    });

    const sheet = await repo.openSheet('users');
    // Same fields, different insertion order — canonical normalization should
    // produce identical bytes.
    const result = await sheet.willChange({ email: 'jane@x.org', slug: 'jane' });

    expect(result.changed).toBe(false);
  });

  it('does NOT mutate the tree', async () => {
    const fixture = await seedRepo();
    const repo = await openRepo({ gitDir: fixture.gitDir });

    const sheet = await repo.openSheet('users');
    await sheet.willChange({ slug: 'jane', email: 'jane@x.org' });

    // queryAll should still return zero records — the willChange call must
    // not have written anything.
    const rows = await sheet.queryAll({});
    expect(rows).toHaveLength(0);
  });

  it('throws ValidationError for invalid records, same as upsert', async () => {
    const fixture = await seedRepo();
    const repo = await openRepo({ gitDir: fixture.gitDir });
    const sheet = await repo.openSheet('users');

    await expect(
      sheet.willChange({ slug: '', email: 'jane@x.org' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('returns the same path upsert would render', async () => {
    const fixture = await seedRepo();
    const repo = await openRepo({ gitDir: fixture.gitDir });
    const sheet = await repo.openSheet('users');

    const result = await sheet.willChange({ slug: 'bob-tables', email: 'bob@x.org' });
    expect(result.path).toBe('bob-tables');
  });

  it('runs the unique-index conflict check, same as upsert (specs/api/sheet.md)', async () => {
    const fixture = await seedRepo();
    const repo = await openRepo({ gitDir: fixture.gitDir });

    await repo.transact({ message: 'seed jane' }, async (tx) => {
      await tx.sheet('users').upsert({ slug: 'jane', email: 'shared@x.org' });
    });

    const sheet = await repo.openSheet('users');
    await sheet.defineIndex('byEmail', { unique: true, eager: true }, (r) => r['email'] as string);

    // A different record reusing jane's email would collide on the unique index —
    // willChange must surface it the same way upsert would, before any write.
    await expect(
      sheet.willChange({ slug: 'bob', email: 'shared@x.org' }),
    ).rejects.toBeInstanceOf(IndexError);
  });

  it('handles markdown sheets — body included in byte comparison', async () => {
    const fixture = await testRepo({ withInitialCommit: true });
    handles.push(fixture);
    await mkdir(join(fixture.path, '.gitsheets'), { recursive: true });
    await writeFile(
      join(fixture.path, '.gitsheets', 'posts.toml'),
      `[gitsheet]
root = 'posts'
path = '\${{ slug }}'

[gitsheet.format]
type = 'markdown'
body = 'body'
`,
    );
    await fixture.git('add', '.gitsheets/');
    await fixture.git('commit', '-m', 'add posts sheet');

    const repo = await openRepo({ gitDir: fixture.gitDir });

    await repo.transact({ message: 'seed post' }, async (tx) => {
      await tx.sheet('posts').upsert({
        slug: 'hello',
        title: 'Hi',
        body: '# Hello\n\nWorld\n',
      });
    });

    const sheet = await repo.openSheet('posts');

    const same = await sheet.willChange({
      slug: 'hello',
      title: 'Hi',
      body: '# Hello\n\nWorld\n',
    });
    expect(same.changed).toBe(false);

    const bodyChanged = await sheet.willChange({
      slug: 'hello',
      title: 'Hi',
      body: '# Hello\n\nWorld!\n',
    });
    expect(bodyChanged.changed).toBe(true);
  });
});
