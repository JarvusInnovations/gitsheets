// `git sheet submodule init <path> [--url <url>] [--branch <b>]` — set up a
// data submodule with no record checkout. See specs/api/cli.md and
// specs/behaviors/default-branch.md "Bootstrapping" ("A data submodule").

import { execFile } from 'node:child_process';
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { promisify } from 'node:util';

import type { Argv } from 'yargs';

import { ConfigError, RefError } from '../errors.js';
import { cleanGitEnv, gitExec } from '../git-exec.js';
import { gitmodulesEntries, normalizeSubmodulePath, superprojectWorkTree } from '../submodule.js';
import type { GlobalArgs } from './shared.js';

const exec = promisify(execFile);

interface SubmoduleInitArgs extends GlobalArgs {
  path: string;
  url?: string;
}

export function registerSubmoduleCommands(y: Argv): Argv {
  return y
    .command<SubmoduleInitArgs>(
      'init <path>',
      'Set up a data submodule with no record checkout: .gitmodules entry (with --url), clone into modules/<path>, HEAD on the branch, ignore = dirty; stages, never commits',
      (yy) =>
        yy
          .positional('path', { type: 'string', demandOption: true, describe: 'Submodule path relative to the superproject root' })
          .option('url', { type: 'string', describe: 'Data repository URL — adds a new .gitmodules entry' }),
      runSubmoduleInit,
    )
    .demandCommand(1, 'Specify a submodule subcommand (init)');
}

/** `git <args>` against `gitDir` (explicit GIT_DIR — see git-exec.ts); trimmed stdout. */
async function git(gitDir: string, args: string[], workTree?: string): Promise<string> {
  return (await gitExec(gitDir, args, { workTree: workTree ?? null })).stdout.trim();
}

/** As {@link git}, but null on a non-zero exit or empty output. */
async function gitOrNull(gitDir: string, args: string[], workTree?: string): Promise<string | null> {
  try {
    const out = await git(gitDir, args, workTree);
    return out === '' ? null : out;
  } catch {
    return null;
  }
}

/** `git merge-base --is-ancestor a b`: whether `a` is reachable from `b`. */
async function isAncestor(gitDir: string, a: string, b: string): Promise<boolean> {
  try {
    await gitExec(gitDir, ['merge-base', '--is-ancestor', a, b]);
    return true;
  } catch {
    return false;
  }
}

