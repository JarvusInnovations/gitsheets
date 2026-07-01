// Blob handle — the gitsheets-owned ODB blob accessor returned by
// `UpsertResult.blob`, `Sheet.getAttachment(s)`, and `Sheet.diffFrom`
// (`srcBlob`/`dstBlob`). It wraps a git blob hash with a lazy `read()` that
// shells out to `git cat-file blob <hash>` (or returns pre-captured bytes), so
// the handle stays valid after the transaction commits — and carries no
// dependency on any particular tree substrate.

import { execFile } from 'node:child_process';

/** Git's canonical empty-tree hash. */
export const EMPTY_TREE_HASH = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

function catFileBlob(gitDir: string, hash: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      ['cat-file', 'blob', hash],
      { cwd: gitDir, encoding: 'buffer', maxBuffer: 1024 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(err);
        resolve(stdout as Buffer);
      },
    );
    child.stdin?.end();
  });
}

/**
 * gitsheets-owned public blob handle: `.hash`, `.mode`, `.isBlob === true`, and
 * `.read()` returning the blob bytes as a `Buffer`. Backing reads go through
 * `git cat-file blob <hash>` (or pre-captured bytes), so the handle stays valid
 * after the transaction commits.
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
      : (): Promise<Buffer> => catFileBlob(gitDir, hash),
  };
}
