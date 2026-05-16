// CLI --format / --encoding round-trip tests (#145).

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

describe('CLI --format / --encoding', () => {
  it('upsert reads CSV input and query outputs CSV', async () => {
    const fixture = await makeRepoWithUsers();

    const csvPath = join(fixture.path, 'users.csv');
    await writeFile(
      csvPath,
      'slug,email,team\njane,jane@x.org,eng\npat,pat@x.org,design\n',
    );

    captureStdout().restore();
    await main([
      '--git-dir',
      fixture.gitDir,
      '--message',
      'csv import',
      'upsert',
      'users',
      csvPath,
      '--format',
      'csv',
    ]);

    const cap = captureStdout();
    try {
      await main([
        '--git-dir',
        fixture.gitDir,
        'query',
        'users',
        '--format',
        'csv',
        '--fields',
        'slug',
        'email',
        'team',
      ]);
    } finally {
      const out = cap.restore();
      // header + 2 records
      const lines = out.trim().split('\n');
      expect(lines[0]).toBe('slug,email,team');
      expect(lines.length).toBe(3);
      expect(lines.slice(1).sort()).toEqual([
        'jane,jane@x.org,eng',
        'pat,pat@x.org,design',
      ].sort());
    }
  });

  it('query emits TSV when --format=tsv', async () => {
    const fixture = await makeRepoWithUsers();
    captureStdout().restore();
    await main([
      '--git-dir',
      fixture.gitDir,
      '--message',
      'seed',
      'upsert',
      'users',
      '{"slug":"jane","email":"jane@x.org"}',
    ]);

    const cap = captureStdout();
    try {
      await main([
        '--git-dir',
        fixture.gitDir,
        'query',
        'users',
        '--format',
        'tsv',
        '--fields',
        'slug',
        'email',
      ]);
    } finally {
      const out = cap.restore();
      const lines = out.trim().split('\n');
      expect(lines[0]).toBe('slug\temail');
      expect(lines[1]).toBe('jane\tjane@x.org');
    }
  });

  it('upsert accepts TOML input ([[records]] array)', async () => {
    const fixture = await makeRepoWithUsers();
    const tomlText = `
[[records]]
slug = 'jane'
email = 'jane@x.org'

[[records]]
slug = 'pat'
email = 'pat@x.org'
`;
    const tomlPath = join(fixture.path, 'users.toml');
    await writeFile(tomlPath, tomlText);

    captureStdout().restore();
    await main([
      '--git-dir',
      fixture.gitDir,
      '--message',
      'toml import',
      'upsert',
      'users',
      tomlPath,
      '--format',
      'toml',
    ]);

    const cap = captureStdout();
    try {
      await main(['--git-dir', fixture.gitDir, 'query', 'users']);
    } finally {
      const out = cap.restore();
      expect(out).toContain('"slug":"jane"');
      expect(out).toContain('"slug":"pat"');
    }
  });

  it('read --format=toml emits TOML', async () => {
    const fixture = await makeRepoWithUsers();
    captureStdout().restore();
    await main([
      '--git-dir',
      fixture.gitDir,
      '--message',
      'seed',
      'upsert',
      'users',
      '{"slug":"jane","email":"jane@x.org"}',
    ]);

    const cap = captureStdout();
    try {
      await main(['--git-dir', fixture.gitDir, 'read', 'users', 'jane', '--format', 'toml']);
    } finally {
      const out = cap.restore();
      // Either `email = 'jane@x.org'` or `email = "jane@x.org"` is fine
      expect(out).toMatch(/email = ['"]jane@x\.org['"]/);
      expect(out).toMatch(/slug = ['"]jane['"]/);
    }
  });

  it('query --headers=false suppresses the header row', async () => {
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

    const cap = captureStdout();
    try {
      await main([
        '--git-dir',
        fixture.gitDir,
        'query',
        'users',
        '--format',
        'csv',
        '--fields',
        'slug',
        '--no-headers',
      ]);
    } finally {
      const out = cap.restore();
      expect(out.trim()).toBe('jane');
    }
  });

  it('rejects an unknown --format', async () => {
    const fixture = await makeRepoWithUsers();
    const cap = captureStdout();
    let code: number;
    try {
      code = await main([
        '--git-dir',
        fixture.gitDir,
        'query',
        'users',
        '--format',
        'nonsense',
      ]);
    } finally {
      cap.restore();
    }
    expect(code).not.toBe(0);
  });
});
