// Submodule mode — locating a data submodule's git dir from its superproject,
// reading the gitlink a superproject commit pins, and staging a moved
// pointer. The Repository opened in submodule mode reads and writes the
// submodule's git dir; the superproject is consulted only through these
// helpers. See specs/behaviors/default-branch.md "Submodule mode".

import { readFile, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

import { ConfigError, RefError, TransactionError } from './errors.js';
import { gitExec } from './git-exec.js';

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
 * submodule mode). An explicit `null` opts out: no submodule, without
 * reading env or config. See specs/behaviors/default-branch.md "Resolution".
 */
export async function resolveSubmodulePath(
  superGitDir: string,
  explicit: string | null | undefined,
): Promise<{ path: string; source: SubmoduleSource } | null> {
  const from = (raw: string, source: SubmoduleSource) => ({ path: normalizeSubmodulePath(raw, source), source });
  if (explicit === null) return null; // explicit opt-out: env and config are not read
  if (explicit !== undefined) return from(explicit, 'openRepo({ submodule })');
  const env = process.env['GITSHEETS_SUBMODULE'];
  if (env !== undefined && env !== '') return from(env, 'GITSHEETS_SUBMODULE');
  let configured = '';
  try {
    configured = (await gitExec(superGitDir, ['config', '--get', 'gitsheets.submodule'])).stdout.trim();
  } catch {
    // unset
  }
  return configured !== '' ? from(configured, 'git config gitsheets.submodule') : null;
}

/**
 * Whether a submodule-mode repository stages its moved gitlink, resolved once
 * at open: `explicit` (the `openRepo` option) → `GITSHEETS_STAGE_POINTER` →
 * the superproject's `gitsheets.stagePointer` git config → `false`. Values
 * are git booleans; anything else is `ConfigError(config_invalid)` naming the
 * tier. See specs/behaviors/default-branch.md "After a commit".
 */
export async function resolveStagePointer(superGitDir: string, explicit: boolean | undefined): Promise<boolean> {
  if (explicit !== undefined) return explicit;
  const env = process.env['GITSHEETS_STAGE_POINTER'];
  if (env !== undefined && env !== '') {
    const parsed = parseGitBoolean(env);
    if (parsed === null) {
      throw new ConfigError(
        'config_invalid',
        `GITSHEETS_STAGE_POINTER: ${JSON.stringify(env)} is not a boolean — use true/false, yes/no, on/off, or 1/0`,
      );
    }
    return parsed;
  }
  try {
    const { stdout } = await gitExec(superGitDir, ['config', '--type=bool', '--get', 'gitsheets.stagePointer']);
    return stdout.trim() === 'true';
  } catch (err) {
    // Exit 1: unset. Anything else (git's "bad boolean config value"): invalid.
    if (err && typeof err === 'object' && 'code' in err && err.code === 1) return false;
    throw new ConfigError(
      'config_invalid',
      `git config gitsheets.stagePointer: not a boolean — use true/false, yes/no, on/off, or 1/0: ${errText(err)}`,
      { cause: err },
    );
  }
}

/** A git boolean spelling (`true`/`yes`/`on`/`1`, `false`/`no`/`off`/`0`, any case), or null. */
function parseGitBoolean(raw: string): boolean | null {
  const v = raw.trim().toLowerCase();
  if (v === 'true' || v === 'yes' || v === 'on' || v === '1') return true;
  if (v === 'false' || v === 'no' || v === 'off' || v === '0') return false;
  return null;
}

/**
 * Where the submodule binding came from — the prefix of every submodule-mode
 * `ConfigError` message, so a CLI can name the knob the user actually set.
 */
export type SubmoduleSource = 'openRepo({ submodule })' | 'GITSHEETS_SUBMODULE' | 'git config gitsheets.submodule';

/** Every {@link SubmoduleSource}, for recognizing submodule-mode errors by message prefix. */
export const SUBMODULE_SOURCES: readonly SubmoduleSource[] = ['openRepo({ submodule })', 'GITSHEETS_SUBMODULE', 'git config gitsheets.submodule'];

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
      const { stdout } = await gitExec(gitDir, ['config', '--get', key]);
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

/**
 * The `.gitmodules` name of the submodule at `path` — from the working
 * tree's `.gitmodules`, else the one committed at `HEAD`. A path with no
 * entry is not a submodule of this repository: `ConfigError(config_invalid)`
 * (a plain nested repository is never opened in submodule mode).
 */
