// Lazy body loading on content-typed sheets (#158).

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openRepo } from './repository.js';
import { testRepo, type TestRepoHandle } from './test-helpers/test-repo.js';

const handles: TestRepoHandle[] = [];
afterEach(async () => {
  while (handles.length > 0) {
    const h = handles.pop();
    if (h) await h.cleanup();
  }
});

async function seedRepoWithPosts(): Promise<TestRepoHandle> {
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
  return fixture;
}

describe('Sheet.query withBody', () => {
  it('default includes the body', async () => {
    const fixture = await seedRepoWithPosts();
    const repo = await openRepo({ gitDir: fixture.gitDir });
    await repo.transact({ message: 'seed' }, async (tx) => {
      await tx.sheet('posts').upsert({ slug: 'a', title: 'A', body: 'body A' });
    });

    const posts = await repo.openSheet('posts');
    for await (const post of posts.query()) {
      expect(post['body']).toBe('body A');
    }
  });

  it('withBody: false omits the body', async () => {
    const fixture = await seedRepoWithPosts();
    const repo = await openRepo({ gitDir: fixture.gitDir });
    await repo.transact({ message: 'seed' }, async (tx) => {
      await tx.sheet('posts').upsert({
        slug: 'a',
        title: 'A',
        body: 'a huge body\n'.repeat(1000),
      });
    });

    const posts = await repo.openSheet('posts');
    for await (const post of posts.query({}, { withBody: false })) {
      expect(post['title']).toBe('A');
      expect(post['body']).toBeUndefined();
    }
  });

  it('rejects a filter on the body field when withBody: false', async () => {
    const fixture = await seedRepoWithPosts();
    const repo = await openRepo({ gitDir: fixture.gitDir });
    await repo.transact({ message: 'seed' }, async (tx) => {
      await tx.sheet('posts').upsert({ slug: 'a', title: 'A', body: 'x' });
    });

    const posts = await repo.openSheet('posts');
    await expect(async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of posts.query({ body: 'x' }, { withBody: false })) {
        // never reaches
      }
    }).rejects.toThrow(/body field/);
  });

  it('withBody: false works for queryAll and queryFirst', async () => {
    const fixture = await seedRepoWithPosts();
    const repo = await openRepo({ gitDir: fixture.gitDir });
    await repo.transact({ message: 'seed' }, async (tx) => {
      await tx.sheet('posts').upsert({ slug: 'a', title: 'A', body: 'BIG' });
    });

    const posts = await repo.openSheet('posts');
    const all = await posts.queryAll({}, { withBody: false });
    expect(all[0]?.['body']).toBeUndefined();
    const first = await posts.queryFirst({}, { withBody: false });
    expect(first?.['body']).toBeUndefined();
  });

  it('withBody is a no-op on TOML sheets', async () => {
    const fixture = await testRepo({ withInitialCommit: true });
    handles.push(fixture);
    await mkdir(join(fixture.path, '.gitsheets'), { recursive: true });
    await writeFile(
      join(fixture.path, '.gitsheets', 'users.toml'),
      `[gitsheet]\nroot = 'users'\npath = '\${{ slug }}'\n`,
    );
    await fixture.git('add', '.gitsheets/');
    await fixture.git('commit', '-m', 'add users');

    const repo = await openRepo({ gitDir: fixture.gitDir });
    await repo.transact({ message: 'seed' }, async (tx) => {
      await tx.sheet('users').upsert({ slug: 'jane', email: 'j@x' });
    });

    const users = await repo.openSheet('users');
    const all = await users.queryAll({}, { withBody: false });
    expect(all[0]?.['slug']).toBe('jane');
    expect(all[0]?.['email']).toBe('j@x');
  });
});

describe('Sheet.loadBody', () => {
  it('hydrates a body-less record', async () => {
    const fixture = await seedRepoWithPosts();
    const repo = await openRepo({ gitDir: fixture.gitDir });
    await repo.transact({ message: 'seed' }, async (tx) => {
      await tx.sheet('posts').upsert({ slug: 'a', title: 'A', body: 'hydrate me' });
    });

    const posts = await repo.openSheet('posts');
    const headerOnly = await posts.queryFirst({}, { withBody: false });
    expect(headerOnly!['body']).toBeUndefined();

    const full = await posts.loadBody(headerOnly!);
    expect(full['body']).toBe('hydrate me');
    expect(full['title']).toBe('A');
  });

  it('throws when called on a record without a path annotation', async () => {
    const fixture = await seedRepoWithPosts();
    const repo = await openRepo({ gitDir: fixture.gitDir });
    const posts = await repo.openSheet('posts');
    await expect(posts.loadBody({ slug: 'orphan' })).rejects.toThrow(/path annotation/);
  });
});