async function runSubmoduleInit(argv: SubmoduleInitArgs): Promise<void> {
  const cwd = argv.gitDir ?? process.cwd();
  let superGitDir: string;
  try {
    // An explicit --git-dir is discovered from that path alone; with none, an
    // inherited GIT_DIR names the repository, as it does for git itself.
    const env = argv.gitDir !== undefined ? cleanGitEnv() : process.env;
    superGitDir = (await exec('git', ['rev-parse', '--absolute-git-dir'], { cwd, env })).stdout.trim();
  } catch (err) {
    throw new ConfigError('config_missing', `submodule init: no git repository at ${cwd}`, { cause: err });
  }
  const workTree = await superprojectWorkTree(superGitDir);
  if (workTree === null) {
    throw new ConfigError('config_invalid', 'submodule init: the superproject has no working tree to hold .gitmodules');
  }
  const superGit = (args: string[]): Promise<string> => git(superGitDir, args, workTree);
  const superGitOrNull = (args: string[]): Promise<string | null> => gitOrNull(superGitDir, args, workTree);

  const path = normalizeSubmodulePath(argv.path, 'submodule init');
  const entry = (await gitmodulesEntries(superGitDir, workTree)).find((e) => e.path === path);
  if (entry !== undefined && argv.url !== undefined && entry.url !== argv.url) {
    throw new ConfigError(
      'config_invalid',
      `submodule init: ${path} is already in .gitmodules with url ${JSON.stringify(entry.url)}, not ${JSON.stringify(argv.url)}`,
    );
  }
  const isNew = entry === undefined;
  if (isNew && argv.url === undefined) {
    throw new ConfigError('config_missing', `submodule init: no .gitmodules entry for ${path} — pass --url <url> to add one`);
  }
  const name = entry?.name ?? path;
  const rawUrl = entry?.url ?? argv.url!;
  const url = await resolveSubmoduleUrl(superGitDir, workTree, rawUrl);

  // Branch: new → --branch, else the remote's HEAD; existing → .gitmodules, else --branch, else the remote's HEAD.
  // `--no-branch` (false) is the same as no `--branch` here (specs/api/cli.md "Global flags").
  const flagBranch = argv.branch || undefined;
  let branch: string | null | undefined = isNew ? flagBranch : (entry.branch ?? flagBranch);
  if (branch === '.') branch = (await superGitOrNull(['symbolic-ref', '--quiet', '--short', 'HEAD'])) ?? undefined;
  branch ??= await remoteHeadBranch(url);
  if (branch === null || branch === undefined) {
    throw new ConfigError('config_invalid', `submodule init: ${url} has no HEAD branch (an empty repository?) — pass --branch <name>`);
  }
  branch = branch.replace(/^refs\/heads\//, '');
  try {
    await superGit(['check-ref-format', '--branch', branch]);
  } catch (err) {
    throw new ConfigError('config_invalid', `submodule init: ${JSON.stringify(branch)} is not a valid branch name`, { cause: err });
  }

  // The submodule's git dir — reached first: nothing is written to
  // .gitmodules or the superproject's config until the clone/fetch succeeded,
  // so a failed clone leaves nothing behind and a retry starts clean.
  const subWorkTree = join(workTree, path);
  const modulesDir = join(superGitDir, 'modules', name);
  let cloned = false;
  if (!(await isGitDir(modulesDir))) {
    if (await isGitDir(join(subWorkTree, '.git'))) {
      throw new ConfigError(
        'config_invalid',
        `submodule init: ${path}/.git is an embedded repository — move it into modules/ first: git submodule absorbgitdirs ${path}`,
      );
    }
    if (!(await isEmptyOrAbsent(subWorkTree))) {
      throw new ConfigError('config_invalid', `submodule init: ${path} exists and is not empty`);
    }
    await mkdir(dirname(modulesDir), { recursive: true });
    try {
      await exec('git', ['clone', '--quiet', '--no-checkout', '--separate-git-dir', modulesDir, url, subWorkTree], {
        cwd: workTree,
        env: cleanGitEnv(),
      });
    } catch (err) {
      throw new ConfigError('config_invalid', `submodule init: could not clone ${url}: ${errText(err)}`, { cause: err });
    }
    cloned = true;
  } else {
    try {
      await gitExec(modulesDir, ['fetch', '--quiet', 'origin']);
    } catch (err) {
      throw new ConfigError('config_invalid', `submodule init: could not fetch ${path} from origin: ${errText(err)}`, { cause: err });
    }
  }

  if (isNew) {
    const gitmodules = join(workTree, '.gitmodules');
    await superGit(['config', '-f', gitmodules, `submodule.${name}.path`, path]);
    await superGit(['config', '-f', gitmodules, `submodule.${name}.url`, rawUrl]);
    await superGit(['config', '-f', gitmodules, `submodule.${name}.branch`, branch]);
  }
  // What `git submodule init` records in the superproject's config. A URL
  // given with --url (new, or matching the entry) refreshes a stale one.
  const configuredUrl = await superGitOrNull(['config', '--get', `submodule.${name}.url`]);
  if (configuredUrl === null || (argv.url !== undefined && configuredUrl !== url)) {
    await superGit(['config', `submodule.${name}.url`, url]);
  }
  if ((await superGitOrNull(['config', '--get', `submodule.${name}.active`])) === null) {
    await superGit(['config', `submodule.${name}.active`, 'true']);
  }

  // The gitdir pointer and its back-link, both relative (as git writes them).
  await mkdir(subWorkTree, { recursive: true });
  await writeFile(join(subWorkTree, '.git'), `gitdir: ${relative(subWorkTree, modulesDir).split('\\').join('/')}\n`);
  await git(modulesDir, ['config', 'core.bare', 'false']);
  await git(modulesDir, ['config', 'core.worktree', relative(modulesDir, subWorkTree).split('\\').join('/')]);

  await placeHeadOnBranch({
    modulesDir,
    path,
    url,
    branch,
    cloned,
    gitlinked: isNew ? null : await gitlinkInIndex(superGitDir, workTree, path),
  });

  // Only pointer movement is reported: the working tree is never materialized.
  await superGit(['config', `submodule.${name}.ignore`, 'dirty']);

  const head = await gitOrNull(modulesDir, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
  if (isNew) {
    await superGit(['add', '--', '.gitmodules']);
    if (head !== null) {
      await superGit(['update-index', '--add', '--cacheinfo', `160000,${head},${path}`]);
    }
  }

  process.stdout.write(`${path}: ${url} ${branch} ${head ?? '(unborn)'}\n`);
  if (isNew) {
    process.stderr.write(
      head !== null
        ? `staged .gitmodules and ${path} — commit them: git commit -m "Add ${path} submodule"\n`
        : `staged .gitmodules — ${branch} is unborn; the first write creates it, then: git add ${path}\n`,
    );
  }
}

/**
 * Put the submodule's `HEAD` on `branch` without orphaning anything.
 *
 * - Just cloned: the branch starts at the gitlinked commit (else the
 *   remote's tip, else unborn).
 * - Otherwise an existing branch is left where it is, and a missing one is
 *   created at the gitlinked commit (else the remote's tip). A detached
 *   `HEAD` — where gitsheets writes advance `HEAD` itself — may hold data
 *   commits nothing else references: when the branch base is an ancestor of
 *   `HEAD`, the branch is fast-forwarded to `HEAD` first; when `HEAD` is an
 *   ancestor of it, nothing is lost; when they diverged, `ConfigError
 *   (config_invalid)` and nothing changes.
 *
 * See specs/behaviors/default-branch.md "Bootstrapping".
 */
async function placeHeadOnBranch(o: {
  modulesDir: string;
  path: string;
  url: string;
  branch: string;
  cloned: boolean;
  gitlinked: string | null;
}): Promise<void> {
  const { modulesDir, path, url, branch, cloned, gitlinked } = o;
  const branchRef = `refs/heads/${branch}`;
  const resolve = (rev: string): Promise<string | null> => gitOrNull(modulesDir, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]);
  const localTip = await resolve(branchRef);
  const originTip = await resolve(`refs/remotes/origin/${branch}`);
  const headIsSymref = (await gitOrNull(modulesDir, ['symbolic-ref', '--quiet', 'HEAD'])) !== null;
  const headCommit = cloned || headIsSymref ? null : await resolve('HEAD');

  if (gitlinked !== null && (await resolve(gitlinked)) === null) {
    throw new RefError('ref_not_found', `submodule init: ${path} is pinned at ${gitlinked}, which ${url} does not have — push the data repository first`);
  }

  let target: string | null;
  if (cloned) {
    target = gitlinked ?? (localTip === null ? originTip : null);
  } else {
    const base = localTip ?? gitlinked ?? originTip;
    target = localTip === null ? base : null;
    if (headCommit !== null && headCommit !== base) {
      if (base === null || (await isAncestor(modulesDir, base, headCommit))) {
        target = headCommit; // fast-forward over the detached HEAD's commits
      } else if (!(await isAncestor(modulesDir, headCommit, base))) {
        throw new ConfigError(
          'config_invalid',
          `submodule init: ${path}'s detached HEAD (${headCommit}) and ${branch} (${base}) have diverged — putting HEAD on ${branch} would orphan ${headCommit}. ` +
            `Merge it (git -C ${path} merge ${headCommit} after checking out ${branch}) or move the branch (git -C ${path} branch -f ${branch} ${headCommit}), then re-run`,
        );
      }
    }
  }
  if (target !== null && target !== localTip) {
    const cas = localTip !== null && !cloned ? [localTip] : [];
    await git(modulesDir, ['update-ref', '-m', 'gitsheets: submodule init', branchRef, target, ...cas]);
  }
  await git(modulesDir, ['symbolic-ref', 'HEAD', branchRef]);
}

/** The branch `url`'s `HEAD` points at, or null (an empty repository). */
async function remoteHeadBranch(url: string): Promise<string | null> {
  try {
    const { stdout } = await exec('git', ['ls-remote', '--symref', url, 'HEAD'], { env: cleanGitEnv() });
    const m = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(stdout);
    return m ? m[1]! : null;
  } catch (err) {
    throw new ConfigError('config_invalid', `submodule init: could not reach ${url}: ${errText(err)}`, { cause: err });
  }
}

/**
 * A `.gitmodules` URL as git resolves it: `./` / `../` URLs are relative to
 * the superproject's `origin` URL (else its working tree).
 */
async function resolveSubmoduleUrl(superGitDir: string, workTree: string, url: string): Promise<string> {
  if (!url.startsWith('./') && !url.startsWith('../')) return url;
  let base = ((await gitOrNull(superGitDir, ['config', '--get', 'remote.origin.url'])) ?? workTree).replace(/\/+$/, '');
  let rest = url;
  for (;;) {
    if (rest.startsWith('./')) rest = rest.slice(2);
    else if (rest.startsWith('../')) {
      rest = rest.slice(3);
      const cut = Math.max(base.lastIndexOf('/'), base.lastIndexOf(':'));
      base = cut === -1 ? '' : base.slice(0, base[cut] === ':' ? cut + 1 : cut);
    } else break;
  }
  return base.endsWith(':') || base === '' ? `${base}${rest}` : `${base}/${rest}`;
}

/** The commit the superproject's index gitlinks at `path` (else `HEAD`'s tree), or null. */
async function gitlinkInIndex(superGitDir: string, workTree: string, path: string): Promise<string | null> {
  const staged = await gitOrNull(superGitDir, ['ls-files', '--stage', '--', path], workTree);
  const fromIndex = staged !== null ? /^160000 ([0-9a-f]+) /.exec(staged) : null;
  if (fromIndex) return fromIndex[1]!;
  const committed = await gitOrNull(superGitDir, ['ls-tree', '--full-tree', 'HEAD', '--', path], workTree);
  const fromHead = committed !== null ? /^160000 commit ([0-9a-f]+)\t/.exec(committed) : null;
  return fromHead ? fromHead[1]! : null;
}

async function isGitDir(p: string): Promise<boolean> {
  try {
    return (await stat(join(p, 'HEAD'))).isFile() && (await stat(join(p, 'objects'))).isDirectory();
  } catch {
    return false;
  }
}

async function isEmptyOrAbsent(p: string): Promise<boolean> {
  try {
    return (await readdir(p)).length === 0;
  } catch {
    return true;
  }
}

function errText(err: unknown): string {
  if (err && typeof err === 'object' && 'stderr' in err && typeof err.stderr === 'string' && err.stderr.trim() !== '') {
    return err.stderr.trim();
  }
  return err instanceof Error ? err.message : String(err);
}
