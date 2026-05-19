import { isAbsolute, join, relative } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';

import { AxiError } from 'axi-sdk-js';
import { ConfigError, getFormat, NotFoundError, validateRecord } from 'gitsheets';

import type { GitsheetsContext } from '../context.js';
import { translateError } from '../errors.js';
import { renderObject } from '../output/render.js';

export const CHECK_HELP = `usage: gitsheets-axi check <sheet> <file> [--fix] [--prefix p]
flags[2]:
  --fix                Rewrite the file in canonical form if not already canonical
  --prefix <p>         Tenant sub-tree scope
examples:
  gitsheets-axi check users users/jane.toml
  gitsheets-axi check users users/jane.toml --fix
exit codes:
  0   File is canonical (or rewritten if --fix)
  1   File is not canonical and --fix was not passed
  22  ValidationError — record fails the sheet's JSON Schema
  64  ConfigError — file failed to parse as the sheet's format
behavior:
  Reads from the working tree (not git). Never commits. Designed as a
  post-edit hook for agents that wrote a record directly: run with --fix
  to land in canonical form; run without to verify pre-commit.
`;

interface CheckFlags {
  sheet: string;
  file: string;
  fix: boolean;
  prefix: string | undefined;
}

function parseCheckFlags(args: string[]): CheckFlags {
  const flags: CheckFlags = {
    sheet: '',
    file: '',
    fix: false,
    prefix: undefined,
  };
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    const next = args[i + 1];
    if (arg === '--fix') {
      flags.fix = true;
      continue;
    }
    if (arg === '--prefix') {
      if (!next) throw new AxiError('--prefix expects a path', 'VALIDATION_ERROR');
      flags.prefix = next;
      i++;
      continue;
    }
    if (arg.startsWith('-')) {
      throw new AxiError(`Unknown flag: ${arg}`, 'VALIDATION_ERROR', [
        'Run `gitsheets-axi check --help`',
      ]);
    }
    positional.push(arg);
  }
  if (positional.length !== 2) {
    throw new AxiError('check requires <sheet> <file>', 'VALIDATION_ERROR', [
      'Example: gitsheets-axi check users users/jane.toml',
    ]);
  }
  flags.sheet = positional[0]!;
  flags.file = positional[1]!;
  return flags;
}

export async function checkCommand(
  args: string[],
  ctx: GitsheetsContext,
): Promise<string> {
  if (args.length === 0 || (args.length === 1 && args[0] === '--help')) {
    return CHECK_HELP;
  }

  const flags = parseCheckFlags(args);
  const repo = await ctx.repo();

  let sheet;
  try {
    sheet = await repo.openSheet(
      flags.sheet,
      flags.prefix !== undefined ? { prefix: flags.prefix } : {},
    );
  } catch (error) {
    throw translateError(error);
  }

  const config = await sheet.readConfig();
  const format = getFormat(config.format.type);

  const absPath = isAbsolute(flags.file)
    ? flags.file
    : join(process.cwd(), flags.file);

  let original: string;
  try {
    original = await readFile(absPath, 'utf-8');
  } catch (err) {
    throw translateError(
      new NotFoundError(
        'record_not_found',
        `check: cannot read ${flags.file}: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
  }

  // Parse via the sheet's format. Failure → ConfigError → exit 64.
  let record;
  try {
    record = format.parse(original, config.format);
  } catch (err) {
    throw translateError(
      new ConfigError(
        'config_invalid',
        `check: failed to parse ${flags.file} as ${config.format.type}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      ),
    );
  }

  // Validate against the sheet's schema → ValidationError → exit 22.
  let validated;
  try {
    validated = await validateRecord({
      record: { ...record },
      schema: config.schema,
      schemaSourcePath: `.gitsheets/${flags.sheet}.toml`,
    });
  } catch (err) {
    throw translateError(err);
  }

  const normalized = await sheet.normalizeRecord(validated as never);
  const newText = await format.serialize(
    { ...(normalized as Record<string, unknown>) },
    config.format,
  );

  const relPath = relative(process.cwd(), absPath) || flags.file;

  if (newText === original) {
    return renderObject({
      result: 'ok',
      file: relPath,
      canonical: true,
    });
  }

  if (flags.fix) {
    try {
      await writeFile(absPath, newText, 'utf-8');
    } catch (err) {
      throw new AxiError(
        `check: could not write ${flags.file}: ${err instanceof Error ? err.message : String(err)}`,
        'WRITE_ERROR',
      );
    }
    return renderObject({
      result: 'fixed',
      file: relPath,
      canonical: true,
      bytes_changed: original.length !== newText.length || original !== newText,
    });
  }

  // Not canonical, --fix not passed. AXI behavior: error on stdout, exit 1.
  throw new AxiError(
    `${flags.file} is not in canonical form`,
    'NOT_CANONICAL',
    [`Re-run with \`--fix\` to rewrite ${flags.file}`],
  );
}
