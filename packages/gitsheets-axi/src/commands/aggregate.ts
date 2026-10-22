import { AxiError } from 'axi-sdk-js';
import type { AggregateSpec, Sheet } from 'gitsheets';

import type { GitsheetsContext } from '../context.js';
import { translateError } from '../errors.js';
import { renderObject } from '../output/render.js';
import { openSheetForCommand } from '../util/open-sheet.js';
import { predicateFilter } from '../util/filter.js';

export const AGGREGATE_HELP = `usage: gitsheets-axi aggregate <sheet> --agg <name>=<form>[:<field>] ... [--group-by f] [--filter expr ...] [--prefix p]
flags[4]:
  --agg <spec>         Aggregate (repeatable, at least one): <name>=count, or
                       <name>=sum|min|max|avg|distinct:<field>
  --group-by <field>   Apply groupBy to every aggregate (each result becomes
                       a table keyed by the field's string form)
  --filter <expr>      Filter clause (repeatable), same DSL as query
  --prefix <p>         Tenant sub-tree scope
examples:
  gitsheets-axi aggregate repos --agg n=count --group-by target_team
  gitsheets-axi aggregate tx --agg total=sum:amountCents --agg mean=avg:amountCents
  gitsheets-axi aggregate repos --agg teams=distinct:target_team --filter archived=false
note:
  Computed in the gitsheets core over the filtered records, body-less, in
  canonical path order. An aggregate with nothing to fold is omitted, except
  count and sum (0). Records lacking a string/integer/boolean --group-by
  value do not contribute. reduce is library-only (Sheet.aggregate).
`;

const FIELD_FORMS = new Set(['sum', 'min', 'max', 'avg', 'distinct']);

/** Parse one `--agg <name>=<form>[:<field>]` clause. */
export function parseAggSpec(item: string): [string, AggregateSpec] {
  const eq = item.indexOf('=');
  const name = eq > 0 ? item.slice(0, eq) : '';
  const rhs = eq > 0 ? item.slice(eq + 1) : '';
  const colon = rhs.indexOf(':');
  const form = colon === -1 ? rhs : rhs.slice(0, colon);
  const field = colon === -1 ? undefined : rhs.slice(colon + 1);
  const hint = ['Forms: <name>=count · <name>=sum|min|max|avg|distinct:<field>'];
  if (!name) throw new AxiError(`--agg expects <name>=<form>[:<field>], got "${item}"`, 'VALIDATION_ERROR', hint);
  if (form === 'count' && field === undefined) return [name, { count: true }];
  if (FIELD_FORMS.has(form) && field) return [name, { [form]: field } as unknown as AggregateSpec];
  throw new AxiError(`Could not parse --agg "${item}"`, 'VALIDATION_ERROR', hint);
}

interface AggregateFlags {
  sheet: string;
  aggs: Array<[string, AggregateSpec]>;
  groupBy: string | undefined;
  filters: string[];
  prefix: string | undefined;
}

function parseAggregateFlags(args: string[]): AggregateFlags {
  const sheet = args[0];
  if (!sheet || sheet.startsWith('-')) {
    throw new AxiError('aggregate requires a sheet name', 'VALIDATION_ERROR', [
      'Run `gitsheets-axi aggregate <sheet> --agg n=count`',
    ]);
  }
  const flags: AggregateFlags = { sheet, aggs: [], groupBy: undefined, filters: [], prefix: undefined };
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case '--agg':
        if (!next) throw new AxiError('--agg expects <name>=<form>[:<field>]', 'VALIDATION_ERROR');
        flags.aggs.push(parseAggSpec(next));
        i++;
        break;
      case '--group-by':
        if (!next) throw new AxiError('--group-by expects a field name', 'VALIDATION_ERROR');
        flags.groupBy = next;
        i++;
        break;
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
          'Run `gitsheets-axi aggregate --help`',
        ]);
    }
  }
  if (flags.aggs.length === 0) {
    throw new AxiError('aggregate requires at least one --agg', 'VALIDATION_ERROR', [
      'Example: gitsheets-axi aggregate repos --agg n=count --group-by target_team',
    ]);
  }
  return flags;
}

/**
 * Run `Sheet.aggregate` with the axi filter DSL, translating a malformed-spec
 * `TypeError` to `VALIDATION_ERROR` and library errors through
 * {@link translateError}.
 */
export async function runAggregate(
  sheet: Sheet,
  filters: string[],
  aggregates: Record<string, AggregateSpec>,
): Promise<Record<string, unknown>> {
  const filter = predicateFilter(filters);
  try {
    return await sheet.aggregate(filter, aggregates);
  } catch (error) {
    if (error instanceof TypeError) throw new AxiError(error.message, 'VALIDATION_ERROR', []);
    throw translateError(error);
  }
}

export async function aggregateCommand(args: string[], ctx: GitsheetsContext): Promise<string> {
  if (args.length === 0 || (args.length === 1 && args[0] === '--help')) {
    return AGGREGATE_HELP;
  }
  const flags = parseAggregateFlags(args);
  const aggregates: Record<string, AggregateSpec> = {};
  for (const [name, spec] of flags.aggs) {
    if (name in aggregates) throw new AxiError(`--agg ${name} given twice`, 'VALIDATION_ERROR');
    aggregates[name] = flags.groupBy !== undefined ? { ...spec, groupBy: flags.groupBy } : spec;
  }
  const repo = await ctx.repo();
  const sheet = await openSheetForCommand(
    repo,
    flags.sheet,
    flags.prefix !== undefined ? { prefix: flags.prefix } : {},
  );
  const results = await runAggregate(sheet, flags.filters, aggregates);
  return renderObject({ sheet: flags.sheet, results });
}
