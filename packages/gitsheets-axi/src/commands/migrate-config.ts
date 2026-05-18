import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { AxiError } from 'axi-sdk-js';
import { parseToml, stringifyRecord } from 'gitsheets';
import type { RecordLike } from 'gitsheets';

import type { GitsheetsContext } from '../context.js';
import { translateError } from '../errors.js';
import { renderObject } from '../output/render.js';

const exec = promisify(execFile);

export const MIGRATE_CONFIG_HELP = `usage: gitsheets-axi migrate-config <sheet> [--message m]
flags[1]:
  --message <m>        Commit message (default: "<sheet> migrate-config")
examples:
  gitsheets-axi migrate-config users
behavior:
  Translates a pre-v1.0 \`[gitsheet.fields]\` block into the modern
  \`[gitsheet.schema]\` block. type/enum/default move into JSON Schema
  properties; sort rules stay on the field (they're a normalization
  concern, not validation). trueValues/falseValues are dropped with
  a warning — those moved out of validation in v1.0 (CSV ingest concern).
idempotency:
  If the config has no \`[gitsheet.fields]\` block, exits 0 with
  result: "no-op". If the migration produces identical bytes, same.
`;

interface MigrateFlags {
  sheet: string;
  message: string | undefined;
}

function parseMigrateFlags(args: string[]): MigrateFlags {
  const flags: MigrateFlags = { sheet: '', message: undefined };
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    const next = args[i + 1];
    if (arg === '--message') {
      if (!next) throw new AxiError('--message expects a string', 'VALIDATION_ERROR');
      flags.message = next;
      i++;
      continue;
    }
    if (arg.startsWith('-')) {
      throw new AxiError(`Unknown flag: ${arg}`, 'VALIDATION_ERROR', [
        'Run `gitsheets-axi migrate-config --help`',
      ]);
    }
    positional.push(arg);
  }
  if (positional.length !== 1) {
    throw new AxiError('migrate-config requires <sheet>', 'VALIDATION_ERROR', [
      'Example: gitsheets-axi migrate-config users',
    ]);
  }
  flags.sheet = positional[0]!;
  return flags;
}

async function readConfigText(gitDir: string, path: string): Promise<string | null> {
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

export async function migrateConfigCommand(
  args: string[],
  ctx: GitsheetsContext,
): Promise<string> {
  if (args.length === 0 || (args.length === 1 && args[0] === '--help')) {
    return MIGRATE_CONFIG_HELP;
  }

  const flags = parseMigrateFlags(args);
  const repo = await ctx.repo();
  const configPath = `.gitsheets/${flags.sheet}.toml`;

  const configText = await readConfigText(repo.gitDir, configPath);
  if (configText === null) {
    throw new AxiError(
      `migrate-config: ${configPath} doesn't exist`,
      'NOT_FOUND',
    );
  }

  let parsed: RecordLike;
  try {
    parsed = parseToml(configText) as RecordLike;
  } catch (err) {
    throw new AxiError(
      `migrate-config: ${configPath} failed to parse: ${err instanceof Error ? err.message : String(err)}`,
      'CONFIG_INVALID',
    );
  }

  const gitsheet = (parsed['gitsheet'] ?? {}) as RecordLike;
  const fields = gitsheet['fields'] as Record<string, RecordLike> | undefined;

  if (!fields || typeof fields !== 'object') {
    return renderObject({
      result: 'no-op',
      sheet: flags.sheet,
      config: configPath,
      reason: 'no [gitsheet.fields] block to migrate',
    });
  }

  const properties: Record<string, RecordLike> = {};
  const remainingFields: Record<string, RecordLike> = {};
  const warnings: string[] = [];
  for (const [name, cfg] of Object.entries(fields)) {
    if (typeof cfg !== 'object' || cfg === null) continue;
    const schemaProp: RecordLike = {};
    const remainingField: RecordLike = {};
    if (cfg['type'] !== undefined) schemaProp['type'] = cfg['type'];
    if (cfg['enum'] !== undefined) schemaProp['enum'] = cfg['enum'];
    if (cfg['default'] !== undefined) schemaProp['default'] = cfg['default'];
    if (cfg['sort'] !== undefined) remainingField['sort'] = cfg['sort'];
    if (cfg['trueValues'] !== undefined || cfg['falseValues'] !== undefined) {
      warnings.push(`${name}.trueValues/falseValues dropped (moved to CSV ingest)`);
    }
    if (Object.keys(schemaProp).length > 0) properties[name] = schemaProp;
    if (Object.keys(remainingField).length > 0) remainingFields[name] = remainingField;
  }

  const newGitsheet: RecordLike = {};
  for (const [k, v] of Object.entries(gitsheet)) {
    if (k === 'fields' || k === 'schema') continue;
    newGitsheet[k] = v;
  }
  if (Object.keys(remainingFields).length > 0) newGitsheet['fields'] = remainingFields;
  if (Object.keys(properties).length > 0) {
    newGitsheet['schema'] = { type: 'object', properties };
  }
  parsed['gitsheet'] = newGitsheet;
  const newText = stringifyRecord(parsed);

  if (newText === configText) {
    return renderObject({
      result: 'no-op',
      sheet: flags.sheet,
      config: configPath,
      reason: 'migration produced identical bytes',
    });
  }

  const commitMessage = flags.message ?? `${flags.sheet} migrate-config`;
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

  const output: Record<string, unknown> = {
    result: 'committed',
    sheet: flags.sheet,
    config: configPath,
    properties_migrated: Object.keys(properties).length,
    commit: commitHash,
  };
  if (warnings.length > 0) output['warnings'] = warnings;
  return renderObject(output);
}
