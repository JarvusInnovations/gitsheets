import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { AxiError } from 'axi-sdk-js';
import { parseToml, stringifyRecord } from 'gitsheets';
import type { RecordLike } from 'gitsheets';

import type { GitsheetsContext } from '../context.js';
import { translateError } from '../errors.js';
import { renderObject } from '../output/render.js';

const exec = promisify(execFile);

export const INFER_HELP = `usage: gitsheets-axi infer <sheet> [--prefix p] [--message m]
flags[2]:
  --prefix <p>         Tenant sub-tree scope
  --message <m>        Commit message (default: "<sheet> infer schema (N fields)")
examples:
  gitsheets-axi infer users
behavior:
  Walks every record in the sheet, observes which fields appear with
  which types, and emits a generated \`[gitsheet.schema]\` block back
  into the sheet's config file. Fields that appear in every record
  are marked \`required\`.
idempotency:
  If the inferred schema matches what's already in the config,
  exits 0 with result: "no-op" — no commit produced.
`;

interface InferFlags {
  sheet: string;
  prefix: string | undefined;
  message: string | undefined;
}

function parseInferFlags(args: string[]): InferFlags {
  const flags: InferFlags = { sheet: '', prefix: undefined, message: undefined };
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    const next = args[i + 1];
    if (arg === '--prefix') {
      if (!next) throw new AxiError('--prefix expects a path', 'VALIDATION_ERROR');
      flags.prefix = next;
      i++;
      continue;
    }
    if (arg === '--message') {
      if (!next) throw new AxiError('--message expects a string', 'VALIDATION_ERROR');
      flags.message = next;
      i++;
      continue;
    }
    if (arg.startsWith('-')) {
      throw new AxiError(`Unknown flag: ${arg}`, 'VALIDATION_ERROR', [
        'Run `gitsheets-axi infer --help`',
      ]);
    }
    positional.push(arg);
  }
  if (positional.length !== 1) {
    throw new AxiError('infer requires <sheet>', 'VALIDATION_ERROR', [
      'Example: gitsheets-axi infer users',
    ]);
  }
  flags.sheet = positional[0]!;
  return flags;
}

interface FieldObservation {
  types: Set<string>;
  items: Set<string>;
  min?: number;
  max?: number;
}

function observeValue(obs: FieldObservation, value: unknown): void {
  if (value === null) {
    obs.types.add('null');
    return;
  }
  if (Array.isArray(value)) {
    obs.types.add('array');
    for (const item of value) obs.items.add(typeOf(item));
    return;
  }
  if (value instanceof Date) {
    obs.types.add('string');
    return;
  }
  const t = typeOf(value);
  obs.types.add(t);
  if (t === 'integer' || t === 'number') {
    const n = value as number;
    if (obs.min === undefined || n < obs.min) obs.min = n;
    if (obs.max === undefined || n > obs.max) obs.max = n;
  }
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (value instanceof Date) return 'string';
  const t = typeof value;
  if (t === 'number') {
    return Number.isInteger(value) ? 'integer' : 'number';
  }
  if (t === 'object') return 'object';
  return t;
}

export async function inferCommand(
  args: string[],
  ctx: GitsheetsContext,
): Promise<string> {
  if (args.length === 0 || (args.length === 1 && args[0] === '--help')) {
    return INFER_HELP;
  }

  const flags = parseInferFlags(args);
  const repo = await ctx.repo();
  const configPath = `.gitsheets/${flags.sheet}.toml`;

  let sheet;
  try {
    sheet = await repo.openSheet(
      flags.sheet,
      flags.prefix !== undefined ? { prefix: flags.prefix } : {},
    );
  } catch (error) {
    throw translateError(error);
  }

  const observed = new Map<string, FieldObservation>();
  const presence = new Map<string, number>();
  let recordCount = 0;
  try {
    for await (const record of sheet.query()) {
      recordCount++;
      for (const [k, v] of Object.entries(record)) {
        presence.set(k, (presence.get(k) ?? 0) + 1);
        let obs = observed.get(k);
        if (!obs) {
          obs = { types: new Set(), items: new Set() };
          observed.set(k, obs);
        }
        observeValue(obs, v);
      }
    }
  } catch (error) {
    throw translateError(error);
  }

  if (recordCount === 0) {
    throw new AxiError(
      `${flags.sheet}: no records to infer from`,
      'NO_RECORDS',
      [`Upsert at least one record first, then re-run \`gitsheets-axi infer ${flags.sheet}\``],
    );
  }

  const properties: Record<string, RecordLike> = {};
  for (const [field, info] of observed.entries()) {
    const types = [...info.types].sort();
    const prop: RecordLike = {};
    prop['type'] = types.length === 1 ? types[0]! : types;
    if (info.items.size > 0) {
      const itemTypes = [...info.items].sort();
      prop['items'] = { type: itemTypes.length === 1 ? itemTypes[0]! : itemTypes };
    }
    if (info.min !== undefined) prop['minimum'] = info.min;
    if (info.max !== undefined) prop['maximum'] = info.max;
    properties[field] = prop;
  }

  const required = [...presence.entries()]
    .filter(([, count]) => count === recordCount)
    .map(([n]) => n)
    .sort();

  // Read existing config, merge schema into it.
  const existingText = await readConfigText(repo.gitDir, configPath);
  if (existingText === null) {
    throw new AxiError(
      `infer: ${configPath} doesn't exist — run \`gitsheets-axi init ${flags.sheet}\` first`,
      'NOT_FOUND',
    );
  }
  const parsed = parseToml(existingText) as RecordLike;
  const gitsheet = (parsed['gitsheet'] ?? {}) as RecordLike;
  const newSchema: RecordLike = { type: 'object', properties };
  if (required.length > 0) newSchema['required'] = required;
  gitsheet['schema'] = newSchema;
  parsed['gitsheet'] = gitsheet;
  const newText = stringifyRecord(parsed);

  if (newText === existingText) {
    return renderObject({
      result: 'no-op',
      sheet: flags.sheet,
      config: configPath,
      properties: Object.keys(properties).length,
      required: required.length,
      records_observed: recordCount,
      reason: 'inferred schema already matches',
    });
  }

  const commitMessage =
    flags.message ?? `${flags.sheet} infer schema (${Object.keys(properties).length} fields)`;
  let commitHash = '';
  try {
    const result = await repo.transact(
      { message: commitMessage },
      async (tx) => {
        tx.writeFile(configPath, newText);
      },
    );
    commitHash = result.commitHash ?? '';
  } catch (error) {
    throw translateError(error);
  }

  return renderObject({
    result: 'committed',
    sheet: flags.sheet,
    config: configPath,
    properties: Object.keys(properties).length,
    required: required.length,
    records_observed: recordCount,
    commit: commitHash,
  });
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
