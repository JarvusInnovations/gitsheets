/**
 * Shown after any commit-producing mutation. gitsheets commits records to the
 * git ref via plumbing and never touches the working tree, so a fresh commit
 * leaves the record files "deleted" on disk until they're checked out. This
 * surprises first-time users — it isn't data loss.
 */
export const MATERIALIZE_HINT =
  'gitsheets committed to the git ref, not your working tree — run `git checkout HEAD -- .` to materialize the record files on disk';
