// Smoke tests for the CLI entry. Exercises the public surface end-to-end
// by invoking main() with arg arrays — no subprocess spawn.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { main } from './index.js';
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

describe('CLI: upsert + query + read', () => {
  it('round-trips a record through inline-JSON upsert and query', async () => {
    const fixture = await makeRepoWithUsers();
    const cap = captureStdout();
    let code: number;
    try {
      code = await main([
        '--git-dir',
        fixture.gitDir,
        '--message',
        'add jane',
        'upsert',
        'users',
        '{"slug":"jane","email":"jane@x.org"}',
      ]);
    } finally {
      cap.restore();
    }
    expect(code).toBe(0);

    const queryCap = captureStdout();
    let qcode: number;
    try {
      qcode = await main(['--git-dir', fixture.gitDir, 'query', 'users']);
    } finally {
      const out = queryCap.restore();
      expect(out).toContain('"slug":"jane"');
      expect(out).toContain('"email":"jane@x.org"');
    }
    expect(qcode).toBe(0);
  });

  it('reads a record by path', async () => {
    const fixture = await makeRepoWithUsers();
    // First upsert
    captureStdout().restore();
    await main([
      '--git-dir',
      fixture.gitDir,
      '--message',
      'add jane',
      'upsert',
      'users',
      '{"slug":"jane","email":"jane@x.org"}',
    ]);

    const cap = captureStdout();
    let code: number;
    try {
      code = await main(['--git-dir', fixture.gitDir, 'read', 'users', 'jane']);
    } finally {
      const out = cap.restore();
      expect(out).toContain('"slug": "jane"');
    }
    expect(code).toBe(0);
  });

  it('applies --filter to query', async () => {
    const fixture = await makeRepoWithUsers();
    captureStdout().restore();
    await main([
      '--git-dir',
      fixture.gitDir,
      '--message',
      'seed',
      'upsert',
      'users',
      '[{"slug":"a","team":"eng"},{"slug":"b","team":"design"}]',
    ]);

    const cap = captureStdout();
    try {
      await main(['--git-dir', fixture.gitDir, 'query', 'users', '--filter', 'team=eng']);
    } finally {
      const out = cap.restore();
      expect(out).toContain('"slug":"a"');
      expect(out).not.toContain('"slug":"b"');
    }
  });
});
