// Blob handle — the gitsheets-owned ODB blob accessor returned by
// `UpsertResult.blob`, `Sheet.getAttachment(s)`, and `Sheet.diffFrom`
// (`srcBlob`/`dstBlob`). It wraps a git blob hash with a lazy `read()` that
// reads the object database through the core (or returns pre-captured
// bytes), so the handle stays valid after the transaction commits — and
// carries no dependency on any particular tree substrate.

import { readBlobBytes } from './core.js';
import { NotFoundError } from './errors.js';

/** Git's canonical empty-tree hash. */
export const EMPTY_TREE_HASH = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

async function readBlob(gitDir: string, hash: string): Promise<Buffer> {
  const bytes = readBlobBytes(gitDir, hash);
  if (bytes === null) {
    throw new NotFoundError('record_not_found', `no blob object ${hash}`);
  }
  return bytes;
}

/**
 * gitsheets-owned public blob handle: `.hash`, `.mode`, `.isBlob === true`, and
 * `.read()` returning the blob bytes as a `Buffer`. Backing reads go through
 * the core's object-database read (or pre-captured bytes), so the handle
 * stays valid after the transaction commits.
 */
export interface BlobHandle {
  readonly isBlob: true;
  readonly hash: string;
  readonly mode: string;
  read(): Promise<Buffer>;
}

/**
 * Build a {@link BlobHandle} for a blob already in the ODB. `knownBytes`, when
 * supplied, short-circuits `read()` (avoids a `git cat-file` round-trip for a
 * blob whose bytes we just wrote).
 */
export function makeBlobHandle(
  gitDir: string,
  hash: string,
  mode = '100644',
  knownBytes?: Buffer,
): BlobHandle {
  return {
    isBlob: true,
    hash,
    mode,
    read: knownBytes !== undefined
      ? async (): Promise<Buffer> => knownBytes
      : (): Promise<Buffer> => readBlob(gitDir, hash),
  };
}
