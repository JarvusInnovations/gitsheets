// CLI upsert --attachment (#147): attach files alongside a record.

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

describe('CLI upsert --attachment', () => {
  it('attaches a file alongside the upserted record in the same transaction', async () => {
    const fixture = await makeRepoWithUsers();
    const avatarPath = join(fixture.path, 'avatar.bin');
    const avatarBytes = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0xff]);
    await writeFile(avatarPath, avatarBytes);

    captureStdout().restore();
    await main([
      '--git-dir',
      fixture.gitDir,
      '--message',
      'add jane with avatar',
      'upsert',
      'users',
      '{"slug":"jane"}',
      '--attachment',
      `avatar.bin=${avatarPath}`,
    ]);

    const repo = await openRepo({ gitDir: fixture.gitDir });
    const sheet = await repo.openSheet('users');
    const attachments = await sheet.getAttachments({ slug: 'jane' });
    expect(attachments).not.toBeNull();
    expect(Object.keys(attachments!).sort()).toEqual(['avatar.bin']);

    // Verify the bytes round-trip by comparing git's content-addressable hash.
    // `git hash-object <file>` is deterministic on the bytes, so a matching
    // hash proves the attachment blob equals the source file byte-for-byte.
    const { stdout: expectedHash } = await fixture.git('hash-object', avatarPath);
    expect(attachments!['avatar.bin']!.hash).toBe(expectedHash.trim());
  });

  it('supports multiple --attachment flags', async () => {
    const fixture = await makeRepoWithUsers();
    const a = join(fixture.path, 'a.txt');
    const b = join(fixture.path, 'b.txt');
    await writeFile(a, 'aaa');
    await writeFile(b, 'bbb');

    captureStdout().restore();
    await main([
      '--git-dir',
      fixture.gitDir,
      '--message',
      'add jane with two files',
      'upsert',
      'users',
      '{"slug":"jane"}',
      '--attachment',
      `a.txt=${a}`,
      '--attachment',
      `b.txt=${b}`,
    ]);

    const repo = await openRepo({ gitDir: fixture.gitDir });
    const sheet = await repo.openSheet('users');
    const attachments = await sheet.getAttachments({ slug: 'jane' });
    expect(Object.keys(attachments!).sort()).toEqual(['a.txt', 'b.txt']);
  });

  it('rejects --attachment with a multi-record input', async () => {
    const fixture = await makeRepoWithUsers();
    const a = join(fixture.path, 'a.txt');
    await writeFile(a, 'aaa');

    const cap = captureStdout();
    let code: number;
    try {
      code = await main([
        '--git-dir',
        fixture.gitDir,
        '--message',
        'too many',
        'upsert',
        'users',
        '[{"slug":"x"},{"slug":"y"}]',
        '--attachment',
        `a.txt=${a}`,
      ]);
    } finally {
      cap.restore();
    }
    expect(code).not.toBe(0);
  });

  it('resolves attachment paths relative to the input file directory', async () => {
    const fixture = await makeRepoWithUsers();
    const subDir = join(fixture.path, 'inputs');
    await mkdir(subDir, { recursive: true });
    const inputPath = join(subDir, 'jane.json');
    await writeFile(inputPath, '{"slug":"jane"}');
    await writeFile(join(subDir, 'avatar.png'), 'PNG-BYTES');

    captureStdout().restore();
    await main([
      '--git-dir',
      fixture.gitDir,
      '--message',
      'relative paths',
      'upsert',
      'users',
      inputPath,
      '--attachment',
      'avatar.png=avatar.png',
    ]);

    const repo = await openRepo({ gitDir: fixture.gitDir });
    const sheet = await repo.openSheet('users');
    const attachments = await sheet.getAttachments({ slug: 'jane' });
    expect(Object.keys(attachments!)).toContain('avatar.png');
  });
});
