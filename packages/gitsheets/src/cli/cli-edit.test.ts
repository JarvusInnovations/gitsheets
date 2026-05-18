// CLI `edit` command (#150): $EDITOR round-trip on a single record.

import { chmod, mkdir, writeFile } from 'node:fs/promises';
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

/**
 * Write a sed-based fake editor that rewrites the tmpfile in place. Used as
 * $EDITOR — when spawned with the tmpfile path, it edits the file and exits.
 */
async function makeSedEditor(workDir: string, sedScript: string): Promise<string> {
  const editorPath = join(workDir, 'fake-editor.sh');
  await writeFile(editorPath, `#!/bin/sh\nset -e\nsed -i.bak "${sedScript}" "$1"\nrm -f "$1.bak"\n`);
  await chmod(editorPath, 0o755);
  return editorPath;
}

describe('CLI edit', () => {
  it('round-trips: open record, change a field, save, commit', async () => {
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

    // Fake editor flips the email
    const editor = await makeSedEditor(
      fixture.path,
      `s/jane@x\\.org/jane@y.org/`,
    );

    const oldEditor = process.env['EDITOR'];
    process.env['EDITOR'] = editor;
    try {
      captureStdout().restore();
      await main([
        '--git-dir',
        fixture.gitDir,
        '--message',
        'edit jane',
        'edit',
        'users',
        'jane',
      ]);
    } finally {
      if (oldEditor === undefined) delete process.env['EDITOR'];
      else process.env['EDITOR'] = oldEditor;
    }

    const repo = await openRepo({ gitDir: fixture.gitDir });
    const sheet = await repo.openSheet('users');
    const jane = await sheet.queryFirst({ slug: 'jane' });
    expect(jane!['email']).toBe('jane@y.org');
  });

  it('no-op when the editor exits without changes', async () => {
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

    const repo = await openRepo({ gitDir: fixture.gitDir });
    const headBefore = await repo.resolveRef('HEAD');

    // EDITOR that exits 0 without modifying the file
    const editor = join(fixture.path, 'noop-editor.sh');
    await writeFile(editor, `#!/bin/sh\nexit 0\n`);
    await chmod(editor, 0o755);

    const oldEditor = process.env['EDITOR'];
    process.env['EDITOR'] = editor;
    try {
      await main(['--git-dir', fixture.gitDir, 'edit', 'users', 'jane']);
    } finally {
      if (oldEditor === undefined) delete process.env['EDITOR'];
      else process.env['EDITOR'] = oldEditor;
    }

    const repo2 = await openRepo({ gitDir: fixture.gitDir });
    const headAfter = await repo2.resolveRef('HEAD');
    expect(headAfter).toBe(headBefore);
  });

  it('throws NotFoundError when the path does not exist', async () => {
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
        'edit',
        'users',
        'nonexistent',
      ]);
    } finally {
      cap.restore();
    }
    expect(code).toBe(66); // NotFoundError exit code
  });
});
