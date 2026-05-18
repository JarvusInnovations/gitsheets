import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';

import { AxiError } from 'axi-sdk-js';
import { parseConfigToml, stringifyRecord } from 'gitsheets';
import type { RecordLike, Repository } from 'gitsheets';

import type { GitsheetsContext } from '../context.js';
import { translateError } from '../errors.js';
import { renderObject } from '../output/render.js';

const exec = promisify(execFile);

export const INIT_HELP = `usage: gitsheets-axi init <sheet> [--path <template>] [--schema <file>] [--force]
flags[4]:
  --path <template>    Path template (default: "\${{ id }}")
  --schema <file>      Path to a JSON file with the schema to embed
  --force              Overwrite an existing config
  --message <m>        Commit message (default: "<sheet> init sheet config")
examples:
  gitsheets-axi init users
  gitsheets-axi init posts --path '\${{ slug }}'
  gitsheets-axi init users --schema users.schema.json
behavior:
  Writes a starter \`.gitsheets/<sheet>.toml\` with a default root,
  path template, and optional schema. Refuses to overwrite an
  existing config unless --force is set.
idempotency:
  When the rendered config matches the existing config byte-for-byte,
  exits 0 with result: "no-op" — safe to re-run.
`;

interface InitFlags {
  sheet: string;
  path: string;
  schemaFile: string | undefined;
  force: boolean;
  message: string | undefined;
}

function parseInitFlags(args: string[]): InitFlags {
  const flags: InitFlags = {
    sheet: '',
    path: '${{ id }}',
    schemaFile: undefined,
    force: false,
    message: undefined,
  };
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    const next = args[i + 1];
    switch (arg) {
      case '--path':
        if (!next) throw new AxiError('--path expects a template', 'VALIDATION_ERROR');
        flags.path = next;
        i++;
        break;
      case '--schema':
        if (!next) throw new AxiError('--schema expects a file path', 'VALIDATION_ERROR');
        flags.schemaFile = next;
        i++;
        break;
      case '--force':
        flags.force = true;
        break;
      case '--message':
        if (!next) throw new AxiError('--message expects a string', 'VALIDATION_ERROR');
        flags.message = next;
        i++;
        break;
      default:
        if (arg.startsWith('-')) {
          throw new AxiError(`Unknown flag: ${arg}`, 'VALIDATION_ERROR', [
            'Run `gitsheets-axi init --help`',
          ]);
        }
        positional.push(arg);
    }
  }
  if (positional.length !== 1) {
    throw new AxiError('init requires <sheet>', 'VALIDATION_ERROR', [
      'Example: gitsheets-axi init users',
    ]);
  }
  flags.sheet = positional[0]!;
  return flags;
}

/**
 * Read the raw bytes of a tracked file at HEAD. Returns null if the file
 * doesn't exist there (or if HEAD doesn't exist yet on a fresh repo).
 */
async function readBytesAtHead(
  gitDir: string,
  path: string,
): Promise<string | null> {
  try {
    const { stdout } = await exec('git', ['show', `HEAD:${path}`], {
      cwd: gitDir,
      maxBuffer: 100 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return null;
  }
}

export async function initCommand(
  args: string[],
  ctx: GitsheetsContext,
): Promise<string> {
  if (args.length === 0 || (args.length === 1 && args[0] === '--help')) {
    return INIT_HELP;
  }

  const flags = parseInitFlags(args);
  const repo = await ctx.repo();
  const configPath = `.gitsheets/${flags.sheet}.toml`;

  const newConfig: RecordLike = {
    gitsheet: { root: flags.sheet, path: flags.path },
  };

  if (flags.schemaFile) {
    const absPath = isAbsolute(flags.schemaFile)
      ? flags.schemaFile
      : join(process.cwd(), flags.schemaFile);
    let schemaText: string;
    try {
      schemaText = await readFile(absPath, 'utf-8');
    } catch (err) {
      throw new AxiError(
        `init: cannot read schema file ${flags.schemaFile}: ${err instanceof Error ? err.message : String(err)}`,
        'NOT_FOUND',
      );
    }
    let schemaParsed: unknown;
    try {
      schemaParsed = JSON.parse(schemaText);
    } catch (err) {
      throw new AxiError(
        `init: schema file isn't valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        'INVALID_JSON',
      );
    }
    if (typeof schemaParsed !== 'object' || schemaParsed === null) {
      throw new AxiError('init: --schema did not parse as a JSON object', 'VALIDATION_ERROR');
    }
    (newConfig['gitsheet'] as RecordLike)['schema'] = schemaParsed as RecordLike;
  }

  const newText = stringifyRecord(newConfig);

  // Validate the new config parses cleanly before committing.
  try {
    parseConfigToml(newText, configPath);
  } catch (err) {
    throw new AxiError(
      `init: produced an invalid config: ${err instanceof Error ? err.message : String(err)}`,
      'CONFIG_INVALID',
    );
  }

  const existing = await readBytesAtHead(repoGitDir(repo), configPath);

  if (existing === newText) {
    return renderObject({
      result: 'no-op',
      sheet: flags.sheet,
      config: configPath,
      reason: 'config already matches',
    });
  }

  if (existing !== null && !flags.force) {
    throw new AxiError(
      `init: ${configPath} already exists and bytes differ — re-run with --force to overwrite`,
      'CONFIG_EXISTS',
      [`gitsheets-axi init ${flags.sheet} --force ...`],
    );
  }

  const commitMessage = flags.message ?? `${flags.sheet} init sheet config`;
  let commitHash = '';
  try {
    const result = await repo.transact(
      { message: commitMessage },
      async (tx) => {
        await tx.tree.writeChild(configPath, newText);
        tx.markMutated();
      },
    );
    commitHash = result.commitHash ?? '';
  } catch (error) {
    throw translateError(error);
  }

  return renderObject({
    result: existing === null ? 'created' : 'overwritten',
    sheet: flags.sheet,
    config: configPath,
    commit: commitHash,
  });
}

function repoGitDir(repo: Repository): string {
  return repo.gitDir;
}
