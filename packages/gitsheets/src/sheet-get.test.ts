// Sheet.get — read one record by its rendered path with a single blob read.
// See specs/api/sheet.md#sheetgetpath-opts.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openRepo } from './repository.js';
import { RECORD_PATH_KEY } from './sheet.js';
import { testRepo, type TestRepoHandle } from './test-helpers/test-repo.js';

const handles: TestRepoHandle[] = [];
afterEach(async () => {
  while (handles.length > 0) {
    const h = handles.pop();
    if (h) await h.cleanup();
  }
});

async function makeRepo(configs: Record<string, string>): Promise<TestRepoHandle> {
  const fixture = await testRepo({ withInitialCommit: true });
  handles.push(fixture);
  await mkdir(join(fixture.path, '.gitsheets'), { recursive: true });
  for (const [name, toml] of Object.entries(configs)) {
    await writeFile(join(fixture.path, '.gitsheets', `${name}.toml`), toml);
  }
  await fixture.git('add', '.gitsheets/');
  await fixture.git('commit', '-m', 'add sheets');
  return fixture;
}

const USERS = `[gitsheet]
root = 'users'
path = '\${{ domain }}/\${{ username }}'
`;
const POSTS = `[gitsheet]
root = 'posts'
path = '\${{ slug }}'

[gitsheet.format]
type = 'markdown'
body = 'body'
`;

describe('Sheet.get', () => {
  it('reads one TOML record by rendered path, with the path annotation', async () => {
    const fixture = await makeRepo({ users: USERS });
    const repo = await openRepo({ gitDir: fixture.gitDir });
    await repo.transact({ message: 'seed' }, async (tx) => {
      await tx.sheet('users').upsert({ domain: 'af.mil', username: 'jane', age: 30 });
      await tx.sheet('users').upsert({ domain: 'navy.mil', username: 'bob', age: 41 });
    });
    const users = await repo.openSheet('users');
    const jane = await users.get('af.mil/jane');
    expect(jane).toMatchObject({ domain: 'af.mil', username: 'jane', age: 30 });
    expect((jane as Record<symbol, unknown>)[RECORD_PATH_KEY]).toBe('af.mil/jane');
    expect(await users.get('af.mil/nobody')).toBeUndefined();
    // A subtree is not a record.
    expect(await users.get('af.mil')).toBeUndefined();
  });

  it('honors withBody on content-typed sheets', async () => {
    const fixture = await makeRepo({ posts: POSTS });
    const repo = await openRepo({ gitDir: fixture.gitDir });
    await repo.transact({ message: 'seed' }, async (tx) => {
      await tx.sheet('posts').upsert({ slug: 'hello', title: 'Hi', body: '# Hi\n\nA post.\n' });
    });
    const posts = await repo.openSheet('posts');
    const full = await posts.get('hello');
    expect(full?.['body']).toBe('# Hi\n\nA post.');
    const lazy = await posts.get('hello', { withBody: false });
    expect(lazy?.['title']).toBe('Hi');
    expect(lazy?.['body']).toBeUndefined();
    // loadBody hydrates the body-less record.
    expect((await posts.loadBody(lazy!))['body']).toBe('# Hi\n\nA post.');
  });

  it('sees records staged earlier in the same transaction', async () => {
    const fixture = await makeRepo({ posts: POSTS });
    const repo = await openRepo({ gitDir: fixture.gitDir });
    await repo.transact({ message: 'seed' }, async (tx) => {
      await tx.sheet('posts').upsert({ slug: 'a', body: '# A\n' });
      const staged = await tx.sheet('posts').get('a');
      expect(staged?.['body']).toBe('# A');
      expect((staged as Record<symbol, unknown>)[RECORD_PATH_KEY]).toBe('a');
      expect(await tx.sheet('posts').get('zzz')).toBeUndefined();
      // Outside the transaction the committed tree doesn't have it yet.
      const outside = await repo.openSheet('posts');
      expect(await outside.get('a')).toBeUndefined();
    });
    const posts = await repo.openSheet('posts');
    expect((await posts.get('a'))?.['slug']).toBe('a');
  });

  it('is not fooled by an attachment path', async () => {
    const fixture = await makeRepo({ users: USERS });
    const repo = await openRepo({ gitDir: fixture.gitDir });
    await repo.transact({ message: 'seed' }, async (tx) => {
      await tx.sheet('users').upsert({ domain: 'af.mil', username: 'jane' });
      await tx.sheet('users').setAttachment('af.mil/jane', 'avatar.png', Buffer.from('png'));
    });
    const users = await repo.openSheet('users');
    expect(await users.get('af.mil/jane/avatar.png')).toBeUndefined();
    expect(await users.get('af.mil/jane')).toBeDefined();
  });
});
