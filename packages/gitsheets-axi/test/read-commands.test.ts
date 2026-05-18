// AXI read-only commands: home, sheets, query, read.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openRepo } from 'gitsheets';

import { testRepo, type TestRepoHandle } from './test-repo.js';
import { runCli } from './run-cli.js';

const handles: TestRepoHandle[] = [];
afterEach(async () => {
  while (handles.length > 0) {
    const h = handles.pop();
    if (h) await h.cleanup();
  }
});

const USERS_TOML = `[gitsheet]
root = 'users'
path = '\${{ slug }}'

[gitsheet.schema]
type = 'object'
required = ['slug', 'email']

[gitsheet.schema.properties.slug]
type = 'string'

[gitsheet.schema.properties.email]
type = 'string'

[gitsheet.schema.properties.name]
type = 'string'
`;

const POSTS_TOML = `[gitsheet]
root = 'posts'
path = '\${{ slug }}'

[gitsheet.format]
type = 'markdown'
body = 'body'

[gitsheet.schema]
type = 'object'
required = ['slug', 'title']

[gitsheet.schema.properties.slug]
type = 'string'

[gitsheet.schema.properties.title]
type = 'string'

[gitsheet.schema.properties.body]
type = 'string'
`;

async function seedRepo({ withRecords = false }: { withRecords?: boolean } = {}): Promise<TestRepoHandle> {
  const fixture = await testRepo({ withInitialCommit: true });
  handles.push(fixture);
  await mkdir(join(fixture.path, '.gitsheets'), { recursive: true });
  await writeFile(join(fixture.path, '.gitsheets', 'users.toml'), USERS_TOML);
  await writeFile(join(fixture.path, '.gitsheets', 'posts.toml'), POSTS_TOML);
  await fixture.git('add', '.gitsheets/');
  await fixture.git('commit', '-m', 'add sheets');

  if (withRecords) {
    const repo = await openRepo({ gitDir: fixture.gitDir });
    await repo.transact({ message: 'seed users' }, async (tx) => {
      await tx.sheet('users').upsert({
        slug: 'jane',
        email: 'jane@x.org',
        name: 'Jane Doe',
      });
      await tx.sheet('users').upsert({
        slug: 'bob',
        email: 'bob@x.org',
        name: 'Bob Smith',
      });
    });
    await repo.transact({ message: 'seed posts' }, async (tx) => {
      await tx.sheet('posts').upsert({
        slug: 'hello',
        title: 'Hello World',
        body: '# Hello\n\nA short post.\n',
      });
      await tx.sheet('posts').upsert({
        slug: 'long',
        title: 'A Long Post',
        body: '# Long\n\n' + 'word '.repeat(200),
      });
    });
  }

  return fixture;
}

describe('home', () => {
  it('emits sheets table when inside a repo with sheets', async () => {
    const fixture = await seedRepo();
    const { stdout, exitCode } = await runCli([], fixture.path);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('sheets[2]');
    expect(stdout).toContain('users');
    expect(stdout).toContain('posts');
  });

  it('surfaces record counts in home', async () => {
    const fixture = await seedRepo({ withRecords: true });
    const { stdout } = await runCli([], fixture.path);
    // 2 users + 2 posts; counts render as quoted strings (TOON column).
    expect(stdout).toMatch(/users,toml,"2"/);
    expect(stdout).toMatch(/posts,markdown,"2"/);
  });
});

