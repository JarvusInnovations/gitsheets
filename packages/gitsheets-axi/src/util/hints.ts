import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { Repository } from 'gitsheets';

const exec = promisify(execFile);

/**
 * Shown after a commit-producing mutation when the records live on the
 * checked-out branch: gitsheets commits to the ref and never touches the
 * working tree, so the record files on disk now lag the commit (`git status`
 * reports them deleted or modified). It isn't data loss. The lasting fix is
 * a headless layout — records on a branch or submodule that is never checked
 * out (docs/recipes/headless-data.md); refreshing the files is the stopgap.
 */
export const MATERIALIZE_HINT =
  'records live on the checked-out branch, so your working tree now lags the commit — keep them off it with `--branch data` or `--submodule data` (docs/recipes/headless-data.md), or run `git checkout HEAD -- .` to refresh the files';

/**
 * The hints to show after a commit: {@link MATERIALIZE_HINT} only when the
 * write could leave a working tree behind — not in submodule mode, the
 * default branch is the branch `HEAD` points at (no `--branch` /
 * `GITSHEETS_BRANCH` / `gitsheets.branch` binding elsewhere), and the cwd
 * is inside a working tree. A write to a data branch or submodule touched no
 * checked-out branch, so there is nothing to materialize (#353).
 */
export async function materializeHints(repo: Repository): Promise<string[]> {
  if (repo.submodule !== null || repo.branch === null) return [];
  try {
    const { stdout: head } = await exec('git', ['symbolic-ref', '--quiet', 'HEAD'], { cwd: repo.gitDir });
    if (head.trim() !== `refs/heads/${repo.branch}`) return [];
    const { stdout: inside } = await exec('git', ['rev-parse', '--is-inside-work-tree']);
    if (inside.trim() !== 'true') return [];
  } catch {
    return [];
  }
  return [MATERIALIZE_HINT];
}
