// Tree substrate — the seam between gitsheets and its git-object backend.
//
// gitsheets is migrating its tree/commit operations off the hologit JS
// dependency onto the published Rust binding `@hologit/holo-tree` (#127). The
// binding currently exposes only a narrow surface
// (`Repo.open`/`createTreeFromRef`/`createTree`/`commitTree`/`updateRef` +
// `Tree.writeChild`/`writeChildBytes`/`readBlob`/`deleteChildDeep`/`write` +
// `emptyTreeHash`), so the migration proceeds site by site. This module owns
// the binding import and the operations migrated so far; everything not yet
// covered stays on hologit / git shell-outs in its original site.
//
// See plans/holo-tree-migration.md and specs/rust-core.md.

import { Repo as HoloRepo, type Signature } from '@hologit/holo-tree';

import type { Author } from './transaction.js';

/**
 * Substrate selector. The holo-tree binding is the default path for the
 * operations migrated so far; setting `GITSHEETS_COMMIT_SUBSTRATE=git` forces
 * the legacy git shell-out path, keeping both paths exercisable during the
 * migration. Any value other than `git` (including unset) selects holo-tree.
 */
export function useHoloTreeCommit(): boolean {
  return process.env['GITSHEETS_COMMIT_SUBSTRATE'] !== 'git';
}

/**
 * Build a holo-tree `Signature` from a gitsheets `Author`, capturing the
 * current wall-clock time in the machine's local timezone offset — matching
 * what `git commit-tree` records when `GIT_*_DATE` is unset (the prior
 * behavior). `timeSeconds`/`offsetMinutes` are passed explicitly because the
 * binding otherwise defaults to UTC.
 */
export function toSignature(author: Author, timeSeconds: number, offsetMinutes: number): Signature {
  return {
    name: author.name,
    email: author.email,
    timeSeconds,
    offsetMinutes,
  };
}

/**
 * Create a commit object via the holo-tree binding and return its hash.
 *
 * `treeHash` must already exist in the repo's object database (gitsheets writes
 * it via the existing tree `write()` before calling this). The binding opens
 * the same `gitDir`, so the freshly written loose tree object is visible.
 *
 * A fresh `Repo` handle is opened per call: commits are infrequent (one per
 * transaction) and a fresh handle sidesteps any object-cache staleness against
 * loose objects written since a cached handle was opened.
 */
export function commitTreeViaHoloTree(opts: {
  gitDir: string;
  treeHash: string;
  parents: readonly string[];
  message: string;
  author: Author;
  committer: Author;
}): string {
  const now = Math.floor(Date.now() / 1000);
  // getTimezoneOffset returns minutes that local is *behind* UTC (UTC - local),
  // so negate to get git's "+HHMM"-style offset (minutes ahead of UTC).
  const offsetMinutes = -new Date().getTimezoneOffset();
  const repo = HoloRepo.open(opts.gitDir);
  return repo.commitTree(
    opts.treeHash,
    [...opts.parents],
    opts.message,
    toSignature(opts.author, now, offsetMinutes),
    toSignature(opts.committer, now, offsetMinutes),
  );
}