describe('sheets', () => {
  it('list shows every sheet', async () => {
    const fixture = await seedRepo({ withRecords: true });
    const { stdout, exitCode } = await runCli(['sheets'], fixture.path);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('sheets[2]');
  });

  it('view shows the sheet config + schema', async () => {
    const fixture = await seedRepo({ withRecords: true });
    const { stdout, exitCode } = await runCli(['sheets', 'view', 'users'], fixture.path);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('sheet:');
    expect(stdout).toContain('name: users');
    expect(stdout).toContain('records: 2');
    expect(stdout).toContain('path_fields: slug');
    expect(stdout).toContain('schema:');
  });

  it('view shows body_field for content-typed sheets', async () => {
    const fixture = await seedRepo({ withRecords: true });
    const { stdout } = await runCli(['sheets', 'view', 'posts'], fixture.path);
    expect(stdout).toContain('format: markdown');
    expect(stdout).toContain('body_field: body');
  });

  it('view errors out when sheet is missing', async () => {
    const fixture = await seedRepo();
    const { stdout, exitCode } = await runCli(
      ['sheets', 'view', 'nonexistent'],
      fixture.path,
    );
    expect(exitCode).not.toBe(0);
    expect(stdout).toContain('error:');
  });
});

describe('query', () => {
  it('lists records with the default schema', async () => {
    const fixture = await seedRepo({ withRecords: true });
    const { stdout, exitCode } = await runCli(['query', 'users'], fixture.path);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('count: 2 of 2 total');
    expect(stdout).toContain('records[2]');
    expect(stdout).toContain('jane');
    expect(stdout).toContain('bob');
  });

  it('filters via --filter k=v', async () => {
    const fixture = await seedRepo({ withRecords: true });
    const { stdout } = await runCli(
      ['query', 'users', '--filter', 'slug=jane'],
      fixture.path,
    );
    expect(stdout).toContain('count: 1 of 1 total');
    expect(stdout).toContain('jane');
    expect(stdout).not.toContain('bob');
  });

  it('content-typed sheet shows body_size, not body content', async () => {
    const fixture = await seedRepo({ withRecords: true });
    const { stdout } = await runCli(['query', 'posts'], fixture.path);
    expect(stdout).toContain('body_size');
    expect(stdout).not.toContain('A short post');
    expect(stdout).not.toContain('word word word');
  });

  it('extra --fields columns append after defaults', async () => {
    const fixture = await seedRepo({ withRecords: true });
    const { stdout } = await runCli(
      ['query', 'users', '--fields', 'email'],
      fixture.path,
    );
    expect(stdout).toContain('email');
    expect(stdout).toContain('jane@x.org');
  });

  it('emits a definitive empty state when no records match', async () => {
    const fixture = await seedRepo({ withRecords: true });
    const { stdout } = await runCli(
      ['query', 'users', '--filter', 'slug=nobody'],
      fixture.path,
    );
    expect(stdout).toMatch(/records: 0 records found|no records/);
  });
});

describe('read', () => {
  it('shows a single record', async () => {
    const fixture = await seedRepo({ withRecords: true });
    const { stdout, exitCode } = await runCli(['read', 'users', 'jane'], fixture.path);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('record:');
    expect(stdout).toContain('jane@x.org');
    expect(stdout).toContain('Jane Doe');
    expect(stdout).toContain('_path: jane');
  });

  it('truncates body content on markdown sheets by default', async () => {
    const fixture = await seedRepo({ withRecords: true });
    const { stdout } = await runCli(['read', 'posts', 'long'], fixture.path);
    expect(stdout).toContain('(truncated');
    expect(stdout).toContain('--full');
  });

  it('--full shows untruncated body', async () => {
    const fixture = await seedRepo({ withRecords: true });
    const { stdout } = await runCli(
      ['read', 'posts', 'long', '--full'],
      fixture.path,
    );
    expect(stdout).not.toContain('(truncated');
  });

  it('returns a NOT_FOUND error for missing records', async () => {
    const fixture = await seedRepo({ withRecords: true });
    const { stdout, exitCode } = await runCli(
      ['read', 'users', 'nobody'],
      fixture.path,
    );
    expect(exitCode).not.toBe(0);
    expect(stdout).toContain('error:');
    expect(stdout).toMatch(/no record at|NOT_FOUND/);
  });

  it('errors out without two positional args', async () => {
    const fixture = await seedRepo();
    const { stdout, exitCode } = await runCli(['read', 'users'], fixture.path);
    expect(exitCode).not.toBe(0);
    expect(stdout).toContain('error:');
  });
});