export async function submoduleNameForPath(
  superGitDir: string,
  workTree: string | null,
  path: string,
  source: SubmoduleSource = 'openRepo({ submodule })',
): Promise<string> {
  const entry = (await gitmodulesEntries(superGitDir, workTree)).find((e) => e.path === path);
  if (entry === undefined) {
    throw new ConfigError(
      'config_invalid',
      `${source}: ${JSON.stringify(path)} is not a submodule of this repository (no .gitmodules entry with path = ${path}) — add one with: git sheet submodule init ${path} --url <url>`,
    );
  }
  return entry.name;
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
    ({ stdout } = await gitExec(superGitDir, ['config', ...source, '--get-regexp', '^submodule\\.']));
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
 * `<superproject git dir>/modules/<name>` — the superproject's *own* git dir,
 * so a linked worktree never writes through the main worktree's submodule.
 * Neither → `ConfigError(config_missing)` naming `git sheet submodule init <path>`.
 */
export async function locateSubmoduleGitDir(
  binding: SuperprojectBinding,
  source: SubmoduleSource = 'openRepo({ submodule })',
): Promise<string> {
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
  const modules = join(gitDir, 'modules', name);
  if (await isGitDir(modules)) return modules;
  throw new ConfigError(
    'config_missing',
    `${source}: no repository for submodule ${JSON.stringify(path)} (no ${path}/.git, no modules/${name}) — set it up with: git sheet submodule init ${path}`,
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
    const { stdout } = await gitExec(superGitDir, ['ls-tree', '--full-tree', `${commitish}^{tree}`, '--', path]);
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
    const { stdout } = await gitExec(subGitDir, ['rev-parse', '--verify', '--quiet', `${commit}^{commit}`]);
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
 * (`160000 <commit> <path>`) — `stagePointer`. Never commits. Runs with the
 * superproject's `GIT_DIR` / `GIT_WORK_TREE`. A failure is
 * `TransactionError(pointer_stage_failed)` carrying `commitHash`: the data
 * commit has landed, so the caller must not retry the write.
 */
export async function stageGitlink(binding: SuperprojectBinding, commit: string): Promise<void> {
  try {
    await gitExec(binding.gitDir, ['update-index', '--add', '--cacheinfo', `160000,${commit},${binding.path}`], {
      workTree: binding.workTree,
    });
  } catch (err) {
    throw new TransactionError(
      'pointer_stage_failed',
      `the data commit ${commit} landed in submodule ${binding.path}, but the superproject pointer could not be staged (stagePointer) — do not retry the write; stage it by hand: git add ${binding.path}: ${errText(err)}`,
      { cause: err, commitHash: commit },
    );
  }
}

/**
 * Advance a detached `HEAD` from `oldCommit` to `newCommit` with a strict
 * compare-and-swap — the one place gitsheets moves `HEAD` itself.
 *
 * `git update-ref --no-deref HEAD <new> <old>` compares `<old>` against the
 * *dereferenced* value, so a `HEAD` that became a symref at the same commit
 * (a branch checked out meanwhile) would pass the check and be detached
 * again. Check for a symref first and leave such a `HEAD` alone
 * (`commit_failed`, as the core reports a failed branch update). A window
 * remains between that check and the swap — `update-ref` cannot express
 * "only if still detached" — in which a concurrent checkout at the same
 * commit would be detached. A `HEAD` at another commit is `parent_moved`.
 * Both messages name the written commit so it can be recovered.
 */
export async function advanceDetachedHead(gitDir: string, newCommit: string, oldCommit: string, reason: string): Promise<void> {
  let symref: string | null = null;
  try {
    symref = (await gitExec(gitDir, ['symbolic-ref', '--quiet', 'HEAD'])).stdout.trim() || null;
  } catch {
    symref = null; // exit 1: detached
  }
  if (symref !== null) {
    throw new TransactionError(
      'commit_failed',
      `HEAD became ${symref} during the transaction, so it was left alone; commit ${newCommit} was written but is on no ref — recover it with: git merge ${newCommit} (or git branch <name> ${newCommit})`,
    );
  }
  try {
    await gitExec(gitDir, ['update-ref', '--no-deref', '-m', reason, 'HEAD', newCommit, oldCommit]);
  } catch (err) {
    throw new TransactionError(
      'parent_moved',
      `detached HEAD moved during the transaction (expected ${oldCommit}); commit ${newCommit} was written but HEAD was not advanced — recover it with: git cherry-pick ${newCommit}`,
      { cause: err },
    );
  }
}

function errText(err: unknown): string {
  if (err && typeof err === 'object' && 'stderr' in err && typeof err.stderr === 'string' && err.stderr.trim() !== '') {
    return err.stderr.trim();
  }
  return err instanceof Error ? err.message : String(err);
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
