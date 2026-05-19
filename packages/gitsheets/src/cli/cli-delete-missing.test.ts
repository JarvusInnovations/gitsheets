// CLI `upsert --delete-missing` (#146): full-replace mode.

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

describe('CLI upsert --delete-missing', () => {
  it('replaces the sheet contents with the input set', async () => {
    const fixture = await makeRepoWithUsers();

    // Seed with 3 records
    captureStdout().restore();
    await main([
      '--git-dir',
      fixture.gitDir,
      '--message',
      'seed',
      'upsert',
      'users',
      '[{"slug":"a"},{"slug":"b"},{"slug":"c"}]',
    ]);

    // Full-replace with 2 records (b and d)
    captureStdout().restore();
    await main([
      '--git-dir',
      fixture.gitDir,
      '--message',
      'replace',
      'upsert',
      'users',
      '[{"slug":"b"},{"slug":"d"}]',
      '--delete-missing',
    ]);

    // Verify: a and c are gone, b and d remain
    const repo = await openRepo({ gitDir: fixture.gitDir });
    const sheet = await repo.openSheet('users');
    const slugs: string[] = [];
    for await (const r of sheet.query()) {
      slugs.push(r['slug'] as string);
    }
    expect(slugs.sort()).toEqual(['b', 'd']);
  });

  it('aborts on validation failure leaving the tree unchanged', async () => {
    const fixture = await makeRepoWithUsers();
    // Write a schema that requires slug to be string with minLength 1
    await writeFile(
      join(fixture.path, '.gitsheets', 'users.toml'),
      `[gitsheet]
root = 'users'
path = '\${{ slug }}'

[gitsheet.schema]
type = 'object'

[gitsheet.schema.properties.slug]
type = 'string'
minLength = 1
`,
    );
    await fixture.git('add', '.gitsheets/users.toml');
    await fixture.git('commit', '-m', 'add schema');

    captureStdout().restore();
    await main([
      '--git-dir',
      fixture.gitDir,
      '--message',
      'seed',
      'upsert',
      'users',
      '[{"slug":"a"},{"slug":"b"}]',
    ]);

    const beforeHead = (await (await openRepo({ gitDir: fixture.gitDir })).resolveRef('HEAD'))!;

    // Replace including an invalid record — second one violates minLength.
    captureStdout().restore();
    let code: number;
    try {
      code = await main([
        '--git-dir',
        fixture.gitDir,
        '--message',
        'bad replace',
        'upsert',
        'users',
        '[{"slug":"keep"},{"slug":""}]',
        '--delete-missing',
      ]);
    } catch {
      code = 99;
    }
    expect(code).not.toBe(0);

    // HEAD didn't move
    const afterHead = await (await openRepo({ gitDir: fixture.gitDir })).resolveRef('HEAD');
    expect(afterHead).toBe(beforeHead);
  });
});
