import { AxiError } from 'axi-sdk-js';
import { ConfigError, RefError, openRepo, type Repository } from 'gitsheets';

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
  /** `--branch <name>`: the repository's default branch (specs/behaviors/default-branch.md); `null` for `--no-branch` (HEAD's branch, env and config ignored). */
  branch?: string | null;
  /** `--submodule <path>`: submodule mode — the data submodule every command reads/writes; `null` for `--no-submodule` (the superproject, env and config ignored). */
  submodule?: string | null;
  /** `--stage-pointer` / `--no-stage-pointer`: submodule mode — stage the moved gitlink after each commit. */
  stagePointer?: boolean;
  /** `--at <superproject-ref>`: submodule mode — read-only at the commit that ref gitlinks. */
  at?: string;
}

/** Value-taking global flags: name → (field, what the value is, example). */
const VALUE_FLAGS = {
  '--branch': ['branch', 'a branch name', 'gitsheets-axi query users --branch data'],
  '--submodule': ['submodule', 'a submodule path', 'gitsheets-axi query users --submodule data'],
  '--at': ['at', 'a superproject ref', 'gitsheets-axi query users --submodule data --at v1.2.0'],
} as const;

/**
 * Pull the global flags (`--branch <name>`, `--submodule <path>`,
 * `--at <superproject-ref>` — each also as `--flag=value` — plus
 * `--no-branch` / `--no-submodule` (the `null` opt-out) and
 * `--stage-pointer` / `--no-stage-pointer`) out of `argv`, wherever they
 * appear — after the command per AXI convention, or before it — and return
 * the rest for the command parser. A malformed one is an `AxiError`
 * (`VALIDATION_ERROR`, exit 2). `GITSHEETS_BRANCH` / `GITSHEETS_SUBMODULE` /
 * `GITSHEETS_STAGE_POINTER` and the `gitsheets.*` git config are read by
 * `openRepo` itself; `GITSHEETS_AT` by {@link createContext}.
 * See specs/behaviors/default-branch.md "CLI".
 */
export function parseGlobalFlags(argv: readonly string[]): { flags: GlobalFlags; rest: string[] } {
  const flags: GlobalFlags = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--stage-pointer' || arg === '--no-stage-pointer') {
      flags.stagePointer = arg === '--stage-pointer';
      continue;
    }
    if (arg.startsWith('--stage-pointer=') || arg.startsWith('--no-stage-pointer=')) {
      throw new AxiError(`${arg.slice(0, arg.indexOf('='))} takes no value`, 'VALIDATION_ERROR', [
        'Pass --stage-pointer to stage the moved gitlink, or --no-stage-pointer to turn it off',
      ]);
    }
    if (arg === '--no-branch' || arg === '--no-submodule') {
      flags[arg === '--no-branch' ? 'branch' : 'submodule'] = null;
      continue;
    }
    if (arg.startsWith('--no-branch=') || arg.startsWith('--no-submodule=')) {
      const name = arg.slice(0, arg.indexOf('='));
      throw new AxiError(`${name} takes no value`, 'VALIDATION_ERROR', [
        `Pass ${name} alone to ignore $GITSHEETS_${name === '--no-branch' ? 'BRANCH' : 'SUBMODULE'} and the git config for this run`,
      ]);
    }
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if (Object.hasOwn(VALUE_FLAGS, name)) {
      const [field, what, example] = VALUE_FLAGS[name as keyof typeof VALUE_FLAGS];
      let value: string | undefined;
      if (eq === -1) {
        value = argv[i + 1];
        if (value !== undefined && value.startsWith('-')) value = undefined;
        i++;
      } else {
        value = arg.slice(eq + 1);
      }
      if (value === undefined || value === '') {
        throw new AxiError(`${name} expects ${what}`, 'VALIDATION_ERROR', [`Example: ${example}`]);
      }
      flags[field] = value;
      continue;
    }
    rest.push(arg);
  }
  return { flags, rest };
}

/** The command name a malformed global flag is dispatched as. */
const GLOBAL_FLAG_ERROR = '__global-flag-error__';

/**
 * {@link parseGlobalFlags} for the dispatcher: a malformed global flag is
 * routed through the SDK as a command that throws it, so it renders and
 * exits like every other usage error (`VALIDATION_ERROR`, exit 2).
 */
export function parseGlobalFlagsForDispatch(argv: readonly string[]): {
  flags: GlobalFlags;
  rest: string[];
  commands: Record<string, () => Promise<never>>;
} {
  try {
    return { ...parseGlobalFlags(argv), commands: {} };
  } catch (error) {
    return {
      flags: {},
      rest: [GLOBAL_FLAG_ERROR],
      commands: { [GLOBAL_FLAG_ERROR]: () => Promise.reject(error) },
    };
  }
}

/** The source prefixes of gitsheets' submodule-mode ConfigError messages. */
const SUBMODULE_ERROR = /^(openRepo\(\{ submodule \}\)|GITSHEETS_SUBMODULE|git config gitsheets\.submodule): /;

export function createContext(globals: GlobalFlags = {}): GitsheetsContext {
  let cached: Repository | null | undefined;
  let cachedError: unknown;

  async function load(): Promise<Repository | null> {
    if (cached !== undefined) return cached;
    if (cachedError !== undefined) throw cachedError;
    try {
      const at = globals.at ?? (process.env['GITSHEETS_AT'] || undefined);
      cached = await openRepo({
        ...(globals.branch !== undefined ? { branch: globals.branch } : {}),
        ...(globals.submodule !== undefined ? { submodule: globals.submodule } : {}),
        ...(globals.stagePointer !== undefined ? { stagePointer: globals.stagePointer } : {}),
        ...(at !== undefined ? { at } : {}),
      });
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
        // --at / GITSHEETS_AT: outside submodule mode, or a ref with no gitlink.
        if ((error instanceof ConfigError || error instanceof RefError) && error.message.startsWith('openRepo({ at })')) {
          throw new AxiError(`--at / GITSHEETS_AT${error.message.slice('openRepo({ at })'.length)}`, error instanceof RefError ? 'REF_ERROR' : 'CONFIG_INVALID', [
            '--at pins a data submodule: pass --submodule <path> (or set GITSHEETS_SUBMODULE / gitsheets.submodule) and a superproject ref that gitlinks it',
          ]);
        }
        // GITSHEETS_STAGE_POINTER / gitsheets.stagePointer that is not a git boolean.
        if (error instanceof ConfigError && /^(GITSHEETS_STAGE_POINTER|git config gitsheets\.stagePointer): /.test(error.message)) {
          throw new AxiError(error.message, 'CONFIG_INVALID', ['Use a git boolean: true/false, yes/no, on/off, or 1/0']);
        }
        // Submodule mode (--submodule / GITSHEETS_SUBMODULE / gitsheets.submodule):
        // a bad path, a path that is not a submodule, or one not set up yet.
        const submodule = error instanceof ConfigError ? SUBMODULE_ERROR.exec(error.message) : null;
        if (error instanceof ConfigError && submodule !== null) {
          const message = submodule[1] === 'openRepo({ submodule })' ? `--submodule${error.message.slice(submodule[1].length)}` : error.message;
          throw new AxiError(message, error.code === 'config_missing' ? 'CONFIG_MISSING' : 'CONFIG_INVALID', [
            'Set the submodule up with no record checkout: git sheet submodule init <path> [--url <url>]',
          ]);
        }
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
