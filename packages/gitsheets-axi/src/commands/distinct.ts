import { AxiError } from 'axi-sdk-js';

import type { GitsheetsContext } from '../context.js';
import { translateError } from '../errors.js';
import { renderListResponse } from '../output/render.js';
import { field } from '../output/schema.js';
import { openSheetForCommand } from '../util/open-sheet.js';
import { buildPredicate } from '../util/filter.js';
import { facetCounts } from '../util/aggregate.js';

export const DISTINCT_HELP = `usage: gitsheets-axi distinct <sheet> <field> [--filter expr ...] [--prefix p]
flags[2]:
  --filter <expr>      Filter clause (repeatable), same DSL as query
  --prefix <p>         Tenant sub-tree scope
examples:
  gitsheets-axi distinct repos target_team
  gitsheets-axi distinct repos disposition --filter status=classified
note:
  Lists each unique value of <field> (with its count), sorted alphabetically.
  Use \`query --group-by <field>\` for the same facets ordered by count.
`;

interface DistinctFlags {
  sheet: string;
  field: string;
  filters: string[];
  prefix: string | undefined;
}

function parseDistinctFlags(args: string[]): DistinctFlags {
  const positional: string[] = [];
  const flags: DistinctFlags = { sheet: '', field: '', filters: [], prefix: undefined };
  for (let i = 0; i < args.length; i++) {
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
        if (arg!.startsWith('-')) {
          throw new AxiError(`Unknown flag: ${arg}`, 'VALIDATION_ERROR', [
            'Run `gitsheets-axi distinct --help`',
          ]);
        }
        positional.push(arg!);
    }
  }
  if (positional.length !== 2) {
    throw new AxiError('distinct requires <sheet> <field>', 'VALIDATION_ERROR', [
      'Example: gitsheets-axi distinct repos target_team',
    ]);
  }
  flags.sheet = positional[0]!;
  flags.field = positional[1]!;
  return flags;
}

export async function distinctCommand(
  args: string[],
  ctx: GitsheetsContext,
): Promise<string> {
  if (args.length === 0 || (args.length === 1 && args[0] === '--help')) {
    return DISTINCT_HELP;
  }

  const flags = parseDistinctFlags(args);
  const repo = await ctx.repo();
  const sheet = await openSheetForCommand(
    repo,
    flags.sheet,
    flags.prefix !== undefined ? { prefix: flags.prefix } : {},
  );

  let records;
  try {
    records = await sheet.queryAll({}, { withBody: false });
  } catch (error) {
    throw translateError(error);
  }

  const predicate = buildPredicate(flags.filters);
  const matched = (records as Array<Record<string, unknown>>).filter(predicate);
  const facets = facetCounts(matched, flags.field).sort((a, b) =>
    a.value < b.value ? -1 : a.value > b.value ? 1 : 0,
  );

  return renderListResponse({
    summary: { distinct: `${facets.length} values of ${flags.field}` },
    name: 'values',
    items: facets as unknown as Array<Record<string, unknown>>,
    schema: [field('value'), field('count')],
    emptyMessage: `no records in ${flags.sheet}`,
  });
}
