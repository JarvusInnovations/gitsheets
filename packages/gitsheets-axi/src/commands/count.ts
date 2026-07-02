import { AxiError } from 'axi-sdk-js';

import type { GitsheetsContext } from '../context.js';
import { translateError } from '../errors.js';
import { renderObject } from '../output/render.js';
import { openSheetForCommand } from '../util/open-sheet.js';
import { buildPredicate } from '../util/filter.js';

export const COUNT_HELP = `usage: gitsheets-axi count <sheet> [--filter k=v ...] [--prefix p]
flags[2]:
  --filter <expr>      Filter clause (repeatable). k=v · k!=v · k<v · k>v ·
                       k<=v · k>=v · k~regex · "k in (a,b)" · k:present · k:empty
  --prefix <p>         Tenant sub-tree scope
examples:
  gitsheets-axi count repos
  gitsheets-axi count repos --filter status=unclassified
  gitsheets-axi count repos --filter 'pushed_at<2022-01-01' --filter archived=false
note:
  With no --filter, counts candidate record paths without parsing (cheap).
  A filter scans body-less records and counts matches.
`;

interface CountFlags {
  sheet: string;
  filters: string[];
  prefix: string | undefined;
}

function parseCountFlags(args: string[]): CountFlags {
  const sheet = args[0];
  if (!sheet || sheet.startsWith('-')) {
    throw new AxiError('count requires a sheet name', 'VALIDATION_ERROR', [
      'Run `gitsheets-axi count <sheet>`',
    ]);
  }
  const flags: CountFlags = { sheet, filters: [], prefix: undefined };
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case '--filter':
        if (!next) throw new AxiError('--filter expects an expression', 'VALIDATION_ERROR');
        flags.filters.push(next);
        i++;
        break;
      case '--prefix':
        if (!next) throw new AxiError('--prefix expects a path', 'VALIDATION_ERROR');
        flags.prefix = next;
        i++;
        break;
      default:
        throw new AxiError(`Unknown flag: ${arg}`, 'VALIDATION_ERROR', [
          'Run `gitsheets-axi count --help`',
        ]);
    }
  }
  return flags;
}

export async function countCommand(
  args: string[],
  ctx: GitsheetsContext,
): Promise<string> {
  if (args.length === 0 || (args.length === 1 && args[0] === '--help')) {
    return COUNT_HELP;
  }

  const flags = parseCountFlags(args);
  const repo = await ctx.repo();
  const sheet = await openSheetForCommand(
    repo,
    flags.sheet,
    flags.prefix !== undefined ? { prefix: flags.prefix } : {},
  );

  // No filter → the cheap candidate-path count.
  if (flags.filters.length === 0) {
    try {
      return renderObject({ sheet: flags.sheet, count: await sheet.count() });
    } catch (error) {
      throw translateError(error);
    }
  }

  // Filtered → scan body-less and count matches, reporting the total too.
  const predicate = buildPredicate(flags.filters);
  let matched = 0;
  let total = 0;
  try {
    const records = await sheet.queryAll({}, { withBody: false });
    total = records.length;
    for (const r of records) {
      if (predicate(r as Record<string, unknown>)) matched++;
    }
  } catch (error) {
    throw translateError(error);
  }
  return renderObject({ sheet: flags.sheet, count: matched, of: total });
}
