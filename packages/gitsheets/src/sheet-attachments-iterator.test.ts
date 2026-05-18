// Sheet.attachments iterator (#140).

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

async function seedRepo(): Promise<TestRepoHandle> {
  const fixture = await testRepo({ withInitialCommit: true });
  handles.push(fixture);
  await mkdir(join(fixture.path, '.gitsheets'), { recursive: true });
  await writeFile(
    join(fixture.path, '.gitsheets', 'users.toml'),
    `[gitsheet]\nroot = 'users'\npath = '\${{ slug }}'\n`,
  );
  await fixture.git('add', '.gitsheets/');
  await fixture.git('commit', '-m', 'add users sheet');
  return fixture;
}

describe('Sheet.attachments iterator', () => {
  it('yields attachments with inferred mime types and blob handles', async () => {
    const fixture = await seedRepo();
    const repo = await openRepo({ gitDir: fixture.gitDir });

    await repo.transact({ message: 'seed' }, async (tx) => {
      const sheet = tx.sheet('users');
      await sheet.upsert({ slug: 'jane' });
      await sheet.setAttachments({ slug: 'jane' }, {
        'avatar.jpg': 'JPEG-DATA',
        'bio.md': '# Hi',
        'binary.dat': 'BIN',
      });
    });

    const users = await repo.openSheet('users');
    const out: Array<{ name: string; mimeType: string; bytes: string }> = [];
    for await (const entry of users.attachments({ slug: 'jane' })) {
      const buf = await entry.blob.read();
      out.push({ name: entry.name, mimeType: entry.mimeType, bytes: buf.toString('utf8') });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    expect(out).toEqual([
      { name: 'avatar.jpg', mimeType: 'image/jpeg', bytes: 'JPEG-DATA' },
      { name: 'binary.dat', mimeType: 'application/octet-stream', bytes: 'BIN' },
      { name: 'bio.md', mimeType: 'text/markdown', bytes: '# Hi' },
    ]);
  });

  it('blob.stream() returns a Readable carrying the bytes', async () => {
    const fixture = await seedRepo();
    const repo = await openRepo({ gitDir: fixture.gitDir });

    await repo.transact({ message: 'seed' }, async (tx) => {
      const sheet = tx.sheet('users');
      await sheet.upsert({ slug: 'jane' });
      await sheet.setAttachment({ slug: 'jane' }, 'doc.txt', 'hello world');
    });

    const users = await repo.openSheet('users');
    for await (const entry of users.attachments({ slug: 'jane' })) {
      const chunks: Buffer[] = [];
      const stream = entry.blob.stream();
      for await (const chunk of stream) {
        chunks.push(chunk as Buffer);
      }
      expect(Buffer.concat(chunks).toString('utf8')).toBe('hello world');
    }
  });

  it('yields nothing for a record with no attachment directory', async () => {
    const fixture = await seedRepo();
    const repo = await openRepo({ gitDir: fixture.gitDir });
    await repo.transact({ message: 'seed' }, async (tx) => {
      await tx.sheet('users').upsert({ slug: 'jane' });
    });

    const users = await repo.openSheet('users');
    const entries = [];
    for await (const e of users.attachments({ slug: 'jane' })) entries.push(e);
    expect(entries).toEqual([]);
  });
});
