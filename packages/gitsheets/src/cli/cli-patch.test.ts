// CLI upsert --patch (#149): RFC 7396 merge-patch on existing records.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { main } from './index.js';
import { openRepo } from '../repository.js';
import { testRepo, type TestRepoHandle } from '../test-helpers/test-repo.js';

const handles: TestRepoHandle[] = [];
afterEach(async () => {
  while (handles.length > 0) {
    const h = handles.pop();
    if (h) await h.cleanup();
  }
});

async function makeRepoWithUsers(): Promise<TestRepoHandle> {
  const h = await testRepo({ withInitialCommit: true });
  handles.push(h);
  await mkdir(join(h.path, '.gitsheets'), { recursive: true });
  await writeFile(
    join(h.path, '.gitsheets', 'users.toml'),
    `[gitsheet]\nroot = 'users'\npath = '\${{ slug }}'\n`,
  );
  await h.git('add', '.gitsheets/');
  await h.git('commit', '-m', 'add users sheet');
  return h;
}

async function makeRepoWithCompositePath(): Promise<TestRepoHandle> {
  const h = await testRepo({ withInitialCommit: true });
  handles.push(h);
  await mkdir(join(h.path, '.gitsheets'), { recursive: true });
  await writeFile(
    join(h.path, '.gitsheets', 'memberships.toml'),
    `[gitsheet]\nroot = 'memberships'\npath = '\${{ org }}/\${{ user }}'\n`,
  );
  await h.git('add', '.gitsheets/');
  await h.git('commit', '-m', 'add memberships sheet');
  return h;
}

function captureStdout(): { restore: () => string } {
  const original = process.stdout.write.bind(process.stdout);
  const chunks: string[] = [];
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stdout.write;
  return {
    restore: () => {
      process.stdout.write = original;
      return chunks.join('');
    },
  };
}

describe('CLI upsert --patch', () => {
  it('applies RFC 7396 merge semantics: replace + delete (null)', async () => {
    const fixture = await makeRepoWithUsers();

    // Seed jane with email + bio
    captureStdout().restore();
    await main([
      '--git-dir',
      fixture.gitDir,
      '--message',
      'seed',
      'upsert',
      'users',
      '{"slug":"jane","email":"jane@x.org","bio":"hello"}',
    ]);

    // Patch: change email, delete bio (null), add new field
    captureStdout().restore();
    await main([
      '--git-dir',
      fixture.gitDir,
      '--message',
      'patch jane',
      'upsert',
      'users',
      '{"slug":"jane","email":"jane@y.org","bio":null,"team":"eng"}',
      '--patch',
    ]);

    const repo = await openRepo({ gitDir: fixture.gitDir });
    const sheet = await repo.openSheet('users');
    const jane = await sheet.queryFirst({ slug: 'jane' });
    expect(jane).toBeDefined();
    expect(jane!['email']).toBe('jane@y.org');
    expect(jane!['bio']).toBeUndefined();
    expect(jane!['team']).toBe('eng');
    expect(jane!['slug']).toBe('jane');
  });

  it('auto-derives a multi-field query from a composite path template', async () => {
    const fixture = await makeRepoWithCompositePath();

    captureStdout().restore();
    await main([
      '--git-dir',
      fixture.gitDir,
      '--message',
      'seed',
      'upsert',
      'memberships',
      '{"org":"acme","user":"jane","role":"member"}',
    ]);

    // Patch the role; org+user should be split into the query.
    captureStdout().restore();
    await main([
      '--git-dir',
      fixture.gitDir,
      '--message',
      'promote jane',
      'upsert',
      'memberships',
      '{"org":"acme","user":"jane","role":"admin"}',
      '--patch',
    ]);

    const repo = await openRepo({ gitDir: fixture.gitDir });
    const sheet = await repo.openSheet('memberships');
    const jane = await sheet.queryFirst({ org: 'acme', user: 'jane' });
    expect(jane!['role']).toBe('admin');
  });

  it('errors when the input lacks any path-template field', async () => {
    const fixture = await makeRepoWithUsers();

    captureStdout().restore();
    await main([
      '--git-dir',
      fixture.gitDir,
      '--message',
      'seed',
      'upsert',
      'users',
      '{"slug":"jane"}',
    ]);

    let code: number;
    const cap = captureStdout();
    try {
      code = await main([
        '--git-dir',
        fixture.gitDir,
        '--message',
        'bad patch',
        'upsert',
        'users',
        '{"email":"jane@x.org"}',
        '--patch',
      ]);
    } finally {
      cap.restore();
    }
    expect(code).not.toBe(0);
  });

  it('rejects --patch combined with --delete-missing', async () => {
    const fixture = await makeRepoWithUsers();
    let code: number;
    const cap = captureStdout();
    try {
      code = await main([
        '--git-dir',
        fixture.gitDir,
        '--message',
        'no',
        'upsert',
        'users',
        '{"slug":"x"}',
        '--patch',
        '--delete-missing',
      ]);
    } finally {
      cap.restore();
    }
    expect(code).not.toBe(0);
  });
});
