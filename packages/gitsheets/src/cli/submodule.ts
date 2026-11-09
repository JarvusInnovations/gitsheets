// `git sheet submodule init <path> [--url <url>] [--branch <b>]` — set up a
// data submodule with no record checkout. See specs/api/cli.md and
// specs/behaviors/default-branch.md "Bootstrapping" ("A data submodule").

import { execFile } from 'node:child_process';
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { promisify } from 'node:util';

import type { Argv } from 'yargs';

import { ConfigError, RefError } from '../errors.js';
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

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd });
  return stdout.trim();
}

async function gitOrNull(cwd: string, args: string[]): Promise<string | null> {
  try {
    const out = await git(cwd, args);
    return out === '' ? null : out;
  } catch {
    return null;
  }
}

async function runSubmoduleInit(argv: SubmoduleInitArgs): Promise<void> {
  const cwd = argv.gitDir ?? process.cwd();
  let superGitDir: string;
  try {
    superGitDir = await git(cwd, ['rev-parse', '--absolute-git-dir']);
  } catch (err) {
    throw new ConfigError('config_missing', `submodule init: no git repository at ${cwd}`, { cause: err });
  }
  const workTree = await superprojectWorkTree(superGitDir);
  if (workTree === null) {
    throw new ConfigError('config_invalid', 'submodule init: the superproject has no working tree to hold .gitmodules');
  }
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
  let branch: string | null | undefined = isNew ? argv.branch : (entry.branch ?? argv.branch);
  if (branch === '.') branch = (await gitOrNull(superGitDir, ['symbolic-ref', '--quiet', '--short', 'HEAD'])) ?? undefined;
  branch ??= await remoteHeadBranch(url);
  if (branch === null || branch === undefined) {
    throw new ConfigError('config_invalid', `submodule init: ${url} has no HEAD branch (an empty repository?) — pass --branch <name>`);
  }
  branch = branch.replace(/^refs\/heads\//, '');
  try {
    await git(superGitDir, ['check-ref-format', '--branch', branch]);
  } catch (err) {
    throw new ConfigError('config_invalid', `submodule init: ${JSON.stringify(branch)} is not a valid branch name`, { cause: err });
  }

  if (isNew) {
    const gitmodules = join(workTree, '.gitmodules');
    await git(workTree, ['config', '-f', gitmodules, `submodule.${name}.path`, path]);
    await git(workTree, ['config', '-f', gitmodules, `submodule.${name}.url`, rawUrl]);
    await git(workTree, ['config', '-f', gitmodules, `submodule.${name}.branch`, branch]);
  }
  // What `git submodule init` records in the superproject's config.
  if ((await gitOrNull(superGitDir, ['config', '--get', `submodule.${name}.url`])) === null) {
    await git(superGitDir, ['config', `submodule.${name}.url`, url]);
  }
  if ((await gitOrNull(superGitDir, ['config', '--get', `submodule.${name}.active`])) === null) {
    await git(superGitDir, ['config', `submodule.${name}.active`, 'true']);
  }

  // The submodule's git dir: modules/<name>, cloned with no checkout when absent.
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
      await exec('git', ['clone', '--quiet', '--no-checkout', '--separate-git-dir', modulesDir, url, subWorkTree], { cwd: workTree });
    } catch (err) {
      throw new ConfigError('config_invalid', `submodule init: could not clone ${url}: ${errText(err)}`, { cause: err });
    }
    cloned = true;
  } else {
    try {
      await exec('git', ['fetch', '--quiet', 'origin'], { cwd: modulesDir });
    } catch (err) {
      throw new ConfigError('config_invalid', `submodule init: could not fetch ${path} from origin: ${errText(err)}`, { cause: err });
    }
  }

  // The gitdir pointer and its back-link, both relative (as git writes them).
  await mkdir(subWorkTree, { recursive: true });
  await writeFile(join(subWorkTree, '.git'), `gitdir: ${relative(subWorkTree, modulesDir).split('\\').join('/')}\n`);
  await git(modulesDir, ['config', 'core.bare', 'false']);
  await git(modulesDir, ['config', 'core.worktree', relative(modulesDir, subWorkTree).split('\\').join('/')]);

  // HEAD on the branch — at the gitlinked commit when the branch is (re)created.
  const gitlinked = isNew ? null : await gitlinkInIndex(workTree, path);
  const branchRef = `refs/heads/${branch}`;
  const localTip = await gitOrNull(modulesDir, ['rev-parse', '--verify', '--quiet', `${branchRef}^{commit}`]);
  if (localTip === null || (cloned && gitlinked !== null)) {
    const target = gitlinked ?? (await gitOrNull(modulesDir, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}^{commit}`]));
    if (target !== null) {
      if ((await gitOrNull(modulesDir, ['rev-parse', '--verify', '--quiet', `${target}^{commit}`])) === null) {
        throw new RefError('ref_not_found', `submodule init: ${path} is pinned at ${target}, which ${url} does not have — push the data repository first`);
      }
      await git(modulesDir, ['update-ref', '-m', 'gitsheets: submodule init', branchRef, target]);
    }
  }
  await git(modulesDir, ['symbolic-ref', 'HEAD', branchRef]);

  // Only pointer movement is reported: the working tree is never materialized.
  await git(superGitDir, ['config', `submodule.${name}.ignore`, 'dirty']);

  const head = await gitOrNull(modulesDir, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
  if (isNew) {
    await git(workTree, ['add', '--', '.gitmodules']);
    if (head !== null) {
      await git(workTree, ['update-index', '--add', '--cacheinfo', `160000,${head},${path}`]);
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

/** The branch `url`'s `HEAD` points at, or null (an empty repository). */
async function remoteHeadBranch(url: string): Promise<string | null> {
  try {
    const { stdout } = await exec('git', ['ls-remote', '--symref', url, 'HEAD']);
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
async function gitlinkInIndex(workTree: string, path: string): Promise<string | null> {
  const staged = await gitOrNull(workTree, ['ls-files', '--stage', '--', path]);
  const fromIndex = staged !== null ? /^160000 ([0-9a-f]+) /.exec(staged) : null;
  if (fromIndex) return fromIndex[1]!;
  const committed = await gitOrNull(workTree, ['ls-tree', '--full-tree', 'HEAD', '--', path]);
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
