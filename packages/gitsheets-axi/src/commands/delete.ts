import { AxiError } from 'axi-sdk-js';
import { NotFoundError, RECORD_PATH_KEY, type Repository, type Sheet } from 'gitsheets';

import type { GitsheetsContext } from '../context.js';
import { translateError } from '../errors.js';
import { joinBlocks, renderHelp, renderObject } from '../output/render.js';
import { openSheetForCommand } from '../util/open-sheet.js';
import { buildPredicate } from '../util/filter.js';
import { readStdin } from '../util/stdin.js';
import { MATERIALIZE_HINT } from '../util/hints.js';

export const DELETE_HELP = `usage: gitsheets-axi delete <sheet> <path> [--prefix p] [--message m]
       gitsheets-axi delete <sheet> --filter expr ... [--dry-run]   # bulk by query
       gitsheets-axi delete <sheet> --stdin [--dry-run]             # bulk by id/path list
flags[5]:
  --filter <expr>      Bulk: delete every record matching the filter DSL (repeatable)
  --stdin              Bulk: delete records named one-per-line on stdin
  --dry-run            Bulk: report how many would be deleted — no commit
  --prefix <p>         Tenant sub-tree scope
  --message <m>        Commit message (default: "<sheet> delete <path>")
examples:
  gitsheets-axi delete users jane
  gitsheets-axi delete repos --filter disposition=delete-candidate --dry-run
  gitsheets-axi delete repos --filter disposition=delete-candidate
  cat paths.txt | gitsheets-axi delete repos --stdin
idempotency:
  Already-missing records exit 0 with result: "no-op" — no commit, no error.
  Bulk delete removes every matching record in ONE commit.
`;

interface DeleteFlags {
  sheet: string;
  path: string | undefined;
  filters: string[];
  stdin: boolean;
  dryRun: boolean;
  prefix: string | undefined;
  message: string | undefined;
}

function parseDeleteFlags(args: string[]): DeleteFlags {
  const flags: DeleteFlags = {
    sheet: '',
    path: undefined,
    filters: [],
    stdin: false,
    dryRun: false,
    prefix: undefined,
    message: undefined,
  };
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    const next = args[i + 1];
    switch (arg) {
      case '--filter':
        if (!next) throw new AxiError('--filter expects an expression', 'VALIDATION_ERROR');
        flags.filters.push(next);
        i++;
        break;
      case '--stdin':
        flags.stdin = true;
        break;
      case '--dry-run':
        flags.dryRun = true;
        break;
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
            'Run `gitsheets-axi delete --help`',
          ]);
        }
        positional.push(arg);
    }
  }
  flags.sheet = positional[0] ?? '';
  flags.path = positional[1];

  const bulk = flags.filters.length > 0 || flags.stdin;
  if (!flags.sheet) {
    throw new AxiError('delete requires <sheet>', 'VALIDATION_ERROR', [
      'Example: gitsheets-axi delete users jane',
    ]);
  }
  if (flags.filters.length > 0 && flags.stdin) {
    throw new AxiError('Use either --filter or --stdin, not both', 'VALIDATION_ERROR');
  }
  if (bulk && flags.path !== undefined) {
    throw new AxiError('Drop the <path> positional in bulk mode (--filter / --stdin)', 'VALIDATION_ERROR');
  }
  if (!bulk && flags.path === undefined) {
    throw new AxiError('delete requires <sheet> <path> (or --filter / --stdin for bulk)', 'VALIDATION_ERROR', [
      'Example: gitsheets-axi delete users jane',
    ]);
  }
  return flags;
}

export async function deleteCommand(
  args: string[],
  ctx: GitsheetsContext,
): Promise<string> {
  if (args.length === 0 || (args.length === 1 && args[0] === '--help')) {
    return DELETE_HELP;
  }

  const flags = parseDeleteFlags(args);
  const prefixOpts = flags.prefix !== undefined ? { prefix: flags.prefix } : {};

  const repo = await ctx.repo();
  const sheet = await openSheetForCommand(repo, flags.sheet, prefixOpts);

  if (flags.filters.length > 0 || flags.stdin) {
    return bulkDelete(repo, sheet, flags, prefixOpts);
  }
  return singleDelete(repo, sheet, flags, prefixOpts);
}

