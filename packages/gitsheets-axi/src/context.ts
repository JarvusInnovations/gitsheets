import { AxiError } from 'axi-sdk-js';
import { ConfigError, openRepo, type Repository } from 'gitsheets';

/**
 * Lazy gitsheets repo resolver. Opens the repo when a command actually needs
 * it. Commands that operate without a repo (currently: none — even `home`
 * shows the repo) call `requireRepo()` to surface a structured error when
 * the cwd isn't inside a git repo.
 */
export interface GitsheetsContext {
  repo(): Promise<Repository>;
  /**
   * Returns `null` rather than throwing when the cwd isn't inside a git repo —
   * `home` uses this to render a "no repo here" message instead of erroring.
   */
  tryRepo(): Promise<Repository | null>;
}

/** Global flags `gitsheets-axi` accepts before the command name. */
export interface GlobalFlags {
  /** `--branch <name>`: the repository's default branch (specs/behaviors/default-branch.md). */
  branch?: string;
}

/**
 * Pull the global flags (`--branch <name>` / `--branch=<name>`) out of
 * `argv`, wherever they appear — after the command per AXI convention, or
 * before it — and return the rest for the command parser.
 * `GITSHEETS_BRANCH` and `gitsheets.branch` are read by `openRepo` itself.
 * See specs/behaviors/default-branch.md "CLI".
 */
export function parseGlobalFlags(argv: readonly string[]): { flags: GlobalFlags; rest: string[] } {
  const flags: GlobalFlags = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--branch') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('-')) {
        throw new AxiError('--branch expects a branch name', 'VALIDATION_ERROR', [
          'Example: gitsheets-axi query users --branch data',
        ]);
      }
      flags.branch = value;
      i++;
      continue;
    }
    if (arg.startsWith('--branch=')) {
      flags.branch = arg.slice('--branch='.length);
      continue;
    }
    rest.push(arg);
  }
  return { flags, rest };
}

export function createContext(globals: GlobalFlags = {}): GitsheetsContext {
  let cached: Repository | null | undefined;
  let cachedError: unknown;

  async function load(): Promise<Repository | null> {
    if (cached !== undefined) return cached;
    if (cachedError !== undefined) throw cachedError;
    try {
      cached = await openRepo(globals.branch !== undefined ? { branch: globals.branch } : {});
      return cached;
    } catch (error) {
      cached = null;
      cachedError = error;
      throw error;
    }
  }

  return {
    async repo() {
      try {
        const result = await load();
        if (!result) {
          throw new AxiError(
            'Not inside a git repository.',
            'NOT_A_REPOSITORY',
            ['Run this command from a directory inside a gitsheets-managed git repository.'],
          );
        }
        return result;
      } catch (error) {
        if (error instanceof AxiError) throw error;
        // A bad default-branch binding (--branch / GITSHEETS_BRANCH /
        // gitsheets.branch naming a tag, commit, or malformed name).
        if (error instanceof ConfigError && error.code === 'config_invalid') {
          throw new AxiError(error.message, 'CONFIG_INVALID', [
            'Pass a branch name: gitsheets-axi --branch data <command>, GITSHEETS_BRANCH=data, or `git config gitsheets.branch data`',
          ]);
        }
        // openRepo throws when there's no git repo. Translate.
        throw new AxiError(
          'Not inside a git repository.',
          'NOT_A_REPOSITORY',
          ['Run this command from a directory inside a gitsheets-managed git repository.'],
        );
      }
    },

    async tryRepo() {
      try {
        return await load();
      } catch {
        return null;
      }
    },
  };
}
