import type { Repository } from 'gitsheets';

/**
 * The ref committed state is read from when no ref is named: the commit an
 * `--at` repository is pinned to, else the repository's resolved default
 * branch (`--branch` / `GITSHEETS_BRANCH` / `gitsheets.branch` / HEAD's
 * branch), or `HEAD` when it is bound to a detached HEAD. See
 * specs/behaviors/default-branch.md.
 */
export function defaultRef(repo: Repository): string {
  const pinned = repo.pinnedAtCommit();
  if (pinned !== null) return pinned;
  return repo.branch !== null ? `refs/heads/${repo.branch}` : 'HEAD';
}
