import { AxiError } from 'axi-sdk-js';
import { Template } from 'gitsheets';

import type { GitsheetsContext } from '../context.js';
import { translateError } from '../errors.js';
import { joinBlocks, renderHelp, renderObject } from '../output/render.js';
import { openSheetForCommand } from '../util/open-sheet.js';
import { MATERIALIZE_HINT } from '../util/hints.js';

export const RENAME_HELP = `usage: gitsheets-axi rename <sheet> <old-path> <new-path> [--prefix p] [--message m]
flags[2]:
  --prefix <p>         Tenant sub-tree scope
  --message <m>        Commit message (default: "<sheet> rename <old> -> <new>")
examples:
  gitsheets-axi rename teams kevin-clough kingofthepark
  gitsheets-axi rename repos old-name new-name --message "slug rename"
note:
  Reads the record at <old-path>, re-keys it to <new-path>, and deletes the old
  one — atomically in ONE commit. Supported for a bare single-field path
  template; for decorated or multi-field templates, use \`patch\` to change the
  path fields, or \`upsert --delete-missing\`.
`;

interface RenameFlags {
  sheet: string;
  oldPath: string;
  newPath: string;
  prefix: string | undefined;
  message: string | undefined;
}

function parseRenameFlags(args: string[]): RenameFlags {
  const flags: RenameFlags = { sheet: '', oldPath: '', newPath: '', prefix: undefined, message: undefined };
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    const next = args[i + 1];
    switch (arg) {
      case '--prefix':
        if (!next) throw new AxiError('--prefix expects a path', 'VALIDATION_ERROR');
        flags.prefix = next;
        i++;
        break;
      case '--message':
        if (!next) throw new AxiError('--message expects a string', 'VALIDATION_ERROR');
        flags.message = next;
        i++;
        break;
      default:
        if (arg.startsWith('-')) {
          throw new AxiError(`Unknown flag: ${arg}`, 'VALIDATION_ERROR', [
            'Run `gitsheets-axi rename --help`',
          ]);
        }
        positional.push(arg);
    }
  }
  if (positional.length !== 3) {
    throw new AxiError('rename requires <sheet> <old-path> <new-path>', 'VALIDATION_ERROR', [
      'Example: gitsheets-axi rename teams kevin-clough kingofthepark',
    ]);
  }
  flags.sheet = positional[0]!;
  flags.oldPath = stripExtension(positional[1]!);
  flags.newPath = stripExtension(positional[2]!);
  return flags;
}

// A bare single-field template: the whole path is one field reference
// (`${{ field }}` or `${ field }`) with no literal decoration, so <new-path>
// maps directly onto the field's value.
const BARE_TEMPLATE = /^\$\{\{?\s*[A-Za-z_$][\w$]*\s*\}?\}$/;

export async function renameCommand(
  args: string[],
  ctx: GitsheetsContext,
): Promise<string> {
  if (args.length === 0 || (args.length === 1 && args[0] === '--help')) {
    return RENAME_HELP;
  }

  const flags = parseRenameFlags(args);
  const prefixOpts = flags.prefix !== undefined ? { prefix: flags.prefix } : {};

  const repo = await ctx.repo();
  const sheet = await openSheetForCommand(repo, flags.sheet, prefixOpts);
  const config = await sheet.readConfig();
  const template = Template.fromString(config.path);
  const fields = template.getFieldNames();

  if (fields.length !== 1 || template.componentCount !== 1 || !BARE_TEMPLATE.test(config.path.trim())) {
    throw new AxiError(
      `rename supports a bare single-field path template; '${config.path}' is not one`,
      'VALIDATION_ERROR',
      ['Use `patch` to change the path fields, or `upsert --delete-missing` to re-key.'],
    );
  }
  const field = fields[0]!;

  let existing;
  try {
    existing = await sheet.queryFirst({ [field]: flags.oldPath });
  } catch (error) {
    throw translateError(error);
  }
  if (!existing) {
    throw new AxiError(`${flags.sheet}: no record at ${flags.oldPath}`, 'NOT_FOUND');
  }

  const collision = await sheet.queryFirst({ [field]: flags.newPath });
  if (collision) {
    throw new AxiError(`${flags.sheet}: ${flags.newPath} already exists — refusing to overwrite`, 'VALIDATION_ERROR', [
      `Delete or rename the existing ${flags.newPath} first`,
    ]);
  }

  const renamed = { ...stripSymbols(existing), [field]: flags.newPath };
  const commitMessage = flags.message ?? `${flags.sheet} rename ${flags.oldPath} -> ${flags.newPath}`;
  try {
    const result = await repo.transact({ message: commitMessage }, async (tx) => {
      const txSheet = tx.sheet(flags.sheet, prefixOpts);
      await txSheet.upsert(renamed as never);
      await txSheet.delete(flags.oldPath);
    });
    return joinBlocks(
      renderObject({
        result: 'renamed',
        sheet: flags.sheet,
        from: flags.oldPath,
        to: flags.newPath,
        commit: result.commitHash,
      }),
      renderHelp([MATERIALIZE_HINT]),
    );
  } catch (error) {
    throw translateError(error);
  }
}

function stripSymbols(record: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (record && typeof record === 'object') {
    for (const key of Object.keys(record as Record<string, unknown>)) {
      out[key] = (record as Record<string, unknown>)[key];
    }
  }
  return out;
}

function stripExtension(path: string): string {
  if (path.endsWith('.toml')) return path.slice(0, -5);
  if (path.endsWith('.md')) return path.slice(0, -3);
  return path;
}
