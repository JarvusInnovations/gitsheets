// Submodule mode — locating a data submodule's git dir from its superproject,
// reading the gitlink a superproject commit pins, and staging a moved
// pointer. The Repository opened in submodule mode reads and writes the
// submodule's git dir; the superproject is consulted only through these
// helpers. See specs/behaviors/default-branch.md "Submodule mode".

import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { ConfigError, RefError, TransactionError } from './errors.js';

const exec = promisify(execFile);

/** The superproject a submodule-mode Repository was opened through. */
export interface SuperprojectBinding {
  /** The submodule's path relative to the superproject root (`'data'`). */
  readonly path: string;
  /** The submodule's name in `.gitmodules` (usually the path). */
  readonly name: string;
  /** The superproject's absolute git dir. */
  readonly gitDir: string;
  /** The superproject's working tree, or `null` when it has none. */
  readonly workTree: string | null;
}

/**
 * The submodule path the repository is bound to, resolved once at open:
 * `explicit` (the `openRepo` option) → `GITSHEETS_SUBMODULE` →
 * `gitsheets.submodule` git config of the superproject → `null` (no
 * submodule mode). See specs/behaviors/default-branch.md "Resolution".
 */
export async function resolveSubmodulePath(superGitDir: string, explicit: string | undefined): Promise<string | null> {
  if (explicit !== undefined) return normalizeSubmodulePath(explicit, 'openRepo({ submodule })');
  const env = process.env['GITSHEETS_SUBMODULE'];
  if (env !== undefined && env !== '') return normalizeSubmodulePath(env, 'GITSHEETS_SUBMODULE');
  try {
    const { stdout } = await exec('git', ['config', '--get', 'gitsheets.submodule'], { cwd: superGitDir });
    const configured = stdout.trim();
    if (configured !== '') return normalizeSubmodulePath(configured, 'git config gitsheets.submodule');
  } catch {
    // unset
  }
  return null;
}

/** `raw` as a clean superproject-relative path, or `ConfigError(config_invalid)`. */
export function normalizeSubmodulePath(raw: string, source: string): string {
  const path = raw.replace(/\\/g, '/').replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  if (path === '' || path === '.' || isAbsolute(raw) || path.split('/').some((s) => s === '..' || s === '' || s === '.git')) {
    throw new ConfigError(
      'config_invalid',
      `${source}: ${JSON.stringify(raw)} is not a submodule path — pass the path relative to the superproject root, as in .gitmodules (e.g. 'data')`,
    );
  }
  return path;
}

/**
 * The superproject's working tree: `explicit` when given, else `core.worktree`,
 * else the parent of a `.git` dir, else a linked worktree's recorded path;
 * `null` for a bare repository.
 */
export async function superprojectWorkTree(gitDir: string, explicit?: string | null): Promise<string | null> {
  if (explicit !== undefined && explicit !== null) return resolve(explicit);
  const config = async (key: string): Promise<string | null> => {
    try {
      const { stdout } = await exec('git', ['config', '--get', key], { cwd: gitDir });
      return stdout.trim();
    } catch {
      return null;
    }
  };
  if ((await config('core.bare')) === 'true') return null;
  const configured = await config('core.worktree');
  if (configured) return resolve(gitDir, configured);
  if (basename(gitDir) === '.git') return dirname(gitDir);
  try {
    // A linked worktree's git dir records `<worktree>/.git` in `gitdir`.
    const recorded = (await readFile(join(gitDir, 'gitdir'), 'utf8')).trim();
    if (recorded) return dirname(resolve(gitDir, recorded));
  } catch {
    // not a linked worktree
  }
  return null;
}

/** The superproject's common git dir (shared by linked worktrees). */
async function commonGitDir(gitDir: string): Promise<string> {
  try {
    const { stdout } = await exec('git', ['rev-parse', '--git-common-dir'], { cwd: gitDir });
    return resolve(gitDir, stdout.trim());
  } catch {
    return gitDir;
  }
}

/**
 * The `.gitmodules` name of the submodule at `path` — from the working
 * tree's `.gitmodules`, else the one committed at `HEAD` — or `path` itself
 * when no entry names it.
 */
export async function submoduleNameForPath(superGitDir: string, workTree: string | null, path: string): Promise<string> {
  const entries = await gitmodulesEntries(superGitDir, workTree);
  return entries.find((e) => e.path === path)?.name ?? path;
}

/** One `.gitmodules` entry. */
export interface GitmodulesEntry {
  readonly name: string;
  readonly path: string;
  readonly url?: string;
  readonly branch?: string;
}

/** Every entry in `.gitmodules` (working tree first, else `HEAD:.gitmodules`). */
export async function gitmodulesEntries(superGitDir: string, workTree: string | null): Promise<GitmodulesEntry[]> {
  const source: string[] =
    workTree !== null && (await isFile(join(workTree, '.gitmodules')))
      ? ['-f', join(workTree, '.gitmodules')]
      : ['--blob', 'HEAD:.gitmodules'];
  let stdout: string;
  try {
    ({ stdout } = await exec('git', ['config', ...source, '--get-regexp', '^submodule\\.'], { cwd: superGitDir }));
  } catch {
    return [];
  }
  const byName = new Map<string, Record<string, string>>();
  for (const line of stdout.split('\n')) {
    const sp = line.indexOf(' ');
    if (sp === -1) continue;
    const key = line.slice(0, sp);
    const value = line.slice(sp + 1);
    const dot = key.lastIndexOf('.');
    const name = key.slice('submodule.'.length, dot);
    const field = key.slice(dot + 1);
    const entry = byName.get(name) ?? {};
    entry[field] = value;
    byName.set(name, entry);
  }
  const out: GitmodulesEntry[] = [];
  for (const [name, fields] of byName) {
    if (fields['path'] === undefined) continue;
    const entry: { name: string; path: string; url?: string; branch?: string } = { name, path: fields['path'].replace(/\/+$/, '') };
    if (fields['url'] !== undefined) entry.url = fields['url'];
    if (fields['branch'] !== undefined) entry.branch = fields['branch'];
    out.push(entry);
  }
  return out;
}

