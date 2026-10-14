// Streaming blob reads by key/path — repo.readBlobStream + sheet.getAttachmentStream.
// See specs/behaviors/attachments.md#streaming-reads-by-keypath.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';

import { afterEach, describe, expect, it } from 'vitest';

import { NotFoundError, RefError } from './errors.js';
import { openRepo, type Repository } from './repository.js';
import { testRepo, type TestRepoHandle } from './test-helpers/test-repo.js';
import { STREAM_INLINE_LIMIT } from './working-tree.js';

const handles: TestRepoHandle[] = [];
afterEach(async () => {
  while (handles.length > 0) {
    const h = handles.pop();
    if (h) await h.cleanup();
  }
});

const USERS = `[gitsheet]
root = 'users'
path = '\${{ slug }}'
`;

async function seededRepo(): Promise<{ fixture: TestRepoHandle; repo: Repository }> {
  const fixture = await testRepo({ withInitialCommit: true });
  handles.push(fixture);
  await mkdir(join(fixture.path, '.gitsheets'), { recursive: true });
  await writeFile(join(fixture.path, '.gitsheets', 'users.toml'), USERS);
  await fixture.git('add', '.gitsheets/');
  await fixture.git('commit', '-m', 'add users sheet');
  const repo = await openRepo({ gitDir: fixture.gitDir });
  return { fixture, repo };
}

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/** Binary bytes (not valid UTF-8) to prove byte fidelity end-to-end. */
const BINARY = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x0a, 0x1b]);

async function commitAvatar(repo: Repository, bytes: Buffer): Promise<void> {
  await repo.transact({ message: 'avatar' }, async (tx) => {
    const sheet = tx.sheet('users');
    await sheet.upsert({ slug: 'jane' });
    const blob = await repo.writeBlob(bytes);
    await sheet.setAttachment('jane', 'avatar.png', blob);
  });
}

describe('repo.readBlobStream', () => {
  it('streams byte-identical content for a committed attachment', async () => {
    const { repo } = await seededRepo();
    await commitAvatar(repo, BINARY);

    const stream = await repo.readBlobStream('HEAD', 'users/jane/avatar.png');
    expect(Buffer.compare(await collect(stream), BINARY)).toBe(0);
  });

  it('resolves the ref at call time — a later commit is immediately visible', async () => {
    const { repo } = await seededRepo();
    await commitAvatar(repo, Buffer.from('v1'));
    await commitAvatar(repo, Buffer.from('v2'));

    const stream = await repo.readBlobStream('HEAD', 'users/jane/avatar.png');
    expect((await collect(stream)).toString()).toBe('v2');
  });

  it('throws NotFoundError(record_not_found) for a missing path', async () => {
    const { repo } = await seededRepo();
    const err = await repo.readBlobStream('HEAD', 'users/nope/avatar.png').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect((err as NotFoundError).code).toBe('record_not_found');
  });

  it('throws NotFoundError(record_not_found) for a directory path', async () => {
    const { repo } = await seededRepo();
    await commitAvatar(repo, BINARY);
    const err = await repo.readBlobStream('HEAD', 'users/jane').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundError);
  });

  it('throws RefError(ref_not_found) for a ref that does not resolve', async () => {
    const { repo } = await seededRepo();
    const err = await repo.readBlobStream('no-such-ref', 'users/jane/avatar.png').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RefError);
    expect((err as RefError).code).toBe('ref_not_found');
  });
});

describe('sheet.getAttachmentStream', () => {
  it('streams the attachment bytes by record path without materializing the record', async () => {
    const { repo } = await seededRepo();
    await commitAvatar(repo, BINARY);
    const users = await repo.openSheet('users');

    const stream = await users.getAttachmentStream('jane', 'avatar.png');
    expect(stream).not.toBeNull();
    expect(Buffer.compare(await collect(stream!), BINARY)).toBe(0);
  });

  it('accepts a record object too', async () => {
    const { repo } = await seededRepo();
    await commitAvatar(repo, BINARY);
    const users = await repo.openSheet('users');

    const stream = await users.getAttachmentStream({ slug: 'jane' }, 'avatar.png');
    expect(Buffer.compare(await collect(stream!), BINARY)).toBe(0);
  });

  it('returns null when the attachment is absent', async () => {
    const { repo } = await seededRepo();
    await commitAvatar(repo, BINARY);
    const users = await repo.openSheet('users');

    expect(await users.getAttachmentStream('jane', 'missing.png')).toBeNull();
  });

  it('reads through the fresh snapshot after this repository commits (auto-refresh)', async () => {
    const { repo } = await seededRepo();
    const users = await repo.openSheet('users');

    await commitAvatar(repo, Buffer.from('v1'));
    let stream = await users.getAttachmentStream('jane', 'avatar.png');
    expect((await collect(stream!)).toString()).toBe('v1');

    await commitAvatar(repo, Buffer.from('v2'));
    stream = await users.getAttachmentStream('jane', 'avatar.png');
    expect((await collect(stream!)).toString()).toBe('v2');
  });
});

// specs/behaviors/attachments.md "Blob metadata and bounded buffering" (#306).
describe('blob metadata + bounded buffering', () => {
  it('readBlob carries hash and size from the object header; read() and stream() agree', async () => {
    const { repo } = await seededRepo();
    await commitAvatar(repo, BINARY);
    const blob = await repo.readBlob('HEAD', 'users/jane/avatar.png');
    expect(blob.hash).toMatch(/^[0-9a-f]{40}$/);
    expect(blob.size).toBe(BINARY.length);
    expect(Buffer.compare(await blob.read(), BINARY)).toBe(0);
    expect(Buffer.compare(await collect(blob.stream()), BINARY)).toBe(0);
    await expect(repo.readBlob('HEAD', 'users/jane/nope.png')).rejects.toBeInstanceOf(NotFoundError);
    await expect(repo.readBlob('HEAD', 'users/jane')).rejects.toBeInstanceOf(NotFoundError); // a subtree
    await expect(repo.readBlob('no-such-ref', 'users/jane/avatar.png')).rejects.toBeInstanceOf(RefError);
  });

  it('getAttachment / attachments() handles carry size and stream()', async () => {
    const { repo } = await seededRepo();
    await commitAvatar(repo, BINARY);
    const users = await repo.openSheet('users');
    const blob = await users.getAttachment('jane', 'avatar.png');
    expect(blob!.size).toBe(BINARY.length);
    expect(Buffer.compare(await collect(blob!.stream()), BINARY)).toBe(0);
    for await (const entry of users.attachments('jane')) {
      expect(entry.blob.size).toBe(BINARY.length);
      expect(entry.blob.hash).toBe(blob!.hash);
    }
    const viaStream = await users.getAttachmentStream('jane', 'avatar.png');
    expect(Buffer.compare(await collect(viaStream!), BINARY)).toBe(0);
  });

  it('a blob over the inline limit streams byte-identical through git cat-file', async () => {
    const big = Buffer.alloc(STREAM_INLINE_LIMIT + 12_345);
    for (let i = 0; i < big.length; i++) big[i] = (i * 31) & 0xff;
    const { repo } = await seededRepo();
    await commitAvatar(repo, big);
    const blob = await repo.readBlob('HEAD', 'users/jane/avatar.png');
    expect(blob.size).toBe(big.length);
    expect(Buffer.compare(await collect(blob.stream()), big)).toBe(0);
    expect(Buffer.compare(await collect(await repo.readBlobStream('HEAD', 'users/jane/avatar.png')), big)).toBe(0);
  });
});
