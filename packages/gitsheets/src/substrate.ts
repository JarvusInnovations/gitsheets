// Tree substrate — the seam between gitsheets and its git-object backend.
//
// gitsheets' entire tree / blob / commit / ref layer runs on the published
// Rust binding `@hologit/holo-tree` (#127). The binding is the **sole** tree
// substrate: there is no hologit JS fallback. This module owns the binding
// load, the commit-object + CAS-ref operations, and the platform-failure
// surface. The deep-path working-tree navigation lives in `working-tree.ts`.
//
// The only remaining git **CLI** shell-outs are genuine git-porcelain ops the
// binding doesn't cover: `Sheet.diffFrom`'s `git diff-tree`, `git var
// GIT_EDITOR` / the `$EDITOR` flow, blob reads by hash (`git cat-file`), and
// author resolution (`git config`).
//
// See plans/holo-tree-migration.md and specs/rust-core.md.

// Type-only import: erased at compile time, so merely importing gitsheets never
// loads the native addon. The runtime load is the dynamic import in
// `loadBinding()` below.
import type { Repo as BindingRepo, Tree as BindingTree, Signature } from '@hologit/holo-tree';

import { ConfigError } from './errors.js';
import type { Author } from './transaction.js';

type HoloModule = typeof import('@hologit/holo-tree');

export type { BindingRepo, BindingTree };

let cached: HoloModule | undefined;

/**
 * Lazily load the holo-tree native binding. Throws a clear gitsheets error
 * naming the unsupported platform when the prebuilt addon can't load, rather
 * than letting a cryptic native-loader exception escape.
 *
 * `@hologit/holo-tree@^0.3.0` ships prebuilds for linux x64/arm64 (gnu+musl),
 * darwin arm64/x64, and win32 x64. On any other platform the import fails and
 * gitsheets surfaces a `ConfigError` (exit code 64) explaining why — the
 * binding is mandatory, since it is now the only tree substrate.
 *
 * The module is cached so the (successful) load happens once.
 */
export async function loadBinding(): Promise<HoloModule> {
  if (cached) return cached;
  try {
    cached = await import('@hologit/holo-tree');
  } catch (err) {
    throw new ConfigError(
      'config_invalid',
      `gitsheets requires the @hologit/holo-tree native binding, but no prebuilt could be ` +
        `loaded for this platform (${process.platform}-${process.arch}). Supported targets: ` +
        `linux x64/arm64 (gnu, musl), darwin arm64/x64, win32 x64. ` +
        `Original load error: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
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