/**
 * Locate the submodule's git dir: `<workTree>/<path>/.git` (a directory, or
 * a `gitdir:` pointer file — relative paths resolve against `<path>/`), else
 * `<superproject git dir>/modules/<name>`. Neither → `ConfigError(config_missing)`
 * naming `git sheet submodule init <path>`.
 */
export async function locateSubmoduleGitDir(binding: Omit<SuperprojectBinding, 'name'> & { name: string }): Promise<string> {
  const { gitDir, workTree, path, name } = binding;
  if (workTree !== null) {
    const dotgit = join(workTree, path, '.git');
    try {
      const st = await stat(dotgit);
      if (st.isDirectory()) return dotgit;
      if (st.isFile()) {
        const content = (await readFile(dotgit, 'utf8')).trim();
        const m = /^gitdir:\s*(.+)$/m.exec(content);
        if (m) {
          const target = resolve(join(workTree, path), m[1]!.trim());
          if (await isGitDir(target)) return target;
        }
      }
    } catch {
      // absent — try modules/
    }
  }
  for (const base of [gitDir, await commonGitDir(gitDir)]) {
    const modules = join(base, 'modules', name);
    if (await isGitDir(modules)) return modules;
  }
  throw new ConfigError(
    'config_missing',
    `openRepo({ submodule }): no repository for submodule ${JSON.stringify(path)} (no ${path}/.git, no modules/${name}) — set it up with: git sheet submodule init ${path}`,
  );
}

/**
 * The commit the superproject's `commitish` gitlinks at `path`, verified to
 * exist in the submodule's object store. `RefError(ref_not_found)` when
 * `commitish` doesn't resolve, has no gitlink at `path`, or the gitlinked
 * commit hasn't been fetched.
 */
export async function gitlinkCommit(superGitDir: string, commitish: string, path: string, subGitDir: string): Promise<string> {
  let line = '';
  try {
    const { stdout } = await exec('git', ['ls-tree', '--full-tree', `${commitish}^{tree}`, '--', path], { cwd: superGitDir });
    line = stdout.trim();
  } catch {
    throw new RefError('ref_not_found', `openRepo({ at }): superproject ref does not resolve: ${commitish}`);
  }
  const m = /^160000 commit ([0-9a-f]+)\t/.exec(line);
  if (!m) {
    throw new RefError('ref_not_found', `openRepo({ at }): ${commitish} has no gitlink at ${path}`);
  }
  const commit = m[1]!;
  try {
    const { stdout } = await exec('git', ['rev-parse', '--verify', '--quiet', `${commit}^{commit}`], { cwd: subGitDir });
    if (stdout.trim() !== '') return stdout.trim();
  } catch {
    // fall through
  }
  throw new RefError(
    'ref_not_found',
    `openRepo({ at }): ${commitish} pins ${path} at ${commit}, which is not in the submodule's object store — fetch it first (git -C ${path} fetch)`,
  );
}

/**
 * Point the superproject's index entry for `path` at `commit`
 * (`160000 <commit> <path>`) — `stagePointer`. Never commits. A failure is
 * `TransactionError(commit_failed)` naming the landed commit and the manual
 * remedy.
 */
export async function stageGitlink(binding: SuperprojectBinding, commit: string): Promise<void> {
  try {
    await exec('git', ['update-index', '--add', '--cacheinfo', `160000,${commit},${binding.path}`], {
      cwd: binding.workTree ?? binding.gitDir,
      env: { ...process.env, GIT_DIR: binding.gitDir, ...(binding.workTree !== null ? { GIT_WORK_TREE: binding.workTree } : {}) },
    });
  } catch (err) {
    throw new TransactionError(
      'commit_failed',
      `committed ${commit} to submodule ${binding.path}, but could not stage the superproject pointer (stagePointer) — stage it by hand: git add ${binding.path}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

/**
 * Advance a detached `HEAD` from `oldCommit` to `newCommit` with a strict
 * compare-and-swap — the one place gitsheets moves `HEAD` itself. A `HEAD`
 * that moved meanwhile is `TransactionError(parent_moved)`.
 */
export async function advanceDetachedHead(gitDir: string, newCommit: string, oldCommit: string, reason: string): Promise<void> {
  try {
    await exec('git', ['update-ref', '--no-deref', '-m', reason, 'HEAD', newCommit, oldCommit], { cwd: gitDir });
  } catch (err) {
    throw new TransactionError(
      'parent_moved',
      `detached HEAD moved during the transaction (expected ${oldCommit}); commit ${newCommit} was written but HEAD was not advanced`,
      { cause: err },
    );
  }
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

async function isGitDir(p: string): Promise<boolean> {
  try {
    return (await stat(join(p, 'HEAD'))).isFile() && (await stat(join(p, 'objects'))).isDirectory();
  } catch {
    return false;
  }
}
