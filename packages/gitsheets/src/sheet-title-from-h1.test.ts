// End-to-end Sheet tests for the title-from-H1 invariant (#169).
//
// Format-level tests live in src/format/markdown-title.test.ts.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ValidationError } from './errors.js';
import { openRepo } from './repository.js';
import { testRepo, type TestRepoHandle } from './test-helpers/test-repo.js';

const handles: TestRepoHandle[] = [];
afterEach(async () => {
  while (handles.length > 0) {
    const h = handles.pop();
    if (h) await h.cleanup();
  }
});

const POSTS_CONFIG = `[gitsheet]
root = 'posts'
path = '\${{ slug }}'

[gitsheet.format]
type = 'markdown'
body = 'body'
title = 'title'

[gitsheet.schema]
type = 'object'
required = ['slug']

[gitsheet.schema.properties.slug]
type = 'string'

[gitsheet.schema.properties.title]
type = 'string'

[gitsheet.schema.properties.body]
type = 'string'
`;

async function seedRepo(): Promise<TestRepoHandle> {
  const fixture = await testRepo({ withInitialCommit: true });
  handles.push(fixture);
  await mkdir(join(fixture.path, '.gitsheets'), { recursive: true });
  await writeFile(join(fixture.path, '.gitsheets', 'posts.toml'), POSTS_CONFIG);
  await fixture.git('add', '.gitsheets/');
  await fixture.git('commit', '-m', 'add posts sheet');
  return fixture;
}

describe('Sheet.upsert (title from H1)', () => {
  it('derives title from body H1 when consumer omits it', async () => {
    const fixture = await seedRepo();
    const repo = await openRepo({ gitDir: fixture.gitDir });
    await repo.transact({ message: 'add hello' }, async (tx) => {
      await tx.sheet('posts').upsert({
        slug: 'hello',
        body: '# Hello, world\n\nA post.',
      });
    });

    const sheet = await repo.openSheet('posts');
    const got = await sheet.queryFirst({ slug: 'hello' });
    expect((got as Record<string, unknown>)['title']).toBe('Hello, world');
  });

  it('passes through when consumer-supplied title matches the H1', async () => {
    const fixture = await seedRepo();
    const repo = await openRepo({ gitDir: fixture.gitDir });
    await repo.transact({ message: 'add hello' }, async (tx) => {
      await tx.sheet('posts').upsert({
        slug: 'hello',
        title: 'Hello, world',
        body: '# Hello, world\n\nA post.',
      });
    });

    const sheet = await repo.openSheet('posts');
    const got = await sheet.queryFirst({ slug: 'hello' });
    expect((got as Record<string, unknown>)['title']).toBe('Hello, world');
  });

  it('throws ValidationError when supplied title disagrees with H1', async () => {
    const fixture = await seedRepo();
    const repo = await openRepo({ gitDir: fixture.gitDir });
    await expect(
      repo.transact({ message: 'add hello' }, async (tx) => {
        await tx.sheet('posts').upsert({
          slug: 'hello',
          title: 'X',
          body: '# Y\n\nbody',
        });
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('title field is available in body-less reads (denormalization)', async () => {
    const fixture = await seedRepo();
    const repo = await openRepo({ gitDir: fixture.gitDir });
    await repo.transact({ message: 'add hello' }, async (tx) => {
      await tx.sheet('posts').upsert({
        slug: 'hello',
        body: '# Hello, world\n\nLong body here.',
      });
    });

    const sheet = await repo.openSheet('posts');
    const got = await sheet.queryFirst({ slug: 'hello' }, { withBody: false });
    expect((got as Record<string, unknown>)['title']).toBe('Hello, world');
    expect((got as Record<string, unknown>)['body']).toBeUndefined();
  });
});

describe('Sheet.patch (title from H1 reconciliation)', () => {
  async function seedHello(repo: Awaited<ReturnType<typeof openRepo>>): Promise<void> {
    await repo.transact({ message: 'seed hello' }, async (tx) => {
      await tx.sheet('posts').upsert({
        slug: 'hello',
        body: '# Hello, world\n\nA post.',
      });
    });
  }

  it('{title} only rewrites body H1', async () => {
    const fixture = await seedRepo();
    const repo = await openRepo({ gitDir: fixture.gitDir });
    await seedHello(repo);

    const sheet = await repo.openSheet('posts');
    await sheet.patch({ slug: 'hello' }, { title: 'Renamed' });

    const got = await (await repo.openSheet('posts')).queryFirst({ slug: 'hello' });
    expect((got as Record<string, unknown>)['title']).toBe('Renamed');
    expect((got as Record<string, unknown>)['body']).toMatch(/^# Renamed\n/);
  });

  it('{body} only re-derives title from new body H1', async () => {
    const fixture = await seedRepo();
    const repo = await openRepo({ gitDir: fixture.gitDir });
    await seedHello(repo);

    const sheet = await repo.openSheet('posts');
    await sheet.patch(
      { slug: 'hello' },
      { body: '# New Title\n\nNew body text.' },
    );

    const got = await (await repo.openSheet('posts')).queryFirst({ slug: 'hello' });
    expect((got as Record<string, unknown>)['title']).toBe('New Title');
  });

  it('{title, body} consistent → writes as-is', async () => {
    const fixture = await seedRepo();
    const repo = await openRepo({ gitDir: fixture.gitDir });
    await seedHello(repo);

    const sheet = await repo.openSheet('posts');
    await sheet.patch(
      { slug: 'hello' },
      { title: 'Both', body: '# Both\n\nMatching body.' },
    );

    const got = await (await repo.openSheet('posts')).queryFirst({ slug: 'hello' });
    expect((got as Record<string, unknown>)['title']).toBe('Both');
  });

  it('{title, body} inconsistent → throws ValidationError', async () => {
    const fixture = await seedRepo();
    const repo = await openRepo({ gitDir: fixture.gitDir });
    await seedHello(repo);

    const sheet = await repo.openSheet('posts');
    await expect(
      sheet.patch(
        { slug: 'hello' },
        { title: 'X', body: '# Y\n\nbody' },
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('partial without title or body preserves the invariant trivially', async () => {
    const fixture = await testRepo({ withInitialCommit: true });
    handles.push(fixture);
    await mkdir(join(fixture.path, '.gitsheets'), { recursive: true });
    // Extend the schema to allow a `tags` field.
    await writeFile(
      join(fixture.path, '.gitsheets', 'posts.toml'),
      `${POSTS_CONFIG}
[gitsheet.schema.properties.tags]
type = 'array'
`,
    );
    await fixture.git('add', '.gitsheets/');
    await fixture.git('commit', '-m', 'add posts sheet with tags');

    const repo = await openRepo({ gitDir: fixture.gitDir });
    await repo.transact({ message: 'seed' }, async (tx) => {
      await tx.sheet('posts').upsert({
        slug: 'hello',
        body: '# Hello, world\n\nA post.',
      });
    });

    const sheet = await repo.openSheet('posts');
    await sheet.patch({ slug: 'hello' }, { tags: ['intro'] } as never);

    const got = await (await repo.openSheet('posts')).queryFirst({ slug: 'hello' });
    expect((got as Record<string, unknown>)['title']).toBe('Hello, world');
    expect((got as Record<string, unknown>)['tags']).toEqual(['intro']);
  });
});