async function singleDelete(
  repo: Repository,
  sheet: Sheet,
  flags: DeleteFlags,
  prefixOpts: { prefix?: string },
): Promise<string> {
  const target = stripExtension(flags.path!);

  let exists = false;
  try {
    for await (const record of sheet.query()) {
      const pathSym = (record as Record<symbol, unknown>)[RECORD_PATH_KEY];
      if (pathSym === target) {
        exists = true;
        break;
      }
    }
  } catch (error) {
    throw translateError(error);
  }

  if (!exists) {
    return renderObject({
      result: 'no-op',
      sheet: flags.sheet,
      path: target,
      reason: 'record already absent',
    });
  }

  const commitMessage = flags.message ?? `${flags.sheet} delete ${target}`;
  try {
    const result = await repo.transact({ message: commitMessage }, async (tx) => {
      const txSheet = tx.sheet(flags.sheet, prefixOpts);
      await txSheet.delete(target);
    });
    return renderObject({
      result: 'committed',
      sheet: flags.sheet,
      path: target,
      commit: result.commitHash,
    });
  } catch (error) {
    if (error instanceof NotFoundError) {
      return renderObject({
        result: 'no-op',
        sheet: flags.sheet,
        path: target,
        reason: 'record vanished between check and delete',
      });
    }
    throw translateError(error);
  }
}

async function bulkDelete(
  repo: Repository,
  sheet: Sheet,
  flags: DeleteFlags,
  prefixOpts: { prefix?: string },
): Promise<string> {
  // Resolve the delete set against records that actually exist, so the result
  // is idempotent (absent ids are skipped, not errors).
  const existing = await sheet.queryAll({}, { withBody: false });
  const existingPaths = new Set<string>();
  for (const r of existing) {
    const p = (r as Record<symbol, unknown>)[RECORD_PATH_KEY];
    if (typeof p === 'string') existingPaths.add(p);
  }

  let targets: string[];
  if (flags.stdin) {
    const raw = await readStdin();
    const requested = raw
      .split('\n')
      .map((s) => stripExtension(s.trim()))
      .filter((s) => s.length > 0);
    targets = requested.filter((p) => existingPaths.has(p));
  } else {
    const predicate = buildPredicate(flags.filters);
    targets = (existing as Array<Record<string, unknown>>)
      .filter(predicate)
      .map((r) => (r as Record<symbol, unknown>)[RECORD_PATH_KEY])
      .filter((p): p is string => typeof p === 'string');
  }

  if (flags.dryRun) {
    return renderObject({
      result: 'dry-run',
      sheet: flags.sheet,
      willDelete: targets.length,
      of: existingPaths.size,
    });
  }

  if (targets.length === 0) {
    return renderObject({ result: 'no-op', sheet: flags.sheet, deleted: 0 });
  }

  const commitMessage = flags.message ?? `${flags.sheet} delete (${targets.length})`;
  try {
    const result = await repo.transact({ message: commitMessage }, async (tx) => {
      const txSheet = tx.sheet(flags.sheet, prefixOpts);
      for (const path of targets) await txSheet.delete(path);
    });
    return joinBlocks(
      renderObject({
        result: 'committed',
        sheet: flags.sheet,
        deleted: targets.length,
        commit: result.commitHash,
      }),
      renderHelp([MATERIALIZE_HINT]),
    );
  } catch (error) {
    throw translateError(error);
  }
}

function stripExtension(path: string): string {
  if (path.endsWith('.toml')) return path.slice(0, -5);
  if (path.endsWith('.md')) return path.slice(0, -3);
  return path;
}
