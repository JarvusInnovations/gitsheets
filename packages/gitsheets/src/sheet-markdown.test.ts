// End-to-end tests for content-typed (markdown) sheets (#158). Covers the
// integration between Sheet, the format dispatch, and the path-template
// extension override.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ConfigError } from './errors.js';
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
  await fixture.git('commit', '-m', 'add posts sheet (markdown)');
  return fixture;
}

describe('content-typed sheet (markdown)', () => {
  it('writes records as .md files with TOML frontmatter', async () => {
    const fixture = await seedRepoWithPosts();
    const repo = await openRepo({ gitDir: fixture.gitDir });

    await repo.transact({ message: 'first post' }, async (tx) => {
      await tx.sheet('posts').upsert({
        slug: 'hello-world',
        title: 'Hello, world',
        body: '# Hello\n\nFirst post.\n',
      });
    });

    const { stdout } = await fixture.git('ls-tree', '-r', '--name-only', 'HEAD');
    expect(stdout).toContain('posts/hello-world.md');
    expect(stdout).not.toContain('posts/hello-world.toml');

    const { stdout: content } = await fixture.git(
      'cat-file',
      'blob',
      'HEAD:posts/hello-world.md',
    );
    expect(content.startsWith('+++\n')).toBe(true);
    expect(content).toContain('slug = "hello-world"');
    expect(content).toContain('title = "Hello, world"');
    expect(content).toContain('+++\n\n# Hello\n\nFirst post.');
  });

  it('reads records back through query', async () => {
    const fixture = await seedRepoWithPosts();
    const repo = await openRepo({ gitDir: fixture.gitDir });

    await repo.transact({ message: 'seed' }, async (tx) => {
      const posts = tx.sheet('posts');
      await posts.upsert({ slug: 'a', title: 'A', body: 'body of A' });
      await posts.upsert({ slug: 'b', title: 'B', body: 'body of B' });
    });

    const posts = await repo.openSheet('posts');
    const all = await posts.queryAll();
    expect(all.length).toBe(2);
    const bySlug = new Map(all.map((r) => [r['slug'], r]));
    expect(bySlug.get('a')?.['title']).toBe('A');
    expect(bySlug.get('a')?.['body']).toBe('body of A');
    expect(bySlug.get('b')?.['body']).toBe('body of B');
  });

  it('normalizes the body through the native dprint formatter on write by default', async () => {
    const fixture = await seedRepoWithPosts();
    const repo = await openRepo({ gitDir: fixture.gitDir });

    await repo.transact({ message: 'add post' }, async (tx) => {
      // dprint rewrites list markers to `-` and single-spaces them.
      await tx.sheet('posts').upsert({
        slug: 'lint',
        title: 'Lint',
        body: '* one\n*  two\n',
      });
    });

    const { stdout: content } = await fixture.git(
      'cat-file',
      'blob',
      'HEAD:posts/lint.md',
    );
    expect(content).toContain('- one\n- two');
    expect(content).not.toContain('*  two');
  });

  it('round-trips records with TOML datetime types in the frontmatter', async () => {
    const fixture = await seedRepoWithPosts();
    const repo = await openRepo({ gitDir: fixture.gitDir });

    await repo.transact({ message: 'dated post' }, async (tx) => {
      await tx.sheet('posts').upsert({
        slug: 'dated',
        title: 'Dated',
        publishedAt: new Date('2024-05-16T10:00:00Z'),
        body: 'hi',
      });
    });

    const posts = await repo.openSheet('posts');
    const r = await posts.queryFirst({ slug: 'dated' });
    expect(r).toBeDefined();
    expect(r!['publishedAt']).toBeInstanceOf(Date);
    expect((r!['publishedAt'] as Date).toISOString()).toBe('2024-05-16T10:00:00.000Z');
  });

  it('delete removes the .md file', async () => {
    const fixture = await seedRepoWithPosts();
    const repo = await openRepo({ gitDir: fixture.gitDir });

    await repo.transact({ message: 'add then delete' }, async (tx) => {
      const posts = tx.sheet('posts');
      await posts.upsert({ slug: 'tmp', title: 'Tmp', body: '' });
    });
    await repo.transact({ message: 'remove tmp' }, async (tx) => {
      await tx.sheet('posts').delete({ slug: 'tmp' });
    });

    const { stdout } = await fixture.git('ls-tree', '-r', '--name-only', 'HEAD');
    expect(stdout).not.toContain('posts/tmp.md');
  });

  it('throws ConfigError when [gitsheet.format].body collides with the path template', async () => {
    const fixture = await testRepo({ withInitialCommit: true });
    handles.push(fixture);
    await mkdir(join(fixture.path, '.gitsheets'), { recursive: true });
    await writeFile(
      join(fixture.path, '.gitsheets', 'bad.toml'),
      `[gitsheet]
root = 'bad'
path = '\${{ body }}'

[gitsheet.format]
type = 'markdown'
body = 'body'
`,
    );
    await fixture.git('add', '.gitsheets/');
    await fixture.git('commit', '-m', 'bad sheet');

    const repo = await openRepo({ gitDir: fixture.gitDir });
    await expect(repo.openSheet('bad')).rejects.toBeInstanceOf(ConfigError);
  });

  it('throws ConfigError when markdown format is missing body field', async () => {
    const fixture = await testRepo({ withInitialCommit: true });
    handles.push(fixture);
    await mkdir(join(fixture.path, '.gitsheets'), { recursive: true });
    await writeFile(
      join(fixture.path, '.gitsheets', 'bad.toml'),
      `[gitsheet]
root = 'bad'
path = '\${{ slug }}'

[gitsheet.format]
type = 'markdown'
`,
    );
    await fixture.git('add', '.gitsheets/');
    await fixture.git('commit', '-m', 'bad sheet');

    const repo = await openRepo({ gitDir: fixture.gitDir });
    await expect(repo.openSheet('bad')).rejects.toBeInstanceOf(ConfigError);
  });

  it('mdx alias produces .mdx files', async () => {
    const fixture = await testRepo({ withInitialCommit: true });
    handles.push(fixture);
    await mkdir(join(fixture.path, '.gitsheets'), { recursive: true });
    await writeFile(
      join(fixture.path, '.gitsheets', 'docs.toml'),
      `[gitsheet]
root = 'docs'
path = '\${{ slug }}'

[gitsheet.format]
type = 'mdx'
body = 'body'
`,
    );
    await fixture.git('add', '.gitsheets/');
    await fixture.git('commit', '-m', 'add docs (mdx)');

    const repo = await openRepo({ gitDir: fixture.gitDir });
    await repo.transact({ message: 'first doc' }, async (tx) => {
      await tx.sheet('docs').upsert({
        slug: 'intro',
        title: 'Intro',
        body: 'mdx body',
      });
    });

    const { stdout } = await fixture.git('ls-tree', '-r', '--name-only', 'HEAD');
    expect(stdout).toContain('docs/intro.mdx');
  });

  it('disables markdownlint when [gitsheet.format.markdownlint] = false', async () => {
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
markdownlint = false
`,
    );
    await fixture.git('add', '.gitsheets/');
    await fixture.git('commit', '-m', 'sheet with lint off');

    const repo = await openRepo({ gitDir: fixture.gitDir });
    await repo.transact({ message: 'unlinted' }, async (tx) => {
      await tx.sheet('posts').upsert({
        slug: 'raw',
        title: 'Raw',
        body: '* one\n*  two\n',
      });
    });

    const { stdout: content } = await fixture.git(
      'cat-file',
      'blob',
      'HEAD:posts/raw.md',
    );
    expect(content).toContain('*  two'); // preserved verbatim
  });
});