describe('Sheet.upsert allowMissingBody', () => {
  it('rejects a body-less upsert by default on a markdown sheet', async () => {
    const fixture = await seedRepoWithPosts();
    const repo = await openRepo({ gitDir: fixture.gitDir });
    await expect(
      repo.transact({ message: 'no body' }, async (tx) =>
        tx.sheet('posts').upsert({ slug: 'a', title: 'A' }),
      ),
    ).rejects.toThrow(/missing the body field/);
  });

  it('permits a body-less upsert when allowMissingBody: true', async () => {
    const fixture = await seedRepoWithPosts();
    const repo = await openRepo({ gitDir: fixture.gitDir });
    await repo.transact({ message: 'no body, opted in' }, async (tx) => {
      await tx.sheet('posts').upsert(
        { slug: 'a', title: 'A' },
        { allowMissingBody: true },
      );
    });
    const posts = await repo.openSheet('posts');
    const a = await posts.queryFirst({ slug: 'a' });
    expect(a!['title']).toBe('A');
    expect(a!['body']).toBe(''); // serialized as empty body
  });

  it('Sheet.patch preserves the body when patching only frontmatter', async () => {
    const fixture = await seedRepoWithPosts();
    const repo = await openRepo({ gitDir: fixture.gitDir });
    await repo.transact({ message: 'seed' }, async (tx) => {
      await tx.sheet('posts').upsert({
        slug: 'preserved',
        title: 'old',
        // No trailing newline — the on-disk file always ends with one, so
        // the trailing newline is the file's not the body's.
        body: 'body bytes survive',
      });
    });

    await repo.transact({ message: 'patch title' }, async (tx) => {
      await tx.sheet('posts').patch({ slug: 'preserved' }, { title: 'new' });
    });

    const posts = await repo.openSheet('posts');
    const r = await posts.queryFirst({ slug: 'preserved' });
    expect(r!['title']).toBe('new');
    expect(r!['body']).toBe('body bytes survive');
  });

  it('Sheet.patch with { body: null } deletes the body (RFC 7396)', async () => {
    const fixture = await seedRepoWithPosts();
    const repo = await openRepo({ gitDir: fixture.gitDir });
    await repo.transact({ message: 'seed' }, async (tx) => {
      await tx.sheet('posts').upsert({
        slug: 'with-body',
        title: 'T',
        body: 'goodbye',
      });
    });

    await repo.transact({ message: 'drop body' }, async (tx) => {
      await tx.sheet('posts').patch({ slug: 'with-body' }, { body: null as unknown as string });
    });

    const posts = await repo.openSheet('posts');
    const r = await posts.queryFirst({ slug: 'with-body' });
    expect(r!['body']).toBe('');
  });
});

describe('Index build uses body-less reads', () => {
  it('keyFn referencing the body field sees undefined and degenerates', async () => {
    const fixture = await seedRepoWithPosts();
    const repo = await openRepo({ gitDir: fixture.gitDir });
    await repo.transact({ message: 'seed' }, async (tx) => {
      const posts = tx.sheet('posts');
      await posts.upsert({ slug: 'a', title: 'A', body: 'BODY-A' });
      await posts.upsert({ slug: 'b', title: 'B', body: 'BODY-B' });
    });

    const posts = await repo.openSheet('posts');
    // An index keyed on body content sees undefined for every record and
    // either collapses to a single bucket (non-unique) or excludes all
    // records (because keyFn returns undefined → excluded).
    posts.defineIndex('byBody', (record: Record<string, unknown>) =>
      typeof record['body'] === 'string' ? record['body'] : undefined,
    );
    // No records have body in the indexed view, so findByIndex finds none.
    expect(await posts.findByIndex('byBody', 'BODY-A')).toEqual([]);

    // Index on a frontmatter field works normally.
    posts.defineIndex('byTitle', (r) => String((r as Record<string, unknown>)['title']));
    const aByTitle = await posts.findByIndex('byTitle', 'A');
    expect(Array.isArray(aByTitle) ? aByTitle.length : 0).toBe(1);
  });

  it('findByIndex returns body-less records that loadBody hydrates', async () => {
    const fixture = await seedRepoWithPosts();
    const repo = await openRepo({ gitDir: fixture.gitDir });
    await repo.transact({ message: 'seed' }, async (tx) => {
      await tx.sheet('posts').upsert({ slug: 'one', title: 'One', body: 'BODY-1' });
    });

    const posts = await repo.openSheet('posts');
    posts.defineIndex('byTitle', { unique: true }, (r) =>
      String((r as Record<string, unknown>)['title']),
    );
    const found = (await posts.findByIndex('byTitle', 'One')) as Record<string, unknown> | undefined;
    expect(found).toBeDefined();
    expect(found!['body']).toBeUndefined();

    const full = await posts.loadBody(found as Record<string, unknown>);
    expect(full['body']).toBe('BODY-1');
  });
});
