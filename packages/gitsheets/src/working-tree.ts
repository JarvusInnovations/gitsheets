// Blob handle — the gitsheets-owned ODB blob accessor returned by
// `UpsertResult.blob`, `Sheet.getAttachment(s)`, and `Sheet.diffFrom`
// (`srcBlob`/`dstBlob`). It wraps a git blob hash with a lazy `read()` that
// reads the object database through the core (or returns pre-captured
// bytes), so the handle stays valid after the transaction commits — and
// carries no dependency on any particular tree substrate.

import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';

import { blobHeader, readBlobBytes } from './core.js';
import { NotFoundError } from './errors.js';

/** Git's canonical empty-tree hash. */
export const EMPTY_TREE_HASH = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/**
 * `BlobHandle.stream()` serves a blob up to this many bytes from one in-core
 * read (a single chunk, no process spawn); above it the bytes are piped from
 * `git cat-file blob <hash>` so gitsheets never materializes the whole blob.
 * See specs/behaviors/attachments.md "Blob metadata and bounded buffering".
 */
export const STREAM_INLINE_LIMIT = 1024 * 1024;

function readBlobSync(gitDir: string, hash: string): Buffer {
  const bytes = readBlobBytes(gitDir, hash);
  if (bytes === null) {
    throw new NotFoundError('record_not_found', `no blob object ${hash}`);
  }
  return bytes;
}

/**
 * gitsheets-owned public blob handle: `.hash`, `.mode`, `.size` (bytes, from
 * the object header — no inflate), `.isBlob === true`, `.read()` returning the
 * blob bytes as a `Buffer`, and `.stream()` returning a `Readable` with
 * bounded buffering ({@link STREAM_INLINE_LIMIT}). Backing reads go through
 * the core's object-database read (or pre-captured bytes), so the handle
 * stays valid after the transaction commits. An HTTP handler sets `ETag` from
 * `hash`, `Content-Length` from `size`, and pipes `stream()`.
 */
export interface BlobHandle {
  readonly isBlob: true;
  readonly hash: string;
  readonly mode: string;
  readonly size: number;
  read(): Promise<Buffer>;
  stream(): Readable;
}

/**
 * Build a {@link BlobHandle} for a blob already in the ODB. `knownBytes`, when
 * supplied, short-circuits `read()` / `stream()` / `size` (a blob whose bytes
 * we just wrote); otherwise `size` comes from one header read now. Throws
 * `NotFoundError` when no object has `hash`.
 */
export function makeBlobHandle(
  gitDir: string,
  hash: string,
  mode = '100644',
  knownBytes?: Buffer,
): BlobHandle {
  let size: number;
  if (knownBytes !== undefined) {
    size = knownBytes.length;
  } else {
    const header = blobHeader(gitDir, hash);
    if (header === null) {
      throw new NotFoundError('record_not_found', `no blob object ${hash}`);
    }
    size = header.size;
  }
  return {
    isBlob: true,
    hash,
    mode,
    size,
    read: knownBytes !== undefined
      ? async (): Promise<Buffer> => knownBytes
      : async (): Promise<Buffer> => readBlobSync(gitDir, hash),
    stream(): Readable {
      if (knownBytes !== undefined) return Readable.from([knownBytes]);
      if (size <= STREAM_INLINE_LIMIT) return Readable.from([readBlobSync(gitDir, hash)]);
      // Large blob: pipe from git without materializing it here.
      const child = spawn('git', ['cat-file', 'blob', hash], { cwd: gitDir });
      child.stdin.end();
      return child.stdout;
    },
  };
}
