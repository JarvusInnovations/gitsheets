// Tree substrate — the seam between gitsheets and its git-object backend.
//
// gitsheets is migrating its tree/commit/ref operations off the hologit JS
// dependency onto the published Rust binding `@hologit/holo-tree@^0.2.0`
// (#127). The migration proceeds site by site. This module owns the binding
// load and the commit-object + ref operations migrated so far; the working-tree
// read/write/navigation surface (`Sheet` / `path-template`) still goes through
// hologit's `Workspace`/`TreeObject` — see the migration plan for why it can't
// move yet (the 0.2.0 `Tree.deleteChildDeep` flush bug).
//
// When the native addon can't load on a platform, `loadHoloTree()` returns
// `null` and callers keep the legacy `git` shell-out path untouched.
//
// See plans/holo-tree-migration.md and specs/rust-core.md.

// Type-only import: erased at compile time, so merely importing gitsheets never
// loads the native addon. The runtime load is the dynamic import in
// `loadHoloTree()` below.
import type { Repo as BindingRepo, Signature } from '@hologit/holo-tree';

import type { Author } from './transaction.js';

type HoloModule = typeof import('@hologit/holo-tree');

export type { BindingRepo };

let cached: HoloModule | null | undefined;

/**
 * Lazily load the holo-tree binding, or return `null` to signal "use the legacy
 * git path". Returns `null` when:
 *
 * - `GITSHEETS_COMMIT_SUBSTRATE=git` forces the legacy shell-out, or
 * - the native addon can't load on this platform. `@hologit/holo-tree` ships
 *   prebuilds only for linux-x64-gnu / darwin-arm64 / win32-x64-msvc; on any
 *   other platform (Alpine/musl, linux-arm64, …) the load fails and gitsheets
 *   **gracefully falls back to git** rather than becoming unimportable.
 *
 * The result is cached (including the `null` outcome) so the probe happens once.
 */
export async function loadHoloTree(): Promise<HoloModule | null> {
  if (cached !== undefined) return cached;
  if (process.env['GITSHEETS_COMMIT_SUBSTRATE'] === 'git') {
    cached = null;
    return cached;
  }
  try {
    cached = await import('@hologit/holo-tree');
  } catch {
    // Unsupported platform / missing prebuilt — fall back to git.
    cached = null;
  }
  return cached;
}

/** Open a binding `Repo` handle at `gitDir`. */
export function openBindingRepo(holo: HoloModule, gitDir: string): BindingRepo {
  return holo.Repo.open(gitDir);
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
 * it via the existing tree `write()` before calling this); `repo` is the same
 * binding handle gitsheets resolves the parent/ref through, so the freshly
 * written loose tree object is visible.
 */
export function commitTreeWithRepo(
  repo: BindingRepo,
  opts: {
    treeHash: string;
    parents: readonly string[];
    message: string;
    author: Author;
    committer: Author;
  },
): string {
  const now = Math.floor(Date.now() / 1000);
  // getTimezoneOffset returns minutes that local is *behind* UTC (UTC - local),
  // so negate to get git's "+HHMM"-style offset (minutes ahead of UTC).
  const offsetMinutes = -new Date().getTimezoneOffset();
  return repo.commitTree(
    opts.treeHash,
    [...opts.parents],
    opts.message,
    toSignature(opts.author, now, offsetMinutes),
    toSignature(opts.committer, now, offsetMinutes),
  );
}
